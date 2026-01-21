import { API_BASE_URL } from './constants';
import type { NonceBlob, CreateBlobRequest, NonceBlobAPI } from './types';

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
     * Fetch all blobs from the backend and retrieve their content
     * Maps backend 'key' to frontend 'id' for deletion
     */
    async fetchAllBlobs(): Promise<NonceBlob[]> {
        try {
            // 1. Get list of blobs (metadata)
            const listResponse = await fetch(`${this.baseUrl}/api/blobs?limit=100`);
            if (!listResponse.ok) {
                throw new Error(`Failed to list blobs: ${listResponse.statusText}`);
            }
            const items = await listResponse.json();

            // 2. Fetch content for each blob
            // Note: In production with many blobs, this should be optimized 
            // (e.g., download only if needed, or backend filtering)
            const blobs = await Promise.all(items.map(async (item: any) => {
                try {
                    const contentResponse = await fetch(`${this.baseUrl}/api/blob/${item.key}`);
                    if (!contentResponse.ok) {
                        console.warn(`Failed to fetch content for blob ${item.key}`);
                        return null;
                    }
                    const textContent = await contentResponse.text();

                    return {
                        id: item.key, // Use key as ID for deletion
                        encryptedBlob: textContent,
                        createdAt: new Date(item.created_at).getTime()
                    } as NonceBlob;
                } catch (err) {
                    console.warn(`Error fetching blob ${item.key}:`, err);
                    return null;
                }
            }));

            // Filter out failed fetches
            return blobs.filter((b): b is NonceBlob => b !== null);

        } catch (error) {
            console.error('APIClient: fetchAllBlobs failed', error);
            // Return empty array on failure so app can continue offline/fresh
            return [];
        }
    }

    /**
     * Create a new blob on the backend
     */
    async createBlob(data: CreateBlobRequest): Promise<NonceBlob> {
        const formData = new FormData();
        // Create a file from the encrypted string
        const blob = new Blob([data.encryptedBlob], { type: 'text/plain' });
        formData.append('file', blob, 'blob.txt');

        const response = await fetch(`${this.baseUrl}/api/blob/upload`, {
            method: 'POST',
            body: formData,
        });

        if (!response.ok) {
            throw new Error(`Upload failed: ${response.statusText}`);
        }

        const result = await response.json();
        
        // result = { id: uuid, key: "...", message: "..." }
        
        return {
            id: result.key, // Use key as ID
            encryptedBlob: data.encryptedBlob,
            createdAt: Date.now()
        };
    }

    /**
     * Delete a blob by ID (which is the Key)
     */
    async deleteBlob(id: string): Promise<boolean> {
        try {
            const response = await fetch(`${this.baseUrl}/api/blob/${id}`, {
                method: 'DELETE',
            });

            return response.ok;
        } catch (error) {
            console.error('APIClient: deleteBlob failed', error);
            return false;
        }
    }
}

export const apiClient = new ApiClient();
