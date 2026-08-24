/**
 * Unit tests for ApiClient blob pagination.
 *
 * Blobs carry no user identifier, so recovery downloads the whole set and
 * trial-decrypts it. A single flat page silently truncates that set, which
 * presents to the user as account loss — these tests pin the walk that fixes
 * it, and the guards that keep it from hanging against a misbehaving server.
 */

import './setup';
import { expect } from 'chai';
import { ApiClient } from '../src/lib/ApiClient';
import type { NonceBlob } from '../src/lib/types';

const BASE = 'http://backend.test';

/** Blobs are returned newest-first, so createdAt descends with the index. */
function makeBlobs(count: number, startTs: number): NonceBlob[] {
    return Array.from({ length: count }, (_, i) => ({
        id: `blob-${startTs - i}`,
        encryptedBlob: `payload-${startTs - i}`,
        createdAt: startTs - i,
    }));
}

/** Stub global fetch, recording every URL requested. */
function stubFetch(
    handler: (url: URL, call: number) => { ok: boolean; body?: unknown },
): { urls: URL[]; restore: () => void } {
    const urls: URL[] = [];
    const original = globalThis.fetch;
    let call = 0;

    globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        urls.push(url);
        const result = handler(url, call++);
        return {
            ok: result.ok,
            statusText: result.ok ? 'OK' : 'Server Error',
            json: async () => result.body,
        } as Response;
    }) as typeof fetch;

    return { urls, restore: () => { globalThis.fetch = original; } };
}

describe('ApiClient blob pagination', () => {
    it('walks every page and threads the cursor from the last createdAt', async () => {
        const pages = [makeBlobs(100, 1000), makeBlobs(100, 900), makeBlobs(40, 800)];
        const { urls, restore } = stubFetch((_url, call) => ({
            ok: true,
            body: pages[call] ?? [],
        }));

        try {
            const blobs = await new ApiClient(BASE).fetchAllBlobs();

            expect(blobs).to.have.length(240);
            expect(new Set(blobs.map((b) => b.id)).size).to.equal(240);

            // First call has no cursor; each later one carries the previous
            // page's oldest createdAt.
            expect(urls[0].searchParams.get('cursor')).to.equal(null);
            expect(urls[1].searchParams.get('cursor')).to.equal('901');
            expect(urls[2].searchParams.get('cursor')).to.equal('801');
        } finally {
            restore();
        }
    });

    it('stops when a short page signals the end', async () => {
        const { urls, restore } = stubFetch(() => ({ ok: true, body: makeBlobs(40, 1000) }));
        try {
            const blobs = await new ApiClient(BASE).fetchAllBlobs();
            expect(blobs).to.have.length(40);
            expect(urls).to.have.length(1);
        } finally {
            restore();
        }
    });

    it('terminates when the server ignores the cursor', async () => {
        // Without the strictly-decreasing guard this walks until the page cap,
        // or forever if the cap were removed.
        const { urls, restore } = stubFetch(() => ({ ok: true, body: makeBlobs(100, 1000) }));
        try {
            const blobs = await new ApiClient(BASE).fetchAllBlobs();
            expect(blobs).to.have.length(100);
            expect(urls.length).to.be.lessThan(4);
        } finally {
            restore();
        }
    });

    it('returns the pages already collected when a later page fails', async () => {
        const { restore } = stubFetch((_url, call) =>
            call === 0 ? { ok: true, body: makeBlobs(100, 1000) } : { ok: false },
        );
        try {
            // Partial recovery beats none: an empty result makes a returning
            // user look brand new.
            const blobs = await new ApiClient(BASE).fetchAllBlobs();
            expect(blobs).to.have.length(100);
        } finally {
            restore();
        }
    });

    it('dedupes ids repeated across a page boundary', async () => {
        const first = makeBlobs(100, 1000);
        const second = [first[99], ...makeBlobs(39, 900)];
        const { restore } = stubFetch((_url, call) => ({
            ok: true,
            body: call === 0 ? first : call === 1 ? second : [],
        }));
        try {
            const blobs = await new ApiClient(BASE).fetchAllBlobs();
            expect(new Set(blobs.map((b) => b.id)).size).to.equal(blobs.length);
            expect(blobs).to.have.length(139);
        } finally {
            restore();
        }
    });

    it('returns an empty list when the store is empty', async () => {
        const { restore } = stubFetch(() => ({ ok: true, body: [] }));
        try {
            expect(await new ApiClient(BASE).fetchAllBlobs()).to.have.length(0);
        } finally {
            restore();
        }
    });

    it('returns an empty list when the first page fails', async () => {
        const { restore } = stubFetch(() => ({ ok: false }));
        try {
            expect(await new ApiClient(BASE).fetchAllBlobs()).to.have.length(0);
        } finally {
            restore();
        }
    });
});
