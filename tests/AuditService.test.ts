/**
 * Tests for per-invoice viewing keys and transferable receipts.
 *
 * These assert the properties the scheme claims rather than restating its
 * implementation: a key opens one invoice and no other, a receipt cannot be
 * altered without detection, and the commitment recomputes from one leaf plus
 * opaque siblings.
 */

import './setup';
import { expect } from 'chai';
import { Keypair, PublicKey } from '@solana/web3.js';

import {
    ATTESTATION_VERSION,
    AuditService,
    INVOICE_LEN,
    bytesEqual,
    decodeBase58,
    packAttestation,
    unpackAttestation,
    UNKNOWN_SIGNATURE,
    verifyDisclosure,
    type Attestation,
    type ViewingKey,
} from '../src/lib/AuditService';
import { deriveStealthPDA } from '../src/lib/ShredrProgram';

/** A signature is 64 bytes; any fixed value works as a master secret here. */
function signatureOf(seed: number): Uint8Array {
    return new Uint8Array(64).fill(seed);
}

async function serviceFrom(seed: number): Promise<AuditService> {
    const service = new AuditService();
    await service.initFromSignature(signatureOf(seed));
    return service;
}

/** A burner and the stealth PDA the program would derive for it. */
function leg() {
    const kp = Keypair.generate();
    const [pda] = deriveStealthPDA(kp.publicKey);
    return { kp, pda };
}

function attestationFor(
    deposit: ReturnType<typeof leg>,
    exit: ReturnType<typeof leg>,
    overrides: Partial<Attestation> = {},
): Attestation {
    return {
        version: ATTESTATION_VERSION,
        depositIndex: 3,
        exitIndex: 4,
        depositPda: deposit.pda.toBase58(),
        exitPda: exit.pda.toBase58(),
        depositBurner: deposit.kp.publicKey.toBase58(),
        exitBurner: exit.kp.publicKey.toBase58(),
        sender: Keypair.generate().publicKey.toBase58(),
        destination: Keypair.generate().publicKey.toBase58(),
        amount: 5_000_000_000n,
        depositTs: 1_700_000_000n,
        exitTs: 1_700_003_600n,
        depositTxSig: UNKNOWN_SIGNATURE,
        exitTxSig: UNKNOWN_SIGNATURE,
        ...overrides,
    };
}

const derivePda = (burner: Uint8Array) =>
    deriveStealthPDA(new PublicKey(burner))[0].toBytes();

describe('AuditService — key derivation', () => {
    it('re-derives the same key from the same signature', async () => {
        const { pda } = leg();
        const a = await (await serviceFrom(7)).deriveViewingKey(pda.toBytes(), 3);
        const b = await (await serviceFrom(7)).deriveViewingKey(pda.toBytes(), 3);

        expect(bytesEqual(a.key, b.key)).to.equal(true);
        expect(bytesEqual(a.iv, b.iv)).to.equal(true);
    });

    it('gives different keys to different invoices', async () => {
        const service = await serviceFrom(7);
        const { pda } = leg();

        const first = await service.deriveViewingKey(pda.toBytes(), 3);
        const second = await service.deriveViewingKey(pda.toBytes(), 4);

        expect(bytesEqual(first.key, second.key)).to.equal(false);
    });

    it('binds a key to one account, so the same index elsewhere differs', async () => {
        const service = await serviceFrom(7);

        const here = await service.deriveViewingKey(leg().pda.toBytes(), 3);
        const there = await service.deriveViewingKey(leg().pda.toBytes(), 3);

        expect(bytesEqual(here.key, there.key)).to.equal(false);
    });

    it('gives different wallets different keys for the same invoice', async () => {
        const { pda } = leg();
        const mine = await (await serviceFrom(7)).deriveViewingKey(pda.toBytes(), 3);
        const theirs = await (await serviceFrom(8)).deriveViewingKey(pda.toBytes(), 3);

        expect(bytesEqual(mine.key, theirs.key)).to.equal(false);
    });

    it('gives a revised receipt a fresh key, so the derived IV is never reused', async () => {
        const service = await serviceFrom(7);
        const { pda } = leg();

        const first = await service.deriveViewingKey(pda.toBytes(), 3, 0);
        const revised = await service.deriveViewingKey(pda.toBytes(), 3, 1);

        // Both halves must move: a shared IV under a shared key is what leaks
        // the AES-GCM keystream and authentication key.
        expect(bytesEqual(first.key, revised.key)).to.equal(false);
        expect(bytesEqual(first.iv, revised.iv)).to.equal(false);
    });

    it('refuses to derive before initialization', async () => {
        const service = new AuditService();
        let threw = false;
        try {
            await service.deriveViewingKey(leg().pda.toBytes(), 0);
        } catch {
            threw = true;
        }
        expect(threw).to.equal(true);
    });
});

