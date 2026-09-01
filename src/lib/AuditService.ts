/**
 * Per-invoice viewing keys and transferable receipts.
 *
 * shredr hides the sender→wallet link by routing payments through a one-time
 * burner and an in-rollup hop that produces no base-layer transaction. That is
 * also the problem: nothing can be proven afterwards. This module makes any
 * single payment provable to a chosen third party, and nothing else.
 *
 * Two properties shape every decision here:
 *
 * 1. **Almost nothing is secret.** Sender, amount, timestamp and destination are
 *    all readable from the public ledger given an address. The one fact that is
 *    not on Solana is *which deposit funded which exit* — that hop happens
 *    inside the rollup. A receipt carries that link plus pointers to public data
 *    the auditor checks for themselves.
 * 2. **Nothing is stored.** The map from invoice to viewing key is a derivation,
 *    not a table. A saved burner→key mapping would rebuild exactly the
 *    linkability graph the nonce chain exists to destroy.
 *
 * Deliberately knows nothing about accounts or PDAs — see `anchor.ts` for the
 * one seam that does.
 */

import nacl from "tweetnacl";
import {
    COMMITMENT_BYTES,
    DOMAIN_AUDIT_MASTER,
    LABEL_ATTEST,
    LABEL_DEPOSIT_COMMITMENT,
    LABEL_LEAF,
    LABEL_ROOT,
    LABEL_VIEWING_KEY,
    VIEWING_KEY_MATERIAL_BYTES,
} from "./constants";
import { getArrayBuffer, uint8ArrayToBase64, base64ToUint8Array, zeroMemory } from "./utils";

const enc = new TextEncoder();

/** Key material for one invoice: an AES-256 key and its GCM IV. */
export interface ViewingKey {
    /** The 32 bytes handed to an auditor. */
    key: Uint8Array;
    /** Derived alongside the key, never random — see `deriveViewingKey`. */
    iv: Uint8Array;
}

/** Everything a receipt asserts. Field order here IS the wire format. */
export interface Attestation {
    version: number;
    depositIndex: number;
    /** The exit this deposit funded. The only fact not on the public ledger. */
    exitIndex: number;
    depositPda: string;
    exitPda: string;
    depositBurner: string;
    exitBurner: string;
    sender: string;
    destination: string;
    amount: bigint;
    depositTs: bigint;
    exitTs: bigint;
    /** Base58 transaction signatures — pointers into public ledger history. */
    depositTxSig: string;
    exitTxSig: string;
}

/** A signed attestation. Signatures are what make the proof transferable. */
export interface SignedAttestation extends Attestation {
    /** ed25519 by `depositBurner` over `LABEL_ATTEST ‖ pack(attestation)`. */
    sigDeposit: Uint8Array;
    /** ed25519 by `exitBurner` over the same bytes. */
    sigExit: Uint8Array;
}

/** What the user hands an auditor, alongside the key. Self-contained. */
export interface Disclosure {
    version: number;
    /** AES-256-GCM over the packed signed attestation. */
    ciphertext: string;
    /**
     * The other leaves of the withdrawal batch, as opaque 32-byte hashes.
     * They reveal nothing — each is a hash under a key the auditor lacks — but
     * they are needed to recompute the root the exit PDA committed to.
     */
    siblings: string[];
}

export const ATTESTATION_VERSION = 1;
export const DISCLOSURE_VERSION = 1;

/**
 * Placeholder for a ledger pointer that could not be resolved.
 *
 * The all-zero 64-byte signature, spelled the way base58 spells it, so it
 * survives a pack/unpack round trip. A shorter sentinel would not: decoding is
 * BigInt-based and drops leading zeros, so `"1"` comes back as 64 ones.
 */
export const UNKNOWN_SIGNATURE = '1'.repeat(64);

/** Packed attestation width. Fixed, so a ciphertext length reveals nothing. */
const PACKED_LEN = 1 + 4 + 4 + 32 * 6 + 8 + 8 + 8 + 64 + 64;

/**
 * The prefix of a packed attestation that commitments cover: everything except
 * the two transaction signatures, which are the trailing 128 bytes.
 *
 * They are excluded because of ordering, not taste. The exit commitment is
 * written when the exit PDA is initialised, which is *before* the withdrawal
 * transaction exists — so `exitTxSig` cannot be known at commit time. They are
 * ledger pointers rather than claims anyway: an auditor finds both transactions
 * from the addresses, and cross-checks them against the ledger regardless.
 */
