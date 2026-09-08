/**
 * Unit tests for deposit-side KYT screening.
 *
 * Two things here are worth pinning. The first is that a refusal and a broken
 * relayer produce different errors: one is final and the other is worth
 * retrying, and a client that conflates them either retries into a wall or
 * gives up on a transient outage.
 *
 * The second is the ed25519 instruction layout. The program re-parses that blob
 * by hand and refuses anything whose offsets point outside it, so this asserts
 * the exact bytes rather than trusting that web3.js and the Rust parser happen
 * to agree.
 */

import './setup';
import { expect } from 'chai';
import { Ed25519Program, Keypair, type Connection } from '@solana/web3.js';

import {
    ATTESTATION_BYTES,
    KytRefusedError,
    KytService,
    KytUnavailableError,
    fundersAgree,
    resolveBurnerFunders,
    toInstruction,
    type KytAttestation,
} from '../src/lib/KytService';

const BASE = 'http://relayer.test';

const AUTHORITY = Keypair.generate().publicKey;
const FUNDER = Keypair.generate().publicKey;
const OTHER_FUNDER = Keypair.generate().publicKey;
const BURNER = Keypair.generate().publicKey;

/** A well-formed response body. `verdict` and overrides are per-test. */
function attestation(overrides: Partial<KytAttestation> = {}): KytAttestation {
    return {
        verdict: 1,
        authority: AUTHORITY.toBase58(),
        message: Buffer.alloc(ATTESTATION_BYTES, 7).toString('base64'),
        signature: Buffer.alloc(64, 9).toString('base64'),
        expiresAt: 1_800_000_000,
        funders: [FUNDER.toBase58()],
        ...overrides,
    };
}

/** Stub global fetch with one canned response. */
function stubFetch(response: { ok: boolean; body?: unknown }): () => void {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
        ({
            ok: response.ok,
            status: response.ok ? 200 : 503,
            statusText: response.ok ? 'OK' : 'Service Unavailable',
            json: async () => response.body,
        }) as Response) as typeof fetch;
    return () => {
        globalThis.fetch = original;
    };
}

describe('KytService', () => {
    it('binds the burner and the amount into the request', async () => {
        const original = globalThis.fetch;
        let body: Record<string, unknown> = {};

        globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
            body = JSON.parse(String(init?.body));
            return {
                ok: true,
                json: async () => attestation(),
            } as Response;
        }) as typeof fetch;

        try {
            await new KytService(BASE).screen(BURNER, 5_000_000_000n);
        } finally {
            globalThis.fetch = original;
        }

        // An attestation that said only "this wallet is clean" would be a bearer
        // token good for every deposit that wallet ever makes.
        expect(body.burner).to.equal(BURNER.toBase58());
        expect(body.maxAmount).to.equal('5000000000');

        // And the client does not get to nominate who is screened. Whatever it
        // claimed would be an assertion by the party asking to be cleared, so
        // the relayer resolves it instead and the request carries nothing.
        expect(body).to.not.have.property('funders');
        expect(body).to.not.have.property('depositor');
    });

    it('throws a distinct, final error when a funder is refused', async () => {
        const restore = stubFetch({
            ok: true,
            body: attestation({ verdict: 0, reason: 'sanctioned counterparty' }),
        });

        try {
            await new KytService(BASE).attest(BURNER, 1n);
            expect.fail('a refusal must throw');
        } catch (err) {
            expect(err).to.be.instanceOf(KytRefusedError);
            expect((err as KytRefusedError).message).to.equal('sanctioned counterparty');
        } finally {
            restore();
        }
    });

    it('reports an unreachable or incoherent relayer separately from a refusal', async () => {
        const cases: Array<{ ok: boolean; body?: unknown }> = [
            { ok: false },
            { ok: true, body: { verdict: 1 } },
            { ok: true, body: attestation({ authority: 'not-a-pubkey' }) },
            // Right shape, wrong length: a corrupt allow, not a refusal.
            {
                ok: true,
                body: attestation({
                    message: Buffer.alloc(ATTESTATION_BYTES - 1).toString('base64'),
                }),
            },
            { ok: true, body: attestation({ signature: Buffer.alloc(63).toString('base64') }) },
            // No resolution means nothing to compare against and no evidence the
            // relayer screened anything.
            { ok: true, body: attestation({ funders: undefined as unknown as string[] }) },
            { ok: true, body: attestation({ funders: [7] as unknown as string[] }) },
        ];

        for (const response of cases) {
            const restore = stubFetch(response);
            try {
                await new KytService(BASE).screen(BURNER, 1n);
                expect.fail(`expected a failure for ${JSON.stringify(response)}`);
            } catch (err) {
                expect(err, JSON.stringify(response)).to.be.instanceOf(KytUnavailableError);
            } finally {
                restore();
            }
        }
    });

    it('fails loudly when no screening endpoint is configured', async () => {
        try {
            await new KytService('').screen(BURNER, 1n);
            expect.fail('an unconfigured endpoint must throw');
        } catch (err) {
            expect(err).to.be.instanceOf(KytUnavailableError);
        }
    });
});

