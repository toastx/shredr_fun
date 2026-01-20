/**
 * Integration tests for SHREDR complete user flow
 * 
 * Tests the full flow as documented in SKILL.md:
 * Phase 1: Initialization
 * Phase 2: Nonce State Resolution
 * Phase 3: Derive Burner Wallet
 * Phase 4: Consume Nonce
 * Phase 5: Cleanup
 */

import './setup';
import { expect } from 'chai';
import { NonceService } from '../src/lib/NonceService';
import { BurnerService } from '../src/lib/BurnerService';
import { getArrayBuffer } from '../src/lib/utils';
import type { NonceBlob, GeneratedNonce } from '../src/lib/types';

// ============ PRETTY LOGGING ============
const log = {
    section: (name: string) => console.log(`\n${'='.repeat(60)}\n🔗 ${name}\n${'='.repeat(60)}`),
    phase: (num: number, name: string) => console.log(`\n  📍 PHASE ${num}: ${name}`),
    test: (name: string) => console.log(`\n  🧪 ${name}`),
    info: (msg: string) => console.log(`     ℹ️  ${msg}`),
    success: (msg: string) => console.log(`     ✅ ${msg}`),
    warn: (msg: string) => console.log(`     ⚠️  ${msg}`),
    data: (label: string, value: any) => console.log(`     📊 ${label}: ${typeof value === 'object' ? JSON.stringify(value) : value}`),
    hex: (label: string, arr: Uint8Array) => console.log(`     🔐 ${label}: ${Buffer.from(arr).toString('hex').slice(0, 32)}...`),
    address: (label: string, addr: string) => console.log(`     💳 ${label}: ${addr}`),
};

// ============ MOCK BACKEND ============
class MockBackendAPI {
    private blobs: Map<string, NonceBlob> = new Map();
    private idCounter = 0;

    async fetchAllBlobs(): Promise<NonceBlob[]> {
        return Array.from(this.blobs.values());
    }

    async createBlob(data: { encryptedBlob: string }): Promise<NonceBlob> {
        const id = `blob-${++this.idCounter}`;
        const blob: NonceBlob = {
            id,
            encryptedBlob: data.encryptedBlob,
            createdAt: Date.now()
        };
        this.blobs.set(id, blob);
        return blob;
    }

    async deleteBlob(id: string): Promise<boolean> {
        return this.blobs.delete(id);
    }

    // Helper for tests
    clear(): void {
        this.blobs.clear();
        this.idCounter = 0;
    }

    getBlobCount(): number {
        return this.blobs.size;
    }
}