export const INVOICE_LEN = PACKED_LEN - 128;

async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const buf = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
        buf.set(p, off);
        off += p.length;
    }
    const digest = await crypto.subtle.digest("SHA-256", getArrayBuffer(buf));
    return new Uint8Array(digest);
}

function b58ToBytes(address: string): Uint8Array {
    // PublicKey handles base58 for 32-byte values; signatures are 64 bytes and
    // need the generic decoder below.
    return decodeBase58(address);
}

/**
 * Base58 decode. `utils.ts` ships an encoder only, and the verifier has to run
 * against values it was handed rather than ones it produced.
 */
export function decodeBase58(str: string): Uint8Array {
    const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let num = 0n;
    for (const ch of str) {
        const idx = ALPHABET.indexOf(ch);
        if (idx < 0) throw new Error(`Invalid base58 character: ${ch}`);
        num = num * 58n + BigInt(idx);
    }
    const bytes: number[] = [];
    while (num > 0n) {
        bytes.unshift(Number(num % 256n));
        num /= 256n;
    }
    for (const ch of str) {
        if (ch === "1") bytes.unshift(0);
        else break;
    }
    return new Uint8Array(bytes);
}

function fixed(bytes: Uint8Array, len: number, what: string): Uint8Array {
    if (bytes.length === len) return bytes;
    // Base58 drops leading zero bytes on a round trip through BigInt; a 32-byte
    // key beginning 0x00 decodes to 31. Left-pad rather than reject.
    if (bytes.length < len) {
        const padded = new Uint8Array(len);
        padded.set(bytes, len - bytes.length);
        return padded;
    }
    throw new Error(`${what} is ${bytes.length} bytes, expected ${len}`);
}

/**
 * Serialize an attestation to its canonical bytes.
 *
 * Fixed-layout binary, never JSON: signing over JSON means signing over a
 * canonicalization, and every canonicalization has an edge case that lets two
 * different documents produce the same bytes.
 */
export function packAttestation(a: Attestation): Uint8Array {
    const out = new Uint8Array(PACKED_LEN);
    const view = new DataView(out.buffer);
    let off = 0;

    out[off] = a.version;
    off += 1;
    view.setUint32(off, a.depositIndex, true);
    off += 4;
    view.setUint32(off, a.exitIndex, true);
    off += 4;

    for (const addr of [a.depositPda, a.exitPda, a.depositBurner, a.exitBurner, a.sender, a.destination]) {
        out.set(fixed(b58ToBytes(addr), 32, "address"), off);
        off += 32;
    }

    view.setBigUint64(off, a.amount, true);
    off += 8;
    view.setBigInt64(off, a.depositTs, true);
    off += 8;
    view.setBigInt64(off, a.exitTs, true);
    off += 8;

    for (const sig of [a.depositTxSig, a.exitTxSig]) {
        out.set(fixed(b58ToBytes(sig), 64, "tx signature"), off);
        off += 64;
    }

    return out;
}

/** Inverse of `packAttestation`, for the verifier. */
export function unpackAttestation(packed: Uint8Array): Attestation {
    if (packed.length < PACKED_LEN) {
        throw new Error(`Packed attestation is ${packed.length} bytes, expected ${PACKED_LEN}`);
    }
    const view = new DataView(packed.buffer, packed.byteOffset, packed.byteLength);
    let off = 0;

    const version = packed[off];
    off += 1;
    const depositIndex = view.getUint32(off, true);
    off += 4;
    const exitIndex = view.getUint32(off, true);
    off += 4;

    const addrs: string[] = [];
    for (let n = 0; n < 6; n++) {
        addrs.push(encodeBase58(packed.slice(off, off + 32)));
        off += 32;
    }

    const amount = view.getBigUint64(off, true);
    off += 8;
    const depositTs = view.getBigInt64(off, true);
    off += 8;
    const exitTs = view.getBigInt64(off, true);
    off += 8;

    const depositTxSig = encodeBase58(packed.slice(off, off + 64));
    off += 64;
    const exitTxSig = encodeBase58(packed.slice(off, off + 64));

    return {
        version,
        depositIndex,
        exitIndex,
        depositPda: addrs[0],
        exitPda: addrs[1],
        depositBurner: addrs[2],
        exitBurner: addrs[3],
        sender: addrs[4],
        destination: addrs[5],
        amount,
        depositTs,
        exitTs,
        depositTxSig,
        exitTxSig,
    };
}

