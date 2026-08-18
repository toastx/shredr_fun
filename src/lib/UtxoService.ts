/**
 * UtxoService - the client's record of every stealth PDA it has created.
 *
 * A shred cycle spans several transactions across two layers (init+delegate →
 * in-rollup transfer → undelegate → withdraw → close). If it dies partway, the
 * funds are still on-chain but nothing points at them: the program stores no
 * role marker, so chain state alone cannot say whether a stranded PDA was a
 * deposit awaiting its transfer or an exit awaiting its withdrawal.
 *
 * This service keeps one note per PDA so a broken cycle can be found and
 * resumed. Notes are a *hint* — reconciliation always trusts on-chain state.
 *
 * Not a shielded-pool nullifier set, despite the spend-marking vocabulary:
 * double-spend is already prevented by the program's account state, and the
 * unlinkability comes from the in-rollup hop. This is bookkeeping.
 *
 * Persistence is two-tier: an encrypted IndexedDB cache for the common path,
 * and the same anonymous encrypted blobs NonceService uses, so the tree
 * survives a new device or cleared storage — exactly when recovery matters.
 */

import { StorageService } from './StorageService';
import { apiClient } from './ApiClient';
import { ALGORITHM, IV_LENGTH } from './constants';
import { uint8ArrayToBase64, base64ToUint8Array, getArrayBuffer } from './utils';
import type { UtxoNote, UtxoRole, UtxoState } from './types';

/** Marks a blob as a note tree; our key also decrypts the nonce blobs. */
const TREE_KIND = 'utxo-tree';
const TREE_VERSION = 1;

interface TreeEnvelope {
    kind: typeof TREE_KIND;
    version: number;
    notes: UtxoNote[];
}

export class UtxoService {
    private storage = new StorageService();
    private _encKey: CryptoKey | null = null;
    private _walletHash: string | null = null;
    private _notes: UtxoNote[] = [];
    private _blobId: string | null = null;

    async init(encryptionKey: CryptoKey, walletHash: string): Promise<void> {
        this._encKey = encryptionKey;
        this._walletHash = walletHash;
        await this.storage.init(encryptionKey);
    }

    get notes(): UtxoNote[] {
        return this._notes;
    }

    /** Notes that still have somewhere to go. */
    get unsettled(): UtxoNote[] {
        return this._notes.filter(
            (n) => n.state !== 'closed' && n.state !== 'spent',
        );
    }

    /**
     * Load the tree: IndexedDB first, falling back to the remote blobs when the
     * cache is empty (new device, cleared storage). Remote wins on conflict —
     * a local cache can only be older than what was last published.
     */
    async load(): Promise<UtxoNote[]> {
        this.assertReady();

        const cached = await this.storage.getNotes(this._walletHash!);
        if (cached.length > 0) {
            this._notes = cached;
            // Still reconcile against remote, but do not block on it.
            void this.loadRemote().catch((e) =>
                console.warn('[UtxoService] remote sync failed:', e),
            );
            return this._notes;
        }

        await this.loadRemote();
        return this._notes;
    }

    private async loadRemote(): Promise<void> {
        let blobs;
        try {
            blobs = await apiClient.fetchAllBlobs();
        } catch (e) {
            console.warn('[UtxoService] fetchAllBlobs failed:', e);
            return;
        }

        // Trial-decrypt: the server cannot tell our blobs from anyone else's,
        // and our own key opens both nonce blobs and tree blobs, so the
        // envelope `kind` is what identifies a tree.
        let best: { blobId: string; notes: UtxoNote[] } | null = null;

        for (const blob of blobs) {
            try {
                const decoded = await this.decrypt(blob.encryptedBlob);
                const env = JSON.parse(decoded) as TreeEnvelope;
                if (env?.kind !== TREE_KIND || !Array.isArray(env.notes)) continue;
                if (!best || env.notes.length > best.notes.length) {
                    best = { blobId: blob.id, notes: env.notes };
                }
            } catch {
                continue; // not ours, or not a tree
            }
        }

        if (!best) return;

        this._notes = this.merge(this._notes, best.notes);
        this._blobId = best.blobId;
        await this.storage.saveNotes(this._walletHash!, this._notes);
    }