describe('AuditService — attestation wire format', () => {
    it('round-trips through pack and unpack', () => {
        const original = attestationFor(leg(), leg());
        const restored = unpackAttestation(packAttestation(original));

        expect(restored).to.deep.equal(original);
    });

    it('is fixed width, so a ciphertext length reveals nothing', () => {
        const small = packAttestation(attestationFor(leg(), leg(), { amount: 1n }));
        const large = packAttestation(
            attestationFor(leg(), leg(), { amount: 18_000_000_000_000_000_000n }),
        );

        expect(small.length).to.equal(large.length);
    });

    it('leaves the transaction signatures outside the committed prefix', () => {
        // One base attestation, varied in exactly one field: `attestationFor`
        // generates a fresh sender and destination on every call.
        const base = attestationFor(leg(), leg());
        const before = packAttestation(base);
        const after = packAttestation({
            ...base,
            depositTxSig: `${Keypair.generate().publicKey.toBase58()}${'1'.repeat(20)}`,
        });

        // The exit signature does not exist when the commitment is written, so
        // the prefix a leaf covers has to be stable without them.
        expect(bytesEqual(before.slice(0, INVOICE_LEN), after.slice(0, INVOICE_LEN))).to.equal(
            true,
        );
        expect(bytesEqual(before, after)).to.equal(false);
    });
});

describe('AuditService — receipts', () => {
    it('opens under its own key and fails under another', async () => {
        const service = await serviceFrom(7);
        const deposit = leg();
        const exit = leg();

        const vk = await service.deriveViewingKey(deposit.pda.toBytes(), 3);
        const other = await service.deriveViewingKey(deposit.pda.toBytes(), 9);

        const signed = service.signAttestation(
            attestationFor(deposit, exit),
            deposit.kp.secretKey,
            exit.kp.secretKey,
        );
        const sealed = await AuditService.seal(vk, signed);

        const opened = await AuditService.open(vk, sealed);
        expect(opened.depositIndex).to.equal(3);
        expect(opened.amount).to.equal(5_000_000_000n);

        let threw = false;
        try {
            await AuditService.open(other, sealed);
        } catch {
            threw = true;
        }
        expect(threw).to.equal(true);
    });

    it('verifies both burner signatures', async () => {
        const service = await serviceFrom(7);
        const deposit = leg();
        const exit = leg();

        const signed = service.signAttestation(
            attestationFor(deposit, exit),
            deposit.kp.secretKey,
            exit.kp.secretKey,
        );

        expect(AuditService.verifySignatures(signed)).to.equal(true);
        expect(
            AuditService.verifySignatures({ ...signed, amount: signed.amount + 1n }),
        ).to.equal(false);
    });

    it('rejects a signature from a burner that does not own the PDA', async () => {
        const service = await serviceFrom(7);
        const deposit = leg();
        const exit = leg();
        const impostor = Keypair.generate();

        const signed = service.signAttestation(
            attestationFor(deposit, exit),
            impostor.secretKey,
            exit.kp.secretKey,
        );

        expect(AuditService.verifySignatures(signed)).to.equal(false);
    });
});