function encodeBase58(bytes: Uint8Array): string {
    const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let num = 0n;
    for (const b of bytes) num = num * 256n + BigInt(b);
    let out = "";
    while (num > 0n) {
        out = ALPHABET[Number(num % 58n)] + out;
        num /= 58n;
    }
    for (const b of bytes) {
        if (b === 0) out = "1" + out;
        else break;
    }
    return out || "1";
}

/** The bytes a burner signs. Domain-separated so an attestation signature can
 *  never be replayed as a signature over anything else. */
function signingBytes(a: Attestation): Uint8Array {
    const label = enc.encode(LABEL_ATTEST);
    const packed = packAttestation(a);
    const out = new Uint8Array(label.length + packed.length);
    out.set(label, 0);
    out.set(packed, label.length);
    return out;
}

export class AuditService {
    private _auditSeed: Uint8Array | null = null;

    /**
     * Derive the audit master seed from the wallet signature.
     *
     * Matches the four existing derivations in shape — `SHA256(sig ‖ tag)` — so
     * this branch is a sibling of the burner tree, not a child of it.
     */
    async initFromSignature(signature: Uint8Array): Promise<void> {
        const suffix = enc.encode(DOMAIN_AUDIT_MASTER);
        const input = new Uint8Array(signature.length + suffix.length);
        input.set(signature, 0);
        input.set(suffix, signature.length);

        this._auditSeed = await sha256(input);
        zeroMemory(input);
    }

    get initialized(): boolean {
        return this._auditSeed !== null;
    }

    /** Drop the master seed. Derived keys already handed out are unaffected. */
    destroy(): void {
        if (this._auditSeed) zeroMemory(this._auditSeed);
        this._auditSeed = null;
    }

    /**
     * Derive the viewing key for one invoice.
     *
     * ```
     * PRK       = HKDF-Extract(salt = depositPda, ikm = auditSeed)
     * key ‖ iv  = HKDF-Expand (PRK, info = LABEL ‖ LE32(index) ‖ rev, 44)
     * ```
     *
     * `depositPda` is a *binder*, not entropy — it is public, so a key derived
     * from it alone would be public too. It goes in the salt so that a key is
     * meaningless against any other account.
     *
     * `rev` is load-bearing despite looking vestigial. The IV is derived rather
     * than random, which is safe only while one key encrypts one plaintext. Two
     * different plaintexts under the same key and IV would hand an attacker the
     * AES-GCM keystream *and* the authentication key. Bumping `rev` for a
     * revised receipt gives it a fresh key instead.
     */
    async deriveViewingKey(
        depositPda: Uint8Array,
        index: number,
        rev = 0,
    ): Promise<ViewingKey> {
        if (!this._auditSeed) throw new Error("AuditService not initialized");

        const label = enc.encode(LABEL_VIEWING_KEY);
        const info = new Uint8Array(label.length + 5);
        info.set(label, 0);
        new DataView(info.buffer).setUint32(label.length, index, true);
        info[label.length + 4] = rev;

        const ikm = await crypto.subtle.importKey(
            "raw",
            getArrayBuffer(this._auditSeed),
            "HKDF",
            false,
            ["deriveBits"],
        );
        const bits = await crypto.subtle.deriveBits(
            {
                name: "HKDF",
                hash: "SHA-256",
                salt: getArrayBuffer(depositPda),
                info: getArrayBuffer(info),
            },
            ikm,
            VIEWING_KEY_MATERIAL_BYTES * 8,
        );

        const material = new Uint8Array(bits);
        return {
            key: material.slice(0, 32),
            iv: material.slice(32, VIEWING_KEY_MATERIAL_BYTES),
        };
    }

    /** Sign an attestation with both burners. Only the key holder can do this,
     *  and the program recorded that key as the PDA's `owner`. */
    signAttestation(
        a: Attestation,
        depositSecretKey: Uint8Array,
        exitSecretKey: Uint8Array,
    ): SignedAttestation {
        const msg = signingBytes(a);
        return {
            ...a,
            sigDeposit: nacl.sign.detached(msg, depositSecretKey),
            sigExit: nacl.sign.detached(msg, exitSecretKey),
        };
    }

