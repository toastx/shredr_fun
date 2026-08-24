import { API_BASE_URL, BLOB_PAGE_SIZE, BLOB_MAX_PAGES } from "./constants";
import type { NonceBlob, CreateBlobRequest, NonceBlobAPI } from "./types";

/**
 * Backend API Client for Blob Storage
 * Implements NonceBlobAPI to interface with ShredrClient
 */
export class ApiClient implements NonceBlobAPI {
  private baseUrl: string;

  constructor(baseUrl: string = API_BASE_URL) {
    this.baseUrl = baseUrl;
  }

  /**
   * Walk the blob list page by page, newest first.
   *
   * Blobs carry no user identifier — that is what keeps the store anonymous —
   * so a client finds its own by downloading them and trying to decrypt each.
   * `limit` is therefore a cap on the *global* set, not a per-user one: a flat
   * single-page request means that past ~100 total blobs a returning user's
   * blob is simply not in the response and they are treated as new.
   *
   * The backend paginates by keyset on `createdAt` (`created_at < cursor`,
   * newest first), so each page's oldest entry is the next cursor.
   *
   * Yields pages so callers that can stop early — see `UtxoService.loadRemote`
   * — do not pay for the full walk. Throws on a failed page; `fetchAllBlobs`
   * is the forgiving wrapper.
   */
  async *fetchBlobPages(
    pageSize: number = BLOB_PAGE_SIZE,
  ): AsyncGenerator<NonceBlob[]> {
    const seen = new Set<string>();
    let cursor: number | undefined;

    for (let page = 0; page < BLOB_MAX_PAGES; page++) {
      const url = new URL(`${this.baseUrl}/api/blobs`);
      url.searchParams.set("limit", String(pageSize));
      if (cursor !== undefined) url.searchParams.set("cursor", String(cursor));

      const response = await fetch(url.toString());
      if (!response.ok) {
        throw new Error(`Failed to list blobs: ${response.statusText}`);
      }

      const items = (await response.json()) as NonceBlob[];
      if (items.length === 0) return;

      // Dedupe across pages: keyset boundaries can repeat an entry, and this
      // is also the backstop if the server ignores `cursor` entirely.
      const fresh = items.filter((blob) => !seen.has(blob.id));
      for (const blob of fresh) seen.add(blob.id);
      if (fresh.length > 0) yield fresh;

      // The cursor must strictly decrease. A server that ignores it returns the
      // same newest page forever, which would otherwise hang the login.
      const next = items[items.length - 1].createdAt;
      if (cursor !== undefined && next >= cursor) return;
      cursor = next;

      // A short page is the last page.
      if (items.length < pageSize) return;
    }
  }

  /**
   * Fetch every blob the backend will return.
   *
   * Never throws: callers treat a failure as "no stored state", so an error
   * here surfaces as the user looking new. A page that fails mid-walk returns
   * what was already collected — partial recovery beats none.
   */
  async fetchAllBlobs(): Promise<NonceBlob[]> {
    const blobs: NonceBlob[] = [];
    try {
      for await (const page of this.fetchBlobPages()) {
        blobs.push(...page);
      }
    } catch (error) {
      console.error("APIClient: fetchAllBlobs failed", error);
    }
    return blobs;
  }

  /**
   * Create a new blob on the backend
   */
  async createBlob(data: CreateBlobRequest): Promise<NonceBlob> {
    const response = await fetch(`${this.baseUrl}/api/blobs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      throw new Error(`Upload failed: ${response.statusText}`);
    }

    // Backend returns the created NonceBlob object
    return await response.json();
  }

  /**
   * Delete a blob by ID
   */
  async deleteBlob(id: string): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/blobs/${id}`, {
        method: "DELETE",
      });

      return response.ok;
    } catch (error) {
      console.error("APIClient: deleteBlob failed", error);
      return false;
    }
  }
}

export const apiClient = new ApiClient();
