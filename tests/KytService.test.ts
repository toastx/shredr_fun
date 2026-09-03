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
import { Ed25519Program, Keypair } from '@solana/web3.js';

import {
    ATTESTATION_BYTES,
    KytRefusedError,
    KytService,
    KytUnavailableError,
    toInstruction,
    type KytAttestation,
} from '../src/lib/KytService';

const BASE = 'http://relayer.test';

const AUTHORITY = Keypair.generate().publicKey;
const DEPOSITOR = Keypair.generate().publicKey;
const BURNER = Keypair.generate().publicKey;

/** A well-formed response body. `verdict` and overrides are per-test. */
function attestation(overrides: Partial<KytAttestation> = {}): KytAttestation {
    return {
        verdict: 1,
        authority: AUTHORITY.toBase58(),
        message: Buffer.alloc(ATTESTATION_BYTES, 7).toString('base64'),
        signature: Buffer.alloc(64, 9).toString('base64'),
        expiresAt: 1_800_000_000,
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
        let body: Record<string, string> = {};

        globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
            body = JSON.parse(String(init?.body));
            return {
                ok: true,
                json: async () => attestation(),
            } as Response;
        }) as typeof fetch;

        try {
            await new KytService(BASE).screen(DEPOSITOR, BURNER, 5_000_000_000n);
        } finally {
            globalThis.fetch = original;
        }

        // An attestation that said only "this wallet is clean" would be a bearer
        // token good for every deposit that wallet ever makes.
        expect(body.depositor).to.equal(DEPOSITOR.toBase58());
        expect(body.burner).to.equal(BURNER.toBase58());
        expect(body.maxAmount).to.equal('5000000000');
    });

    it('throws a distinct, final error when the depositor is refused', async () => {
        const restore = stubFetch({
            ok: true,
            body: attestation({ verdict: 0, reason: 'sanctioned counterparty' }),
        });

        try {
            await new KytService(BASE).attest(DEPOSITOR, BURNER, 1n);
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
        ];

        for (const response of cases) {
            const restore = stubFetch(response);
            try {
                await new KytService(BASE).screen(DEPOSITOR, BURNER, 1n);
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
            await new KytService('').screen(DEPOSITOR, BURNER, 1n);
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