    /** Verify both burner signatures over an attestation. */
    static verifySignatures(a: SignedAttestation): boolean {
        const msg = signingBytes(a);
        const depositKey = fixed(decodeBase58(a.depositBurner), 32, "deposit burner");
        const exitKey = fixed(decodeBase58(a.exitBurner), 32, "exit burner");
        return (
            nacl.sign.detached.verify(msg, a.sigDeposit, depositKey) &&
            nacl.sign.detached.verify(msg, a.sigExit, exitKey)
        );
    }

    /**
     * Commitment anchored on a deposit PDA, covering the incoming payment.
     *
     * Written at shred time, when the link is not yet known — the exit is chosen
     * later, at withdrawal.
     *
     * Covers only what the client holds without an RPC round trip, because this
     * runs in the deposit hot path. The sender and the on-chain timestamp are
     * deliberately absent: both are public, so an auditor verifies them against
     * the ledger directly, where they are authoritative. Committing to a
     * client's guess at a Clock value it has not read yet would be worse than
     * not committing at all.
     */
    static async depositCommitment(
        vk: ViewingKey,
        index: number,
        depositPda: Uint8Array,
        amount: bigint,
    ): Promise<Uint8Array> {
        const scalars = new Uint8Array(12);
        const view = new DataView(scalars.buffer);
        view.setUint32(0, index, true);
        view.setBigUint64(4, amount, true);
        return sha256(enc.encode(LABEL_DEPOSIT_COMMITMENT), vk.key, depositPda, scalars);
    }

    /**
     * One invoice's leaf in a withdrawal batch.
     *
     * Takes the invoice prefix (see {@link INVOICE_LEN}), not the full packed
     * attestation.
     */
    static async leaf(vk: ViewingKey, invoice: Uint8Array): Promise<Uint8Array> {
        return sha256(enc.encode(LABEL_LEAF), vk.key, invoice.slice(0, INVOICE_LEN));
    }

    /**
     * Commitment anchored on an exit PDA, covering the whole withdrawal batch.
     *
     * A withdrawal drains N deposits into one exit, so committing to the batch
     * directly would force an auditor holding one key to reconstruct everyone
     * else's invoice to recheck the hash. Committing to a *set* of leaves lets
     * them supply the others as opaque hashes instead.
     *
     * ponytail: sorted concat, not a Merkle tree. Leaks N and verifies in O(N);
     * N is 1-5 in practice. Swap in a binary tree if batches ever grow.
     */
    static async root(leaves: Uint8Array[]): Promise<Uint8Array> {
        const sorted = [...leaves].sort(compareBytes);
        return sha256(enc.encode(LABEL_ROOT), ...sorted);
    }

    /** Encrypt a signed attestation under its viewing key. */
    static async seal(vk: ViewingKey, a: SignedAttestation): Promise<Uint8Array> {
        const packed = packAttestation(a);
        const body = new Uint8Array(packed.length + 128);
        body.set(packed, 0);
        body.set(a.sigDeposit, packed.length);
        body.set(a.sigExit, packed.length + 64);

        const key = await crypto.subtle.importKey(
            "raw",
            getArrayBuffer(vk.key),
            { name: "AES-GCM" },
            false,
            ["encrypt"],
        );
        const ct = await crypto.subtle.encrypt(
            { name: "AES-GCM", iv: getArrayBuffer(vk.iv) },
            key,
            getArrayBuffer(body),
        );
        return new Uint8Array(ct);
    }

    /** Decrypt a sealed receipt. A GCM tag failure means wrong key or tampered. */
    static async open(vk: ViewingKey, ciphertext: Uint8Array): Promise<SignedAttestation> {
        const key = await crypto.subtle.importKey(
            "raw",
            getArrayBuffer(vk.key),
            { name: "AES-GCM" },
            false,
            ["decrypt"],
        );
        const plain = new Uint8Array(
            await crypto.subtle.decrypt(
                { name: "AES-GCM", iv: getArrayBuffer(vk.iv) },
                key,
                getArrayBuffer(ciphertext),
            ),
        );

        const packed = plain.slice(0, PACKED_LEN);
        return {
            ...unpackAttestation(packed),
            sigDeposit: plain.slice(PACKED_LEN, PACKED_LEN + 64),
            sigExit: plain.slice(PACKED_LEN + 64, PACKED_LEN + 128),
        };
    }

