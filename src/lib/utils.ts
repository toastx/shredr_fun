/**
 * Cryptographic utility functions for SHREDR
 */

/**
 * Zero out sensitive memory - overwrites with random then zeros
 * Helps prevent memory forensics attacks
 */
export function zeroMemory(arr: Uint8Array): void {
    crypto.getRandomValues(arr);
    arr.fill(0);
}

/**
 * Convert Uint8Array to Base64 string
 */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

/**
 * Convert Base64 string to Uint8Array
 */
export function base64ToUint8Array(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

/**
 * Convert Uint8Array to Base58 string (Bitcoin/Solana style)
 */
export function uint8ArrayToBase58(bytes: Uint8Array): string {
    const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    if (bytes.length === 0) return '';
    
    let result = '';
    let num = BigInt('0x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(''));
    while (num > 0) {
        result = ALPHABET[Number(num % 58n)] + result;
        num = num / 58n;
    }
    for (const byte of bytes) {
        if (byte === 0) result = '1' + result;
        else break;
    }
    return result || '1';
}

/**
 * Get ArrayBuffer slice from Uint8Array (handles byteOffset correctly)
 */
export function getArrayBuffer(arr: Uint8Array): ArrayBuffer {
    return arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength) as ArrayBuffer;
}

/**
 * Generate cryptographically secure random bytes
 */
export function generateRandomBytes(length: number): Uint8Array {
    return crypto.getRandomValues(new Uint8Array(length));
}

/**
 * Derive a privacy-preserving wallet hash for IndexedDB keys
 * Hashes the FULL pubkey first, then truncates the hash output
 * This prevents identification of the wallet from the stored key
 */
export async function deriveWalletHash(
    walletPublicKey: Uint8Array, 
    length: number
): Promise<string> {
    // Hash the full pubkey - can't be reversed
    const hashBuffer = await crypto.subtle.digest('SHA-256', getArrayBuffer(walletPublicKey));
    const hashArray = new Uint8Array(hashBuffer);
    
    // Convert to base58 and truncate the HASH (not the pubkey)
    return uint8ArrayToBase58(hashArray).slice(0, length);
}