describe('KYT attestation instruction', () => {
    it('lays the blob out the way the program parses it', () => {
        const message = Buffer.alloc(ATTESTATION_BYTES, 7);
        const signature = Buffer.alloc(64, 9);
        const ix = toInstruction(
            attestation({
                message: message.toString('base64'),
                signature: signature.toString('base64'),
            }),
        );

        expect(ix.programId.equals(Ed25519Program.programId)).to.equal(true);

        const data = Buffer.from(ix.data);
        expect(data[0], 'exactly one signature — the program refuses more').to.equal(1);

        // Offsets table: seven u16 LE fields after the count and its padding.
        const field = (i: number) => data.readUInt16LE(2 + i * 2);
        const [signatureOffset, signatureIx, pubkeyOffset, pubkeyIx, messageOffset, messageSize, messageIx] =
            [0, 1, 2, 3, 4, 5, 6].map(field);

        expect(pubkeyOffset).to.equal(16);
        expect(signatureOffset).to.equal(48);
        expect(messageOffset).to.equal(112);
        expect(messageSize).to.equal(ATTESTATION_BYTES);

        // The one that matters. Any other index means the precompile verified
        // bytes from a different instruction, and the message sitting in this
        // blob was never signed by anyone.
        expect([signatureIx, pubkeyIx, messageIx]).to.deep.equal([0xffff, 0xffff, 0xffff]);

        expect(data.subarray(16, 48).equals(Buffer.from(AUTHORITY.toBytes()))).to.equal(true);
        expect(data.subarray(48, 112).equals(signature)).to.equal(true);
        expect(data.subarray(112).equals(message)).to.equal(true);
    });
});

