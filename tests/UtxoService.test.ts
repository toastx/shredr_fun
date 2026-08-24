/**
 * Tests for the UTXO note tree's size discipline.
 *
 * The backend rejects a blob over MAX_BLOB_BYTES with a 400, and `persist`
 * swallows publish failures by design — so an unbounded tree does not error,
 * it silently stops syncing and cross-device recovery rots.
 */

import './setup';
import { expect } from 'chai';
import { UtxoService } from '../src/lib/UtxoService';
import { MAX_BLOB_BYTES } from '../src/lib/constants';
import type { UtxoNote, UtxoRole, UtxoState } from '../src/lib/types';

const WALLET_HASH = 'test-wallet-hash';

/** Blobs the fake backend has been asked to store. */
let published: string[] = [];

function stubApi() {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'POST') {
            const body = JSON.parse(String(init.body)) as { encryptedBlob: string };
            if (body.encryptedBlob.length > MAX_BLOB_BYTES) {
                return { ok: false, statusText: 'Blob too large' } as Response;
            }
            published.push(body.encryptedBlob);
            return {
                ok: true,
                json: async () => ({ id: `blob-${published.length}`, encryptedBlob: body.encryptedBlob, createdAt: Date.now() }),
            } as Response;
        }
        if (init?.method === 'DELETE') return { ok: true } as Response;
        return { ok: true, json: async () => [] } as Response;
    }) as typeof fetch;
    return () => { globalThis.fetch = original; };
}

async function makeService(): Promise<UtxoService> {
    const key = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
    );
    const service = new UtxoService();
    await service.init(key, WALLET_HASH);
    return service;
}

function note(i: number, state: UtxoState = 'delegated', role: UtxoRole = 'deposit') {
    return {
        nonceIndex: i,
        role,
        // Realistic base58 lengths — the addresses dominate a note's size.
        burnerAddress: `B${String(i).padStart(43, 'x')}`,
        stealthPda: `P${String(i).padStart(43, 'y')}`,
        state,
        lamports: 1_000_000_000 + i,
    } satisfies Omit<UtxoNote, 'createdAt'>;
}

describe('UtxoService tree size', () => {
    let restore: () => void;

    beforeEach(() => { published = []; restore = stubApi(); });
    afterEach(() => restore());

    it('drops terminal notes rather than accumulating them', async () => {
        const service = await makeService();

        await service.record(note(1));
        await service.record(note(2));
        await service.setState(note(2).stealthPda, 'spent');

        expect(service.notes.map((n) => n.nonceIndex)).to.deep.equal([1]);
    });

    it('keeps every published blob under the backend cap', async () => {
        const service = await makeService();

        // Far more unsettled notes than a blob can hold.
        for (let i = 1; i <= 40; i++) await service.record(note(i));

        expect(published).to.not.be.empty;
        for (const blob of published) {
            expect(blob.length).to.be.at.most(MAX_BLOB_BYTES);
        }
    });

    it('keeps the newest notes when it has to trim', async () => {
        const service = await makeService();
        for (let i = 1; i <= 40; i++) await service.record(note(i));

        // Trimming is remote-only: everything is still available locally, which
        // is what an in-session recovery reads.
        expect(service.notes).to.have.length(40);
        expect(service.unsettled.map((n) => n.nonceIndex)).to.include(40);
    });

    it('round-trips a note through the packed wire format', async () => {
        const service = await makeService();
        await service.record({ ...note(7), linkedIndex: 9 });

        const stored = service.notes[0];
        expect(stored.nonceIndex).to.equal(7);
        expect(stored.role).to.equal('deposit');
        expect(stored.linkedIndex).to.equal(9);
    });
});
