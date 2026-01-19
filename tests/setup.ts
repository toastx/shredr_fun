/**
 * Test setup - mocks browser APIs for Node.js environment
 */

import 'fake-indexeddb/auto';
import { webcrypto } from 'crypto';

// Polyfill Web Crypto API
if (typeof globalThis.crypto === 'undefined') {
    (globalThis as any).crypto = webcrypto;
}

// Polyfill TextEncoder/TextDecoder (should be available in Node 18+)
if (typeof globalThis.TextEncoder === 'undefined') {
    const util = await import('util');
    (globalThis as any).TextEncoder = util.TextEncoder;
    (globalThis as any).TextDecoder = util.TextDecoder;
}