    /** Union by PDA, keeping whichever copy is further along. */
    private merge(a: UtxoNote[], b: UtxoNote[]): UtxoNote[] {
        const rank: Record<UtxoState, number> = {
            pending_init: 0,
            delegated: 1,
            undelegated: 2,
            withdrawn: 3,
            spent: 4,
            closed: 5,
        };
        const byPda = new Map<string, UtxoNote>();
        for (const note of [...a, ...b]) {
            const existing = byPda.get(note.stealthPda);
            if (!existing || rank[note.state] > rank[existing.state]) {
                byPda.set(note.stealthPda, note);
            }
        }
        return [...byPda.values()].sort((x, y) => x.createdAt - y.createdAt);
    }

    /**
     * Record a note. Call this **before** sending the transaction it describes:
     * a crash between send and persist is the one window that loses funds, so
     * it must always fall on the recoverable side.
     */
    async record(
        note: Omit<UtxoNote, 'createdAt' | 'state'> &
            Partial<Pick<UtxoNote, 'state' | 'createdAt'>>,
    ): Promise<UtxoNote> {
        this.assertReady();

        const existing = this._notes.find((n) => n.stealthPda === note.stealthPda);
        const merged: UtxoNote = {
            createdAt: existing?.createdAt ?? Date.now(),
            state: 'pending_init',
            ...existing,
            ...note,
        };

        this._notes = [
            ...this._notes.filter((n) => n.stealthPda !== merged.stealthPda),
            merged,
        ];
        await this.persist();
        return merged;
    }

    /** Advance a note's state after its transaction confirms. */
    async setState(
        stealthPda: string,
        state: UtxoState,
        lamports?: number,
    ): Promise<void> {
        const note = this._notes.find((n) => n.stealthPda === stealthPda);
        if (!note) return;

        note.state = state;
        if (lamports !== undefined) note.lamports = lamports;
        if (state === 'spent' || state === 'closed') note.spentAt = Date.now();

        await this.persist();
    }

    /** Link a deposit note to the exit note that received its funds. */
    async link(depositPda: string, exitIndex: number): Promise<void> {
        const note = this._notes.find((n) => n.stealthPda === depositPda);
        if (!note) return;
        note.linkedIndex = exitIndex;
        await this.persist();
    }

    /** Drop terminal notes so the tree does not grow without bound. */
    async prune(): Promise<void> {
        this._notes = this._notes.filter(
            (n) => n.state !== 'closed' && n.state !== 'spent',
        );
        await this.persist();
    }

    /** Write locally first (cheap, always succeeds), then publish the blob. */
    private async persist(): Promise<void> {
        this.assertReady();
        await this.storage.saveNotes(this._walletHash!, this._notes);

        try {
            const envelope: TreeEnvelope = {
                kind: TREE_KIND,
                version: TREE_VERSION,
                notes: this._notes,
            };
            const encryptedBlob = await this.encrypt(JSON.stringify(envelope));
            const created = await apiClient.createBlob({ encryptedBlob });

            const previous = this._blobId;
            this._blobId = created.id;
            if (previous) await apiClient.deleteBlob(previous);
        } catch (e) {
            // The local cache already holds the note; remote is a durability
            // upgrade, not a correctness requirement for this session.
            console.warn('[UtxoService] blob publish failed:', e);
        }
    }

    private async encrypt(plaintext: string): Promise<string> {
        const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
        const ciphertext = new Uint8Array(
            await crypto.subtle.encrypt(
                { name: ALGORITHM, iv: getArrayBuffer(iv) },
                this._encKey!,
                new TextEncoder().encode(plaintext),
            ),
        );

        const combined = new Uint8Array(iv.length + ciphertext.length);
        combined.set(iv, 0);
        combined.set(ciphertext, iv.length);
        return uint8ArrayToBase64(combined);
    }

    private async decrypt(encryptedBlob: string): Promise<string> {
        const combined = base64ToUint8Array(encryptedBlob);
        const iv = combined.slice(0, IV_LENGTH);
        const ciphertext = combined.slice(IV_LENGTH);

        const plaintext = await crypto.subtle.decrypt(
            { name: ALGORITHM, iv: getArrayBuffer(iv) },
            this._encKey!,
            getArrayBuffer(ciphertext),
        );
        return new TextDecoder().decode(plaintext);
    }

    private assertReady(): void {
        if (!this._encKey || !this._walletHash) {
            throw new Error('UtxoService not initialized. Call init() first.');
        }
    }

    destroy(): void {
        this._notes = [];
        this._blobId = null;
        this._encKey = null;
        this._walletHash = null;
        this.storage.close();
    }
}

export const utxoService = new UtxoService();
export type { UtxoNote, UtxoRole, UtxoState };