describe('AuditService — commitments', () => {
    it('recomputes the root from one leaf plus opaque siblings', async () => {
        const service = await serviceFrom(7);
        const leaves: Uint8Array[] = [];

        for (let i = 0; i < 4; i++) {
            const deposit = leg();
            const vk = await service.deriveViewingKey(deposit.pda.toBytes(), i);
            leaves.push(await AuditService.leaf(vk, packAttestation(attestationFor(deposit, leg()))));
        }

        const root = await AuditService.root(leaves);
        // Order must not matter: the batch is a set, and an auditor supplies the
        // siblings in whatever order their disclosure happens to list them.
        const shuffled = await AuditService.root([...leaves].reverse());

        expect(bytesEqual(root, shuffled)).to.equal(true);
        expect(root.length).to.equal(32);
    });

    it('changes the root when any leaf changes', async () => {
        const service = await serviceFrom(7);
        const { pda } = leg();
        const vk = await service.deriveViewingKey(pda.toBytes(), 0);

        const a = await AuditService.leaf(vk, packAttestation(attestationFor(leg(), leg())));
        const b = await AuditService.leaf(vk, packAttestation(attestationFor(leg(), leg())));

        expect(bytesEqual(await AuditService.root([a]), await AuditService.root([b]))).to.equal(
            false,
        );
    });

    it('is opaque without the key: a different key gives a different deposit commitment', async () => {
        const mine = await serviceFrom(7);
        const theirs = await serviceFrom(8);
        const { pda } = leg();

        const a = await AuditService.depositCommitment(
            await mine.deriveViewingKey(pda.toBytes(), 2),
            2,
            pda.toBytes(),
            1_000n,
        );
        const b = await AuditService.depositCommitment(
            await theirs.deriveViewingKey(pda.toBytes(), 2),
            2,
            pda.toBytes(),
            1_000n,
        );

        expect(bytesEqual(a, b)).to.equal(false);
        expect(a.length).to.equal(32);
    });
});