describe('SHREDR Integration Flow', () => {
    let nonceService: NonceService;
    let burnerService: BurnerService;
    let mockBackend: MockBackendAPI;
    
    // Mock wallet signature (64 bytes like a real ed25519 signature)
    const mockSignature = new Uint8Array(64).fill(0).map((_, i) => i % 256);
    
    // Mock wallet public key (32 bytes)
    const mockWalletPubkey = new Uint8Array(32).fill(0).map((_, i) => (i * 7) % 256);

    before(() => {
        log.section('SHREDR Integration Flow Tests');
        log.info('Testing complete user flow as documented in SKILL.md');
    });

    beforeEach(() => {
        nonceService = new NonceService();
        burnerService = new BurnerService();
        mockBackend = new MockBackendAPI();
    });

    afterEach(() => {
        nonceService.destroy();
        burnerService.destroy();
        mockBackend.clear();
    });

    describe('Complete New User Flow', () => {
        before(() => log.section('New User Complete Flow'));

        it('should complete full flow for new user', async () => {
            log.test('Full new user flow (Phases 1-5)');
            
            // Use a UNIQUE wallet pubkey for this test to ensure no old IndexedDB data
            const newUserWalletPubkey = new Uint8Array(32).fill(0).map((_, i) => (i * 31 + 200) % 256);
            
            // ========== PHASE 1: Initialization ==========
            log.phase(1, 'Initialization');
            
            log.info('Simulating wallet.signMessage("SHREDR_V1")...');
            await nonceService.initFromSignature(mockSignature);
            await burnerService.initFromSignature(mockSignature);
            
            expect(nonceService.getEncryptionKey()).to.not.be.null;
            expect(burnerService.isInitialized).to.be.true;
            log.success('Both services initialized');
            
            // ========== PHASE 2: Nonce State Resolution ==========
            log.phase(2, 'Nonce State Resolution');
            
            // Step 1: Check local first
            log.info('Step 1: Checking local storage...');
            let currentNonce = await nonceService.loadCurrentNonce(newUserWalletPubkey);
            log.data('Local nonce found', currentNonce !== null);
            expect(currentNonce).to.be.null; // New user, nothing local
            
            let currentBlobId: string | undefined;
            
            if (!currentNonce) {
                // Step 2: Check remote
                log.info('Step 2: Checking remote backend...');
                const blobs = await mockBackend.fetchAllBlobs();
                log.data('Remote blobs count', blobs.length);
                
                const remoteResult = await nonceService.tryDecryptBlobs(blobs);
                log.data('Found matching blob', remoteResult.found);
                
                if (remoteResult.found && remoteResult.nonce) {
                    // Found in remote - sync to local
                    await nonceService.setCurrentState(remoteResult.nonce);
                    currentNonce = remoteResult.nonce;
                    currentBlobId = remoteResult.blobId;
                } else {
                    // Step 3: New user - generate base nonce
                    log.info('Step 3: Generating base nonce for new user...');
                    currentNonce = await nonceService.generateBaseNonce(newUserWalletPubkey);
                    
                    log.data('Generated nonce index', currentNonce.index);
                    log.hex('Generated nonce', currentNonce.nonce);
                    
                    // Upload to backend
                    const blobData = await nonceService.createBlobData(currentNonce);
                    const newBlob = await mockBackend.createBlob(blobData);
                    currentBlobId = newBlob.id;
                    
                    log.data('Created blob ID', currentBlobId);
                }
            }
            
            expect(currentNonce).to.not.be.null;
            expect(currentNonce!.index).to.equal(0);
            expect(currentBlobId).to.not.be.undefined;
            log.success('Nonce state resolved');
            
            // ========== PHASE 3: Derive Burner Wallet ==========
            log.phase(3, 'Derive Burner Wallet');
            
            const nonce = nonceService.getCurrentNonce();
            expect(nonce).to.not.be.null;
            
            const burner = await burnerService.deriveBurnerFromNonce(nonce!);
            
            log.address('Burner address', burner.address);
            log.data('Burner nonceIndex', burner.nonceIndex);
            log.data('Public key length', burner.publicKey.length);
            log.data('Secret key length', burner.secretKey.length);
            
            expect(burner.address).to.be.a('string');
            expect(burner.publicKey.length).to.equal(32);
            expect(burner.secretKey.length).to.equal(64);
            log.success('Burner wallet derived');
            
            // ========== PHASE 4: Consume Nonce (After Transaction) ==========
            log.phase(4, 'Consume Nonce');
            
            log.info('Simulating burner used for transaction...');
            
            const { consumedNonce, newNonce, newBlobData } = await nonceService.consumeNonce();
            
            log.data('Consumed nonce index', consumedNonce.index);
            log.data('New nonce index', newNonce.index);
            
            expect(consumedNonce.index).to.equal(0);
            expect(newNonce.index).to.equal(1);
            
            // Sync with backend
            log.info('Syncing with backend...');
            const newBlob = await mockBackend.createBlob(newBlobData);
            await mockBackend.deleteBlob(currentBlobId!);
            currentBlobId = newBlob.id;
            
            log.data('New blob ID', currentBlobId);
            log.data('Backend blob count', mockBackend.getBlobCount());
            
            expect(mockBackend.getBlobCount()).to.equal(1); // Only new blob
            
            // Clean up burner secret key
            burnerService.clearBurner(burner);
            expect(burner.secretKey.every(b => b === 0)).to.be.true;
            log.success('Nonce consumed, backend synced, burner cleared');
            
            // ========== PHASE 5: Cleanup ==========
            log.phase(5, 'Cleanup');
            
            nonceService.destroy();
            burnerService.destroy();
            
            expect(nonceService.getCurrentNonce()).to.be.null;
            expect(nonceService.getEncryptionKey()).to.be.null;
            expect(burnerService.isInitialized).to.be.false;
            
            log.success('All sensitive data cleared');
            log.success('COMPLETE NEW USER FLOW PASSED ✓');
        });
    });

    describe('Returning User Flow (Same Device)', () => {
        before(() => log.section('Returning User - Same Device'));

        it('should load nonce from local storage for returning user', async () => {
            log.test('Returning user with local data');
            
            // Use unique wallet pubkey for this test
            const returningUserWallet = new Uint8Array(32).fill(0).map((_, i) => (i * 41 + 100) % 256);
            
            // ===== FIRST SESSION: Create and save nonce =====
            log.info('=== First Session ===');
            
            await nonceService.initFromSignature(mockSignature);
            await burnerService.initFromSignature(mockSignature);
            
            // Generate and increment a few times
            await nonceService.generateBaseNonce(returningUserWallet);
            await nonceService.incrementNonce();
            await nonceService.incrementNonce();
            const savedNonce = await nonceService.incrementNonce();
            
            log.data('Session 1 final index', savedNonce.index);
            log.hex('Session 1 final nonce', savedNonce.nonce);
            
            // Upload to backend
            const blobData = await nonceService.createBlobData(savedNonce);
            await mockBackend.createBlob(blobData);
            
            // End session
            nonceService.destroy();
            burnerService.destroy();
            
            // ===== SECOND SESSION: Returning user =====
            log.info('=== Second Session (Returning User) ===');
            
            const newNonceService = new NonceService();
            const newBurnerService = new BurnerService();
            
            await newNonceService.initFromSignature(mockSignature);
            await newBurnerService.initFromSignature(mockSignature);
            
            // Step 1: Check local FIRST (as per SKILL.md)
            const localNonce = await newNonceService.loadCurrentNonce(returningUserWallet);
            
            log.data('Local nonce found', localNonce !== null);
            
            expect(localNonce).to.not.be.null;
            expect(localNonce!.index).to.equal(3); // Should be at index 3
            
            log.data('Loaded index', localNonce!.index);
            log.success('Returning user loaded from local storage');
            
            // Derive burner from loaded nonce
            const burner = await newBurnerService.deriveBurnerFromNonce(localNonce!);
            log.address('Burner address', burner.address);
            
            newNonceService.destroy();
            newBurnerService.destroy();
        });
    });

    describe('New Device Flow (Remote Sync)', () => {
        before(() => log.section('New Device - Remote Sync'));

        it('should sync from remote when local is empty', async () => {
            log.test('New device syncs from remote');
            
            // Use unique wallet pubkey for this test
            const deviceSyncWallet = new Uint8Array(32).fill(0).map((_, i) => (i * 53 + 150) % 256);
            
            // ===== FIRST DEVICE: Create nonce and upload =====
            log.info('=== Device 1: Create and upload ===');
            
            const device1Nonce = new NonceService();
            await device1Nonce.initFromSignature(mockSignature);
            
            const originalNonce = await device1Nonce.generateBaseNonce(deviceSyncWallet);
            await device1Nonce.incrementNonce();
            const finalNonce = await device1Nonce.incrementNonce();
            
            log.data('Device 1 nonce index', finalNonce.index);
            
            // Upload to "cloud"
            const blobData = await device1Nonce.createBlobData(finalNonce);
            const uploadedBlob = await mockBackend.createBlob(blobData);
            
            log.data('Uploaded blob ID', uploadedBlob.id);
            
            device1Nonce.destroy();
            
            // ===== SECOND DEVICE: No local data, sync from remote =====
            log.info('=== Device 2: Sync from remote ===');
            
            // Simulate new device by creating fresh service (no local IndexedDB data)
            const device2Nonce = new NonceService();
            const device2Burner = new BurnerService();
            
            await device2Nonce.initFromSignature(mockSignature);
            await device2Burner.initFromSignature(mockSignature);
            
            // For new device, we simulate no local data by using different wallet key
            const device2WalletKey = new Uint8Array(32).fill(99); // Different key = no local data
            const localNonce = await device2Nonce.loadCurrentNonce(device2WalletKey);
            
            log.data('Device 2 local nonce found', localNonce !== null);
            expect(localNonce).to.be.null; // New device, nothing local
            
            // Fetch from remote
            const blobs = await mockBackend.fetchAllBlobs();
            log.data('Remote blobs count', blobs.length);
            
            const remoteResult = await device2Nonce.tryDecryptBlobs(blobs);
            
            log.data('Found matching blob', remoteResult.found);
            
            expect(remoteResult.found).to.be.true;
            expect(remoteResult.nonce).to.not.be.undefined;
            expect(remoteResult.nonce!.index).to.equal(2);
            
            // Sync to local
            await device2Nonce.setCurrentState(remoteResult.nonce!);
            
            const currentNonce = device2Nonce.getCurrentNonce();
            expect(currentNonce!.index).to.equal(2);
            
            log.data('Synced nonce index', currentNonce!.index);
            log.success('Device 2 synced from remote');
            
            // Derive same burner as Device 1 would have
            const burner = await device2Burner.deriveBurnerFromNonce(currentNonce!);
            log.address('Burner address (same as Device 1)', burner.address);
            
            device2Nonce.destroy();
            device2Burner.destroy();
        });
    });

    describe('Deterministic Recovery', () => {
        before(() => log.section('Deterministic Recovery Tests'));

        it('should derive same burner from same signature + nonce', async () => {
            log.test('Same signature + same nonce → same burner');
            
            // Use unique wallet pubkey for this test
            const deterministicWallet = new Uint8Array(32).fill(0).map((_, i) => (i * 67 + 175) % 256);
            
            // Session 1
            await nonceService.initFromSignature(mockSignature);
            await burnerService.initFromSignature(mockSignature);
            
            const nonce = await nonceService.generateBaseNonce(deterministicWallet);
            const burner1 = await burnerService.deriveBurnerFromNonce(nonce);
            
            log.address('Session 1 burner', burner1.address);
            
            nonceService.destroy();
            burnerService.destroy();
            
            // Session 2 - completely fresh
            const ns2 = new NonceService();
            const bs2 = new BurnerService();
            
            await ns2.initFromSignature(mockSignature);
            await bs2.initFromSignature(mockSignature);
            
            const nonce2 = await ns2.generateBaseNonce(deterministicWallet);
            const burner2 = await bs2.deriveBurnerFromNonce(nonce2);
            
            log.address('Session 2 burner', burner2.address);
            
            expect(burner1.address).to.equal(burner2.address);
            log.success('Deterministic: same burner recovered');
            
            ns2.destroy();
            bs2.destroy();
        });

        it('should produce forward-secret nonce chain', async () => {
            log.test('Forward secrecy: nonce[n+1] = SHA256(nonce[n])');
            
            await nonceService.initFromSignature(mockSignature);
            
            // Use unique wallet pubkey for this test
            const forwardSecrecyWallet = new Uint8Array(32).fill(0).map((_, i) => (i * 79 + 50) % 256);
            
            const nonce0 = await nonceService.generateBaseNonce(forwardSecrecyWallet);
            // Copy nonce0 bytes before incrementing (increment may zero previous)
            const nonce0Bytes = new Uint8Array(nonce0.nonce);
            
            const nonce1 = await nonceService.incrementNonce();
            // Copy nonce1 bytes before incrementing
            const nonce1Bytes = new Uint8Array(nonce1.nonce);
            
            const nonce2 = await nonceService.incrementNonce();
            const nonce2Bytes = new Uint8Array(nonce2.nonce);
            
            log.hex('Nonce 0', nonce0Bytes);
            log.hex('Nonce 1', nonce1Bytes);
            log.hex('Nonce 2', nonce2Bytes);
            
            // Verify SHA256 chain: nonce[n+1] = SHA256(nonce[n])
            const expected1 = await crypto.subtle.digest('SHA-256', getArrayBuffer(nonce0Bytes));
            const expected2 = await crypto.subtle.digest('SHA-256', getArrayBuffer(nonce1Bytes));
            
            expect(Buffer.from(nonce1Bytes).toString('hex'))
                .to.equal(Buffer.from(new Uint8Array(expected1)).toString('hex'));
            expect(Buffer.from(nonce2Bytes).toString('hex'))
                .to.equal(Buffer.from(new Uint8Array(expected2)).toString('hex'));
            
            log.success('Forward-secret SHA256 chain verified');
        });
    });

    describe('Multiple Burner Generation', () => {
        before(() => log.section('Multiple Burner Generation'));

        it('should generate unique burner for each nonce index', async () => {
            log.test('Generate 5 unique burners');
            
            // Use unique wallet pubkey for this test
            const multipleBurnerWallet = new Uint8Array(32).fill(0).map((_, i) => (i * 83 + 25) % 256);
            
            await nonceService.initFromSignature(mockSignature);
            await burnerService.initFromSignature(mockSignature);
            
            const burners: { index: number; address: string }[] = [];
            
            let nonce = await nonceService.generateBaseNonce(multipleBurnerWallet);
            
            for (let i = 0; i < 5; i++) {
                const burner = await burnerService.deriveBurnerFromNonce(nonce);
                burners.push({ index: nonce.index, address: burner.address });
                log.data(`Burner ${i}`, burner.address.slice(0, 20) + '...');
                
                if (i < 4) {
                    nonce = await nonceService.incrementNonce();
                }
            }
            
            // All addresses should be unique
            const uniqueAddresses = new Set(burners.map(b => b.address));
            expect(uniqueAddresses.size).to.equal(5);
            
            log.success('5 unique burner addresses generated');
        });
    });

    describe('Error Handling', () => {
        before(() => log.section('Error Handling Tests'));

        it('should handle uninitialized service calls gracefully', async () => {
            log.test('Uninitialized service error handling');
            
            // Use unique wallet pubkey for this test
            const errorTestWallet = new Uint8Array(32).fill(0).map((_, i) => (i * 97 + 10) % 256);
            
            // Try to use services without initialization
            try {
                await nonceService.generateBaseNonce(errorTestWallet);
                expect.fail('Should have thrown');
            } catch (e: any) {
                log.data('NonceService error', e.message);
                expect(e.message).to.include('not initialized');
            }
            
            try {
                await burnerService.deriveBurnerFromNonce({
                    nonce: new Uint8Array(32),
                    index: 0,
                    walletPubkeyHash: 'test'
                });
                expect.fail('Should have thrown');
            } catch (e: any) {
                log.data('BurnerService error', e.message);
                expect(e.message).to.include('not initialized');
            }
            
            log.success('Both services throw correct errors when uninitialized');
        });

        it('should handle empty blob list from backend', async () => {
            log.test('Empty blob list handling');
            
            await nonceService.initFromSignature(mockSignature);
            
            const result = await nonceService.tryDecryptBlobs([]);
            
            expect(result.found).to.be.false;
            expect(result.nonce).to.be.undefined;
            
            log.success('Empty blob list handled correctly');
        });
    });
});
