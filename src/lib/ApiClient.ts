import { API_BASE_URL } from "./constants";
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
   * Fetch all blobs from the backend and retrieve their content
   * Maps backend 'key' to frontend 'id' for deletion
   */
  async fetchAllBlobs(): Promise<NonceBlob[]> {
    try {
      // 1. Get list of blobs (metadata + content)
      const response = await fetch(`${this.baseUrl}/api/blobs?limit=100`);
      if (!response.ok) {
        throw new Error(`Failed to list blobs: ${response.statusText}`);
      }
      const items = await response.json();

      // The backend now returns the full NonceBlob object in the list
      return items as NonceBlob[];
    } catch (error) {
      console.error("APIClient: fetchAllBlobs failed", error);
      // Return empty array on failure so app can continue offline/fresh
      return [];
    }
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