describe('resolveBurnerFunders', () => {
    /** A parsed transaction carrying `transfers` as top-level system transfers. */
    function transferTx(
        transfers: Array<{ source: string; destination: string; lamports: number }>,
        err: unknown = null,
    ) {
        return {
            meta: { err, innerInstructions: [] },
            transaction: {
                message: {
                    instructions: transfers.map((info) => ({
                        program: 'system',
                        parsed: { type: 'transfer', info },
                    })),
                },
            },
        };
    }

    function stubConnection(transactions: Record<string, unknown>): Connection {
        return {
            getSignaturesForAddress: async () =>
                Object.keys(transactions).map((signature) => ({ signature })),
            getParsedTransaction: async (signature: string) =>
                transactions[signature] ?? null,
        } as unknown as Connection;
    }

    const burner = BURNER.toBase58();

    it('reads the funder off the chain rather than trusting the caller', async () => {
        const funders = await resolveBurnerFunders(
            stubConnection({
                sig1: transferTx([
                    { source: FUNDER.toBase58(), destination: burner, lamports: 5_000_000 },
                ]),
            }),
            BURNER,
        );

        expect(funders.map((f) => f.toBase58())).to.deep.equal([FUNDER.toBase58()]);
    });

    /** `funders[0]` is the address bound into the attestation, so the ordering
     *  is part of the contract and not a convenience. */
    it('orders funders by total contributed, largest first', async () => {
        const funders = await resolveBurnerFunders(
            stubConnection({
                sig1: transferTx([
                    { source: FUNDER.toBase58(), destination: burner, lamports: 1_000 },
                ]),
                sig2: transferTx([
                    { source: OTHER_FUNDER.toBase58(), destination: burner, lamports: 9_000 },
                ]),
                // Same source paying twice is one funder with a total, which is
                // what puts FUNDER back in front.
                sig3: transferTx([
                    { source: FUNDER.toBase58(), destination: burner, lamports: 50_000 },
                ]),
            }),
            BURNER,
        );

        expect(funders.map((f) => f.toBase58())).to.deep.equal([
            FUNDER.toBase58(),
            OTHER_FUNDER.toBase58(),
        ]);
    });

    it('ignores failed transactions and transfers aimed elsewhere', async () => {
        const funders = await resolveBurnerFunders(
            stubConnection({
                sig1: transferTx(
                    [{ source: OTHER_FUNDER.toBase58(), destination: burner, lamports: 9_000 }],
                    { InstructionError: [0, 'Custom'] },
                ),
                sig2: transferTx([
                    { source: OTHER_FUNDER.toBase58(), destination: AUTHORITY.toBase58(), lamports: 9_000 },
                    { source: FUNDER.toBase58(), destination: burner, lamports: 1_000 },
                ]),
            }),
            BURNER,
        );

        expect(funders.map((f) => f.toBase58())).to.deep.equal([FUNDER.toBase58()]);
    });

    /** Unavailable, never a refusal: an unconfirmed funding transfer is a state
     *  that resolves itself, and falling back to the connected wallet would
     *  attest to the provenance of the wrong party. */
    it('reports unavailable rather than guessing when nothing is attributable', async () => {
        for (const transactions of [{}, { sig1: transferTx([]) }]) {
            try {
                await resolveBurnerFunders(stubConnection(transactions), BURNER);
                expect.fail('an unattributable burner must throw');
            } catch (err) {
                expect(err).to.be.instanceOf(KytUnavailableError);
            }
        }
    });
});

describe('fundersAgree', () => {
    /** A connection whose only transaction funds BURNER from `sources`. */
    function connectionFundedBy(sources: string[]): Connection {
        return {
            getSignaturesForAddress: async () => [{ signature: 'sig1' }],
            getParsedTransaction: async () => ({
                meta: { err: null, innerInstructions: [] },
                transaction: {
                    message: {
                        instructions: sources.map((source) => ({
                            program: 'system',
                            parsed: {
                                type: 'transfer',
                                info: {
                                    source,
                                    destination: BURNER.toBase58(),
                                    lamports: 1_000,
                                },
                            },
                        })),
                    },
                },
            }),
        } as unknown as Connection;
    }

    /** Run `body` with console.warn captured. */
    async function capturingWarnings(
        body: () => Promise<boolean>,
    ): Promise<{ result: boolean; warnings: number }> {
        const original = console.warn;
        let warnings = 0;
        console.warn = () => {
            warnings += 1;
        };
        try {
            return { result: await body(), warnings };
        } finally {
            console.warn = original;
        }
    }

    it('agrees when both sides read the same funder', async () => {
        const { result, warnings } = await capturingWarnings(() =>
            fundersAgree(connectionFundedBy([FUNDER.toBase58()]), BURNER, [
                FUNDER.toBase58(),
            ]),
        );

        expect(result).to.equal(true);
        expect(warnings).to.equal(0);
    });

    it('reports a divergence rather than throwing on it', async () => {
        const { result, warnings } = await capturingWarnings(() =>
            fundersAgree(connectionFundedBy([OTHER_FUNDER.toBase58()]), BURNER, [
                FUNDER.toBase58(),
            ]),
        );

        // Surfaced, not fatal: the two sides read different RPC nodes at
        // different moments, and the relayer's list is the one that was signed.
        expect(result).to.equal(false);
        expect(warnings).to.equal(1);
    });

    it('defers to the relayer when the local read fails', async () => {
        const broken = {
            getSignaturesForAddress: async () => {
                throw new Error('rpc down');
            },
        } as unknown as Connection;

        const { result, warnings } = await capturingWarnings(() =>
            fundersAgree(broken, BURNER, [FUNDER.toBase58()]),
        );

        expect(result).to.equal(true);
        expect(warnings).to.equal(0);
    });
});