    /** Bundle a receipt for handing over. The key travels separately. */
    static async makeDisclosure(
        vk: ViewingKey,
        a: SignedAttestation,
        siblings: Uint8Array[],
    ): Promise<Disclosure> {
        return {
            version: DISCLOSURE_VERSION,
            ciphertext: uint8ArrayToBase64(await AuditService.seal(vk, a)),
            siblings: siblings.map(uint8ArrayToBase64),
        };
    }
}

/**
 * Serialize a viewing key for handing to an auditor.
 *
 * Carries the IV as well as the key. The IV is derived, not random, but it is
 * derived from `auditSeed` — which the auditor must never have — so it cannot be
 * recomputed on their side and has to travel with the key.
 */
export function encodeViewingKey(vk: ViewingKey): string {
    const combined = new Uint8Array(vk.key.length + vk.iv.length);
    combined.set(vk.key, 0);
    combined.set(vk.iv, vk.key.length);
    return uint8ArrayToBase64(combined);
}

export function decodeViewingKey(encoded: string): ViewingKey {
    const bytes = base64ToUint8Array(encoded.trim());
    if (bytes.length !== VIEWING_KEY_MATERIAL_BYTES) {
        throw new Error(
            `Viewing key must be ${VIEWING_KEY_MATERIAL_BYTES} bytes, got ${bytes.length}`,
        );
    }
    return { key: bytes.slice(0, 32), iv: bytes.slice(32) };
}

/** The disclosure as one pasteable string. */
export function encodeDisclosure(d: Disclosure): string {
    return uint8ArrayToBase64(enc.encode(JSON.stringify(d)));
}

export function decodeDisclosure(token: string): Disclosure {
    const parsed = JSON.parse(
        new TextDecoder().decode(base64ToUint8Array(token.trim())),
    );
    if (typeof parsed?.ciphertext !== 'string' || !Array.isArray(parsed?.siblings)) {
        throw new Error('Not a shredr disclosure token');
    }
    return parsed as Disclosure;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
        if (a[i] !== b[i]) return a[i] - b[i];
    }
    return a.length - b.length;
}

/** Constant-time equality. Commitments are public, but the habit is cheap. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
}

export interface VerificationResult {
    ok: boolean;
    attestation?: SignedAttestation;
    /** Which check failed, in the order they run. */
    failed?: "decrypt" | "pda" | "signature" | "commitment";
}

/**
 * Verify a disclosure against an on-chain commitment.
 *
 * Deliberately standalone and dependency-light: a third party must be able to
 * run this holding nothing but the token, the key, and a public RPC. If it ever
 * needs more than that, the design has failed.
 *
 * `onChainRoot` comes from `anchor.ts` — this function never learns that a
 * commitment lives in a PDA.
 */
export async function verifyDisclosure(
    disclosure: Disclosure,
    viewingKey: ViewingKey,
    onChainRoot: Uint8Array,
    derivePda: (burner: Uint8Array) => Uint8Array,
): Promise<VerificationResult> {
    let attestation: SignedAttestation;
    try {
        attestation = await AuditService.open(
            viewingKey,
            base64ToUint8Array(disclosure.ciphertext),
        );
    } catch {
        return { ok: false, failed: "decrypt" };
    }

    // The signer must provably control the account it speaks for.
    const legs: Array<[string, string]> = [
        [attestation.depositBurner, attestation.depositPda],
        [attestation.exitBurner, attestation.exitPda],
    ];
    for (const [burner, pda] of legs) {
        const derived = derivePda(fixed(decodeBase58(burner), 32, "burner"));
        if (!bytesEqual(derived, fixed(decodeBase58(pda), 32, "pda"))) {
            return { ok: false, attestation, failed: "pda" };
        }
    }

    if (!AuditService.verifySignatures(attestation)) {
        return { ok: false, attestation, failed: "signature" };
    }

    const packed = packAttestation(attestation);
    const leaf = await AuditService.leaf(viewingKey, packed);
    const siblings = disclosure.siblings.map(base64ToUint8Array);
    const root = await AuditService.root([leaf, ...siblings]);

    if (!bytesEqual(root, onChainRoot.slice(0, COMMITMENT_BYTES))) {
        return { ok: false, attestation, failed: "commitment" };
    }

    return { ok: true, attestation };
}

export const auditService = new AuditService();