describe('verifyDisclosure', () => {
    /** A full withdrawal batch: `count` invoices drained into one exit. */
    async function batch(count: number) {
        const service = await serviceFrom(7);
        const exit = leg();

        const built = [];
        for (let i = 0; i < count; i++) {
            const deposit = leg();
            const attestation = attestationFor(deposit, exit, { depositIndex: i });
            const vk = await service.deriveViewingKey(deposit.pda.toBytes(), i);
            built.push({
                deposit,
                attestation,
                vk,
                leaf: await AuditService.leaf(vk, packAttestation(attestation)),
            });
        }

        const root = await AuditService.root(built.map((b) => b.leaf));

        const disclose = async (which: number, vk: ViewingKey = built[which].vk) => {
            const target = built[which];
            const signed = service.signAttestation(
                target.attestation,
                target.deposit.kp.secretKey,
                exit.kp.secretKey,
            );
            const siblings = built.filter((_, i) => i !== which).map((b) => b.leaf);
            return AuditService.makeDisclosure(vk, signed, siblings);
        };

        return { service, exit, built, root, disclose };
    }

    it('accepts a genuine disclosure', async () => {
        const { built, root, disclose } = await batch(3);
        const result = await verifyDisclosure(await disclose(1), built[1].vk, root, derivePda);

        expect(result.failed).to.equal(undefined);
        expect(result.ok).to.equal(true);
        expect(result.attestation?.depositIndex).to.equal(1);
    });

    it('works for a single-invoice withdrawal, where the root is the leaf', async () => {
        const { built, root, disclose } = await batch(1);
        const result = await verifyDisclosure(await disclose(0), built[0].vk, root, derivePda);

        expect(result.ok).to.equal(true);
    });

    it('reveals nothing to the holder of another invoice key', async () => {
        const { built, root, disclose } = await batch(3);
        // The auditor for invoice 1 is handed invoice 1's token; invoice 2's key
        // must not open it, even though both are in the same batch.
        const result = await verifyDisclosure(await disclose(1), built[2].vk, root, derivePda);

        expect(result.ok).to.equal(false);
        expect(result.failed).to.equal('decrypt');
    });

    it('rejects a tampered amount', async () => {
        const { service, exit, built, root } = await batch(2);
        const target = built[0];

        const signed = service.signAttestation(
            { ...target.attestation, amount: 999_999_999n },
            target.deposit.kp.secretKey,
            exit.kp.secretKey,
        );
        const disclosure = await AuditService.makeDisclosure(target.vk, signed, [built[1].leaf]);

        const result = await verifyDisclosure(disclosure, target.vk, root, derivePda);
        // Signatures still verify — they were made over the altered claim — so
        // the commitment is what catches it.
        expect(result.ok).to.equal(false);
        expect(result.failed).to.equal('commitment');
    });

    it('rejects a burner that does not derive its stated PDA', async () => {
        const { service, exit, built, root } = await batch(2);
        const target = built[0];

        const signed = service.signAttestation(
            { ...target.attestation, depositPda: leg().pda.toBase58() },
            target.deposit.kp.secretKey,
            exit.kp.secretKey,
        );
        const disclosure = await AuditService.makeDisclosure(target.vk, signed, [built[1].leaf]);

        const result = await verifyDisclosure(disclosure, target.vk, root, derivePda);
        expect(result.ok).to.equal(false);
        expect(result.failed).to.equal('pda');
    });

    it('rejects a forged signature', async () => {
        const { service, exit, built, root } = await batch(2);
        const target = built[0];
        const impostor = Keypair.generate();

        const signed = service.signAttestation(
            target.attestation,
            impostor.secretKey,
            exit.kp.secretKey,
        );
        const disclosure = await AuditService.makeDisclosure(target.vk, signed, [built[1].leaf]);

        const result = await verifyDisclosure(disclosure, target.vk, root, derivePda);
        expect(result.ok).to.equal(false);
        expect(result.failed).to.equal('signature');
    });

    it('rejects a wrong sibling set', async () => {
        const { service, exit, built, root } = await batch(3);
        const target = built[0];

        const signed = service.signAttestation(
            target.attestation,
            target.deposit.kp.secretKey,
            exit.kp.secretKey,
        );
        const disclosure = await AuditService.makeDisclosure(target.vk, signed, [
            built[1].leaf,
            new Uint8Array(32).fill(9),
        ]);

        const result = await verifyDisclosure(disclosure, target.vk, root, derivePda);
        expect(result.ok).to.equal(false);
        expect(result.failed).to.equal('commitment');
    });

    it('rejects an unanchored account: a random commitment is not a proof', async () => {
        const { built, disclose } = await batch(2);
        const random = new Uint8Array(32).fill(0xab);

        const result = await verifyDisclosure(await disclose(0), built[0].vk, random, derivePda);
        expect(result.ok).to.equal(false);
        expect(result.failed).to.equal('commitment');
    });
});

describe('base58', () => {
    it('round-trips addresses, including ones with leading zero bytes', () => {
        const address = Keypair.generate().publicKey;
        expect(bytesEqual(decodeBase58(address.toBase58()), address.toBytes())).to.equal(true);

        // BigInt-based decoding drops leading zeros; the packer left-pads. A key
        // beginning 0x00 is rare but not rare enough to leave broken.
        const leadingZero = new Uint8Array(32);
        leadingZero.set([0, 0, 7], 0);
        const encoded = new PublicKey(leadingZero).toBase58();
        const decoded = decodeBase58(encoded);
        const padded = new Uint8Array(32);
        padded.set(decoded, 32 - decoded.length);

        expect(bytesEqual(padded, leadingZero)).to.equal(true);
    });
});
