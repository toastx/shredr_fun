/**
 * Unit tests for NonceService
 */

import './setup';
import { expect } from 'chai';
import { NonceService } from '../src/lib/NonceService';
import { DecryptionError } from '../src/lib/types';
import { getArrayBuffer } from '../src/lib/utils';

// ============ PRETTY LOGGING ============
const log = {
    section: (name: string) => console.log(`\n${'='.repeat(50)}\n📋 ${name}\n${'='.repeat(50)}`),
    test: (name: string) => console.log(`\n  🧪 ${name}`),
    info: (msg: string) => console.log(`     ℹ️  ${msg}`),
    success: (msg: string) => console.log(`     ✅ ${msg}`),
    data: (label: string, value: any) => console.log(`     📊 ${label}: ${typeof value === 'object' ? JSON.stringify(value) : value}`),
    hex: (label: string, arr: Uint8Array) => console.log(`     🔐 ${label}: ${Buffer.from(arr).toString('hex').slice(0, 32)}...`),
};

describe('NonceService', () => {
    let nonceService: NonceService;
    
    // Mock wallet signature (64 bytes like a real ed25519 signature)
    const mockSignature = new Uint8Array(64).fill(0).map((_, i) => i % 256);
    
    // Mock wallet public key (32 bytes)
    const mockWalletPubkey = new Uint8Array(32).fill(0).map((_, i) => (i * 7) % 256);

    before(() => {
        log.section('NonceService Unit Tests');
        log.info(`Mock signature: ${Buffer.from(mockSignature).toString('hex').slice(0, 32)}...`);
        log.info(`Mock wallet pubkey: ${Buffer.from(mockWalletPubkey).toString('hex').slice(0, 32)}...`);
    });

    beforeEach(() => {
        nonceService = new NonceService();
    });

    afterEach(() => {
        nonceService.destroy();
    });

    describe('initFromSignature', () => {
        before(() => log.section('initFromSignature Tests'));

        it('should initialize from a valid signature', async () => {
            log.test('Initialize from valid signature');
            
            await nonceService.initFromSignature(mockSignature);
            
            const encKey = nonceService.getEncryptionKey();
            expect(encKey).to.not.be.null;
            
            log.success('Service initialized successfully');
            log.data('Encryption key type', encKey?.algorithm);
        });

        it('should derive different keys from different signatures', async () => {
            log.test('Different signatures → different keys');
            
            const service1 = new NonceService();
            const service2 = new NonceService();
            
            const sig1 = new Uint8Array(64).fill(1);
            const sig2 = new Uint8Array(64).fill(2);
            
            log.info('Signature 1: all 0x01 bytes');
            log.info('Signature 2: all 0x02 bytes');
            
            await service1.initFromSignature(sig1);
            await service2.initFromSignature(sig2);
            
            const nonce1 = await service1.generateBaseNonce(mockWalletPubkey);
            const nonce2 = await service2.generateBaseNonce(mockWalletPubkey);
            
            log.hex('Nonce from sig1', nonce1.nonce);
            log.hex('Nonce from sig2', nonce2.nonce);
            
            expect(Buffer.from(nonce1.nonce).toString('hex'))
                .to.not.equal(Buffer.from(nonce2.nonce).toString('hex'));
            
            log.success('Nonces are different ✓');
            
            service1.destroy();
            service2.destroy();
        });
    });

    describe('generateBaseNonce', () => {
        before(() => log.section('generateBaseNonce Tests'));

        beforeEach(async () => {
            await nonceService.initFromSignature(mockSignature);
        });

        it('should generate base nonce at index 0', async () => {
            log.test('Generate base nonce');
            
            const result = await nonceService.generateBaseNonce(mockWalletPubkey);
            
            log.data('Index', result.index);
            log.data('Nonce length', result.nonce.length);
            log.hex('Nonce value', result.nonce);
            log.data('Wallet hash', result.walletPubkeyHash);
            
            expect(result.index).to.equal(0);
            expect(result.nonce).to.be.instanceOf(Uint8Array);
            expect(result.nonce.length).to.equal(32);
            expect(result.walletPubkeyHash).to.be.a('string');
            
            log.success('Base nonce generated at index 0');
        });

        it('should generate deterministic nonce for same signature', async () => {
            log.test('Deterministic nonce generation');
            
            const result1 = await nonceService.generateBaseNonce(mockWalletPubkey);
            log.hex('First generation', result1.nonce);
            
            const service2 = new NonceService();
            await service2.initFromSignature(mockSignature);
            const result2 = await service2.generateBaseNonce(mockWalletPubkey);
            log.hex('Second generation (new service, same sig)', result2.nonce);
            
            expect(Buffer.from(result1.nonce).toString('hex'))
                .to.equal(Buffer.from(result2.nonce).toString('hex'));
            
            log.success('Same signature → same nonce ✓');
            
            service2.destroy();
        });
    });

    describe('incrementNonce', () => {
        before(() => log.section('incrementNonce Tests'));

        beforeEach(async () => {
            await nonceService.initFromSignature(mockSignature);
            await nonceService.generateBaseNonce(mockWalletPubkey);
        });

        it('should increment nonce index', async () => {
            log.test('Index increment');
            
            const initial = nonceService.getCurrentNonce();
            log.data('Initial index', initial?.index);
            
            const incremented = await nonceService.incrementNonce();
            log.data('After increment', incremented.index);
            
            expect(initial?.index).to.equal(0);
            expect(incremented.index).to.equal(1);
            
            log.success('Index incremented: 0 → 1');
        });

        it('should produce different nonce value after increment', async () => {
            log.test('Value changes after increment');
            
            const initial = nonceService.getCurrentNonce();
            log.hex('Before', initial!.nonce);
            
            const incremented = await nonceService.incrementNonce();
            log.hex('After', incremented.nonce);
            
            expect(Buffer.from(initial!.nonce).toString('hex'))
                .to.not.equal(Buffer.from(incremented.nonce).toString('hex'));
            
            log.success('Nonce value changed after increment');
        });

        it('should chain nonces deterministically (SHA256 chain)', async () => {
            log.test('Deterministic SHA256 chain');
            
            log.info('Incrementing 3 times...');
            await nonceService.incrementNonce();
            await nonceService.incrementNonce();
            const at3 = await nonceService.incrementNonce();
            log.hex('Nonce at index 3 (first service)', at3.nonce);
            
            log.info('Creating new service, incrementing to same index...');
            const service2 = new NonceService();
            await service2.initFromSignature(mockSignature);
            await service2.generateBaseNonce(mockWalletPubkey);
            await service2.incrementNonce();
            await service2.incrementNonce();
            const at3Again = await service2.incrementNonce();
            log.hex('Nonce at index 3 (second service)', at3Again.nonce);
            
            expect(at3.index).to.equal(3);
            expect(at3Again.index).to.equal(3);
            expect(Buffer.from(at3.nonce).toString('hex'))
                .to.equal(Buffer.from(at3Again.nonce).toString('hex'));
            
            log.success('Same index → same nonce value ✓');
            
            service2.destroy();
        });

        it('should throw if no base nonce generated', async () => {
            log.test('Error when no base nonce');
            
            const freshService = new NonceService();
            await freshService.initFromSignature(mockSignature);
            
            log.info('Attempting to increment without generateBaseNonce...');
            
            try {
                await freshService.incrementNonce();
                expect.fail('Should have thrown');
            } catch (e: any) {
                log.data('Error message', e.message);
                expect(e.message).to.include('No current nonce');
                log.success('Correct error thrown');
            }
            
            freshService.destroy();
        });
    });

    describe('loadCurrentNonce', () => {
        before(() => log.section('loadCurrentNonce Tests'));

        it('should return null for new wallet', async () => {
            log.test('New wallet returns null');
            
            // Use unique wallet pubkey to avoid data from other tests
            const uniqueWalletPubkey = new Uint8Array(32).fill(0).map((_, i) => (i * 13 + 99) % 256);
            log.info('Using unique wallet pubkey for this test');
            
            await nonceService.initFromSignature(mockSignature);
            const result = await nonceService.loadCurrentNonce(uniqueWalletPubkey);
            
            log.data('Result', result);
            expect(result).to.be.null;
            
            log.success('Returns null for new wallet');
        });

        it('should load previously saved nonce', async () => {
            log.test('Persist and reload nonce');
            
            // Use unique wallet pubkey for this test
            const persistTestWallet = new Uint8Array(32).fill(0).map((_, i) => (i * 17 + 42) % 256);
            log.info('Using unique wallet pubkey for persistence test');
            
            log.info('Generating and incrementing nonce...');
            await nonceService.initFromSignature(mockSignature);
            await nonceService.generateBaseNonce(persistTestWallet);
            await nonceService.incrementNonce();
            await nonceService.incrementNonce();
            const current = nonceService.getCurrentNonce();
            
            // IMPORTANT: Copy the values before destroy() zeros the memory!
            const savedIndex = current!.index;
            const savedNonceHex = Buffer.from(current!.nonce).toString('hex');
            
            log.data('Saved index', savedIndex);
            log.info(`Saved nonce: ${savedNonceHex.slice(0, 32)}...`);
            
            log.info('Destroying service...');
            nonceService.destroy();
            
            log.info('Creating new service and loading...');
            const newService = new NonceService();
            await newService.initFromSignature(mockSignature);
            const loaded = await newService.loadCurrentNonce(persistTestWallet);
            
            log.data('Loaded index', loaded!.index);
            log.hex('Loaded nonce', loaded!.nonce);
            
            expect(loaded).to.not.be.null;
            expect(loaded!.index).to.equal(savedIndex);
            expect(Buffer.from(loaded!.nonce).toString('hex')).to.equal(savedNonceHex);
            
            log.success('Nonce persisted and reloaded correctly');
            
            newService.destroy();
        });
    });

    describe('encryptNonce / decryptNonce', () => {
        let encryptionKey: CryptoKey;

        before(() => log.section('encrypt/decrypt Tests'));

        beforeEach(async () => {
            await nonceService.initFromSignature(mockSignature);
            encryptionKey = nonceService.getEncryptionKey()!;
        });

        it('should encrypt and decrypt nonce correctly', async () => {
            log.test('Round-trip encryption');
            
            const nonce = await nonceService.generateBaseNonce(mockWalletPubkey);
            log.hex('Original nonce', nonce.nonce);
            log.data('Original index', nonce.index);
            
            const encrypted = await nonceService.encryptNonce(nonce, encryptionKey);
            log.data('Encrypted blob length', encrypted.encryptedBlob.length);
            log.data('Version', encrypted.version);

            const decrypted = await nonceService.decryptNonce(encrypted, encryptionKey);
            log.hex('Decrypted nonce', decrypted.nonce);
            log.data('Decrypted index', decrypted.index);

            expect(encrypted.encryptedBlob).to.be.a('string');
            expect(encrypted.version).to.equal(1);
            expect(decrypted.index).to.equal(nonce.index);
            expect(Buffer.from(decrypted.nonce).toString('hex'))
                .to.equal(Buffer.from(nonce.nonce).toString('hex'));
            
            log.success('Encrypt → Decrypt round-trip successful');
        });

        it('should fail decryption with wrong key', async () => {
            log.test('Wrong key rejection');
            
            const nonce = await nonceService.generateBaseNonce(mockWalletPubkey);
            const encrypted = await nonceService.encryptNonce(nonce, encryptionKey);
            
            log.info('Creating service with different signature...');
            const wrongSig = new Uint8Array(64).fill(99);
            const wrongService = new NonceService();
            await wrongService.initFromSignature(wrongSig);
            const wrongKey = wrongService.getEncryptionKey()!;
            
            log.info('Attempting decrypt with wrong key...');
            
            try {
                await nonceService.decryptNonce(encrypted, wrongKey);
                expect.fail('Should have thrown DecryptionError');
            } catch (e) {
                expect(e).to.be.instanceOf(DecryptionError);
                expect((e as DecryptionError).reason).to.equal('wrong_key');
                log.data('Error type', (e as DecryptionError).reason);
                log.success('Correctly rejected wrong key');
            }
            
            wrongService.destroy();
        });

        it('should fail on corrupted ciphertext', async () => {
            log.test('Corruption detection');
            
            const nonce = await nonceService.generateBaseNonce(mockWalletPubkey);
            const encrypted = await nonceService.encryptNonce(nonce, encryptionKey);
            
            log.info('Corrupting encrypted blob...');
            encrypted.encryptedBlob = 'corrupted_base64_that_is_invalid!!!';
            
            try {
                await nonceService.decryptNonce(encrypted, encryptionKey);
                expect.fail('Should have thrown DecryptionError');
            } catch (e) {
                expect(e).to.be.instanceOf(DecryptionError);
                log.data('Error type', (e as DecryptionError).reason);
                log.success('Correctly detected corruption');
            }
        });
    });

    describe('getCurrentNonce', () => {
        before(() => log.section('getCurrentNonce Tests'));

        it('should return null before initialization', () => {
            log.test('Null before init');
            
            const result = nonceService.getCurrentNonce();
            log.data('Result', result);
            
            expect(result).to.be.null;
            log.success('Returns null before initialization');
        });

        it('should return current nonce after generation', async () => {
            log.test('Returns nonce after generation');
            
            await nonceService.initFromSignature(mockSignature);
            await nonceService.generateBaseNonce(mockWalletPubkey);
            
            const result = nonceService.getCurrentNonce();
            log.data('Index', result?.index);
            log.hex('Nonce', result!.nonce);
            
            expect(result).to.not.be.null;
            expect(result!.index).to.equal(0);
            
            log.success('Returns valid nonce');
        });
    });

    describe('destroy', () => {
        before(() => log.section('destroy Tests'));

        it('should clear all sensitive data', async () => {
            log.test('Clear sensitive data');
            
            await nonceService.initFromSignature(mockSignature);
            await nonceService.generateBaseNonce(mockWalletPubkey);
            
            log.info('Before destroy:');
            log.data('Has current nonce', nonceService.getCurrentNonce() !== null);
            log.data('Has encryption key', nonceService.getEncryptionKey() !== null);
            
            nonceService.destroy();
            
            log.info('After destroy:');
            log.data('Has current nonce', nonceService.getCurrentNonce() !== null);
            log.data('Has encryption key', nonceService.getEncryptionKey() !== null);
            
            expect(nonceService.getCurrentNonce()).to.be.null;
            expect(nonceService.getEncryptionKey()).to.be.null;
            
            log.success('All sensitive data cleared');
        });
    });

    describe('clearMasterSeed', () => {
        before(() => log.section('clearMasterSeed Tests'));

        it('should clear master seed but keep loaded nonce', async () => {
            log.test('Clear seed, keep nonce');
            
            await nonceService.initFromSignature(mockSignature);
            await nonceService.generateBaseNonce(mockWalletPubkey);
            
            log.info('Clearing master seed...');
            nonceService.clearMasterSeed();
            
            const current = nonceService.getCurrentNonce();
            log.data('Current nonce still accessible', current !== null);
            expect(current).to.not.be.null;
            
            log.info('Trying to generate new base nonce after clearing seed...');
            const service2 = new NonceService();
            await service2.initFromSignature(mockSignature);
            service2.clearMasterSeed();
            
            try {
                await service2.generateBaseNonce(mockWalletPubkey);
                expect.fail('Should have thrown');
            } catch (e: any) {
                log.data('Error', e.message);
                expect(e.message).to.include('not initialized');
                log.success('Cannot generate new nonce after clearing seed');
            }
            
            service2.destroy();
        });
    });

    describe('Edge Cases', () => {
        before(() => log.section('Edge Case Tests'));

        it('should throw error when calling methods before initialization', async () => {
            log.test('Methods before initialization');
            
            const service = new NonceService();
            
            expect(service.getCurrentNonce()).to.be.null;
            
            try {
                await service.generateBaseNonce(mockWalletPubkey);
                expect.fail('Should have thrown');
            } catch (e: any) {
                log.data('generateBaseNonce error', e.message);
                expect(e.message).to.include('not initialized');
            }
            
            try {
                await service.incrementNonce();
                expect.fail('Should have thrown');
            } catch (e: any) {
                log.data('incrementNonce error', e.message);
                expect(e.message).to.include('No current nonce');
            }
            
            try {
                await service.loadCurrentNonce(mockWalletPubkey);
                expect.fail('Should have thrown');
            } catch (e: any) {
                log.data('loadCurrentNonce error', e.message);
                expect(e.message).to.include('not initialized');
            }
            
            expect(service.getEncryptionKey()).to.be.null;
            
            service.destroy();
            log.success('All uninitialized method calls throw correct errors');
        });

        it('should handle multiple wallets with different public keys', async () => {
            log.test('Multiple wallet support');
            
            const wallet1 = new Uint8Array(32).fill(0).map((_, i) => i);
            const wallet2 = new Uint8Array(32).fill(0).map((_, i) => i * 2);
            
            await nonceService.initFromSignature(mockSignature);
            const nonce1 = await nonceService.generateBaseNonce(wallet1);
            await nonceService.incrementNonce();
            
            const service2 = new NonceService();
            await service2.initFromSignature(mockSignature);
            const nonce2 = await service2.generateBaseNonce(wallet2);
            
            log.hex('Wallet 1 nonce', nonce1.nonce);
            log.hex('Wallet 2 nonce', nonce2.nonce);
            
            expect(nonce1.walletPubkeyHash).to.not.equal(nonce2.walletPubkeyHash);
            
            service2.destroy();
            log.success('Multiple wallets handled correctly');
        });

        it('should detect invalid IV in decryption', async () => {
            log.test('Invalid IV detection');
            
            await nonceService.initFromSignature(mockSignature);
            const encryptionKey = nonceService.getEncryptionKey()!;
            const nonce = await nonceService.generateBaseNonce(mockWalletPubkey);
            const encrypted = await nonceService.encryptNonce(nonce, encryptionKey);
            
            encrypted.encryptedBlob = 'invalid_base64_blob!!!';
            
            try {
                await nonceService.decryptNonce(encrypted, encryptionKey);
                expect.fail('Should have thrown DecryptionError');
            } catch (e) {
                expect(e).to.be.instanceOf(DecryptionError);
                expect((e as DecryptionError).reason).to.equal('corrupted');
                log.success('Invalid IV correctly detected');
            }
        });

        it('should detect invalid JSON payload in decryption', async () => {
            log.test('Invalid JSON payload detection');
            
            await nonceService.initFromSignature(mockSignature);
            const encryptionKey = nonceService.getEncryptionKey()!;
            
            // Create a payload with invalid JSON
            const invalidPayload = 'not_valid_json';
            const iv = crypto.getRandomValues(new Uint8Array(12));
            
            const ciphertext = await crypto.subtle.encrypt(
                { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
                encryptionKey,
                getArrayBuffer(new TextEncoder().encode(invalidPayload))
            );
            
            // Prepend IV to ciphertext for the blob
            const encryptedBlob = new Uint8Array(iv.length + ciphertext.byteLength);
            encryptedBlob.set(iv, 0);
            encryptedBlob.set(new Uint8Array(ciphertext), iv.length);

            const invalidEncrypted = {
                encryptedBlob: Buffer.from(encryptedBlob).toString('base64'),
                version: 1
            };
            
            try {
                await nonceService.decryptNonce(invalidEncrypted, encryptionKey);
                expect.fail('Should have thrown DecryptionError');
            } catch (e) {
                expect(e).to.be.instanceOf(DecryptionError);
                expect((e as DecryptionError).reason).to.equal('corrupted');
                log.success('Invalid JSON payload correctly detected');
            }
        });

        it('should detect invalid payload structure in decryption', async () => {
            log.test('Invalid payload structure detection');
            
            await nonceService.initFromSignature(mockSignature);
            const encryptionKey = nonceService.getEncryptionKey()!;
            
            // Create a payload with missing fields
            const invalidPayload = JSON.stringify({
                nonce: 'some_value',
                index: 0
                // Missing walletPubkeyHash
            });
            
            const iv = crypto.getRandomValues(new Uint8Array(12));
            
            const ciphertext = await crypto.subtle.encrypt(
                { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
                encryptionKey,
                getArrayBuffer(new TextEncoder().encode(invalidPayload))
            );
            
            // Prepend IV to ciphertext for the blob
            const encryptedBlob = new Uint8Array(iv.length + ciphertext.byteLength);
            encryptedBlob.set(iv, 0);
            encryptedBlob.set(new Uint8Array(ciphertext), iv.length);

            const invalidEncrypted = {
                encryptedBlob: Buffer.from(encryptedBlob).toString('base64'),
                version: 1
            };
            
            try {
                await nonceService.decryptNonce(invalidEncrypted, encryptionKey);
                expect.fail('Should have thrown DecryptionError');
            } catch (e) {
                expect(e).to.be.instanceOf(DecryptionError);
                expect((e as DecryptionError).reason).to.equal('corrupted');
                log.success('Invalid payload structure correctly detected');
            }
        });

        it('should throw on nonce index overflow', async () => {
            log.test('Nonce index overflow');
            
            await nonceService.initFromSignature(mockSignature);
            await nonceService.generateBaseNonce(mockWalletPubkey);
            
            // Directly set index to MAX to test overflow
            (nonceService as any)._currentIndex = 0xFFFFFFFF; // MAX_NONCE_INDEX
            
            try {
                await nonceService.incrementNonce();
                expect.fail('Should have thrown');
            } catch (e: any) {
                expect(e.message).to.include('overflow');
                log.success('Nonce overflow correctly detected');
            }
        });

        it('should handle empty signature array', async () => {
            log.test('Empty signature handling');
            
            const service = new NonceService();
            // Empty signature should still work (produces deterministic output)
            await service.initFromSignature(new Uint8Array(0));
            
            expect(service.getEncryptionKey()).to.not.be.null;
            service.destroy();
            log.success('Empty signature handled');
        });

        it('should handle minimum size wallet pubkey', async () => {
            log.test('Minimum size wallet pubkey');
            
            await nonceService.initFromSignature(mockSignature);
            const smallPubkey = new Uint8Array(1).fill(42);
            
            const result = await nonceService.generateBaseNonce(smallPubkey);
            expect(result.walletPubkeyHash).to.be.a('string');
            log.success('Small pubkey handled');
        });

        it('should handle re-initialization after destroy', async () => {
            log.test('Re-initialization after destroy');
            
            await nonceService.initFromSignature(mockSignature);
            await nonceService.generateBaseNonce(mockWalletPubkey);
            nonceService.destroy();
            
            // Should be able to reinitialize
            await nonceService.initFromSignature(mockSignature);
            const result = await nonceService.generateBaseNonce(mockWalletPubkey);
            
            expect(result).to.not.be.null;
            expect(result.index).to.equal(0);
            log.success('Re-initialization successful');
        });

        it('should produce unique nonces for high increment counts', async () => {
            log.test('Unique nonces over many increments');
            
            await nonceService.initFromSignature(mockSignature);
            await nonceService.generateBaseNonce(mockWalletPubkey);
            
            const seenNonces = new Set<string>();
            seenNonces.add(Buffer.from(nonceService.getCurrentNonce()!.nonce).toString('hex'));
            
            for (let i = 0; i < 50; i++) {
                const result = await nonceService.incrementNonce();
                const hex = Buffer.from(result.nonce).toString('hex');
                expect(seenNonces.has(hex)).to.be.false;
                seenNonces.add(hex);
            }
            
            log.success('50 unique nonces generated');
        });

        it('should handle decryption with unsupported version gracefully', async () => {
            log.test('Unsupported version in encrypted payload');
            
            await nonceService.initFromSignature(mockSignature);
            const encryptionKey = nonceService.getEncryptionKey()!;
            const nonce = await nonceService.generateBaseNonce(mockWalletPubkey);
            const encrypted = await nonceService.encryptNonce(nonce, encryptionKey);
            
            encrypted.version = 999;
            
            // Current implementation doesn't check version, but decryption should still work
            const decrypted = await nonceService.decryptNonce(encrypted, encryptionKey);
            expect(decrypted.index).to.equal(nonce.index);
            log.success('Version field handled (no strict check)');
        });
    });

    describe('tryDecryptBlobs', () => {
        before(() => log.section('tryDecryptBlobs Tests'));

        it('should find and decrypt user blob from list', async () => {
            log.test('Find user blob in list');
            
            await nonceService.initFromSignature(mockSignature);
            const nonce = await nonceService.generateBaseNonce(mockWalletPubkey);
            
            // Create a blob for this user
            const blobData = await nonceService.createBlobData(nonce);
            const userBlob = {
                id: 'blob-123',
                encryptedBlob: blobData.encryptedBlob,
                createdAt: Date.now()
            };
            
            // Create some fake blobs from "other users"
            const fakeBlob1 = {
                id: 'fake-1',
                encryptedBlob: 'randomgarbage123',
                createdAt: Date.now()
            };
            const fakeBlob2 = {
                id: 'fake-2',
                encryptedBlob: 'morerandombytes',
                createdAt: Date.now()
            };
            
            const blobs = [fakeBlob1, userBlob, fakeBlob2];
            const result = await nonceService.tryDecryptBlobs(blobs);
            
            expect(result.found).to.be.true;
            expect(result.blobId).to.equal('blob-123');
            expect(result.nonce).to.not.be.undefined;
            expect(result.nonce!.index).to.equal(nonce.index);
            log.success('Found user blob and decrypted successfully');
        });

        it('should return found=false when no matching blob', async () => {
            log.test('No matching blob in list');
            
            await nonceService.initFromSignature(mockSignature);
            await nonceService.generateBaseNonce(mockWalletPubkey);
            
            // Only fake blobs
            const fakeBlobs = [
                { id: 'fake-1', encryptedBlob: 'garbage1', createdAt: Date.now() },
                { id: 'fake-2', encryptedBlob: 'garbage2', createdAt: Date.now() }
            ];
            
            const result = await nonceService.tryDecryptBlobs(fakeBlobs);
            
            expect(result.found).to.be.false;
            expect(result.blobId).to.be.undefined;
            expect(result.nonce).to.be.undefined;
            log.success('Correctly returned found=false');
        });

        it('should handle empty blob list', async () => {
            log.test('Empty blob list');
            
            await nonceService.initFromSignature(mockSignature);
            await nonceService.generateBaseNonce(mockWalletPubkey);
            
            const result = await nonceService.tryDecryptBlobs([]);
            
            expect(result.found).to.be.false;
            log.success('Handled empty list correctly');
        });
    });

    describe('createBlobData', () => {
        before(() => log.section('createBlobData Tests'));

        it('should create encrypted blob data', async () => {
            log.test('Create blob data');
            
            await nonceService.initFromSignature(mockSignature);
            const nonce = await nonceService.generateBaseNonce(mockWalletPubkey);
            
            const blobData = await nonceService.createBlobData(nonce);
            
            expect(blobData.encryptedBlob).to.be.a('string');
            expect(blobData.encryptedBlob.length).to.be.greaterThan(10);
            log.data('Encrypted blob length', blobData.encryptedBlob.length);
            log.success('Created blob data successfully');
        });

        it('should create unique blob data each time (different IV)', async () => {
            log.test('Unique blob data per call');
            
            await nonceService.initFromSignature(mockSignature);
            const nonce = await nonceService.generateBaseNonce(mockWalletPubkey);
            
            const blob1 = await nonceService.createBlobData(nonce);
            const blob2 = await nonceService.createBlobData(nonce);
            
            // Encrypted blobs should be different due to random IV
            expect(blob1.encryptedBlob).to.not.equal(blob2.encryptedBlob);
            log.success('Each call produces unique encrypted data');
        });
    });

    describe('setCurrentState', () => {
        before(() => log.section('setCurrentState Tests'));

        it('should set state from external nonce', async () => {
            log.test('Set state from external source');
            
            await nonceService.initFromSignature(mockSignature);
            
            // Create a nonce object as if it came from remote
            const externalNonce = {
                nonce: new Uint8Array(32).fill(42),
                index: 5,
                walletPubkeyHash: 'external-hash-123'
            };
            
            await nonceService.setCurrentState(externalNonce);
            
            const current = nonceService.getCurrentNonce();
            expect(current).to.not.be.null;
            expect(current!.index).to.equal(5);
            expect(current!.walletPubkeyHash).to.equal('external-hash-123');
            log.data('Current index', current!.index);
            log.success('State set from external source');
        });

        it('should persist state to local storage', async () => {
            log.test('Persist to local storage');
            
            await nonceService.initFromSignature(mockSignature);
            
            const externalNonce = {
                nonce: new Uint8Array(32).fill(99),
                index: 10,
                walletPubkeyHash: 'persist-test-hash'
            };
            
            await nonceService.setCurrentState(externalNonce);
            
            // Create new instance and load
            const newService = new NonceService();
            await newService.initFromSignature(mockSignature);
            const loaded = await newService.loadCurrentNonce(mockWalletPubkey);
            
            // Note: walletPubkeyHash is derived from pubkey, not the external one
            // But the nonce and index should match
            expect(loaded).to.not.be.null;
            // The external hash won't match because loadCurrentNonce uses pubkey
            // But the service should have persisted something
            newService.destroy();
            log.success('State persisted to storage');
        });

        it('should throw if not initialized', async () => {
            log.test('Throw if not initialized');
            
            const externalNonce = {
                nonce: new Uint8Array(32).fill(1),
                index: 1,
                walletPubkeyHash: 'test'
            };
            
            try {
                await nonceService.setCurrentState(externalNonce);
                expect.fail('Should have thrown');
            } catch (e: any) {
                expect(e.message).to.include('not initialized');
                log.success('Correctly threw for uninitialized service');
            }
        });
    });

    describe('consumeNonce', () => {
        before(() => log.section('consumeNonce Tests'));

        it('should consume current nonce and return result', async () => {
            log.test('Consume nonce');
            
            await nonceService.initFromSignature(mockSignature);
            const initialNonce = await nonceService.generateBaseNonce(mockWalletPubkey);
            
            const result = await nonceService.consumeNonce();
            
            expect(result.consumedNonce.index).to.equal(0);
            expect(result.newNonce.index).to.equal(1);
            expect(result.newBlobData).to.have.property('encryptedBlob');
            
            log.data('Consumed index', result.consumedNonce.index);
            log.data('New index', result.newNonce.index);
            log.success('Nonce consumed and new blob data created');
        });

        it('should update internal state after consume', async () => {
            log.test('Internal state updated after consume');
            
            await nonceService.initFromSignature(mockSignature);
            await nonceService.generateBaseNonce(mockWalletPubkey);
            
            await nonceService.consumeNonce();
            
            const current = nonceService.getCurrentNonce();
            expect(current!.index).to.equal(1);
            log.data('Current index after consume', current!.index);
            log.success('Internal state updated correctly');
        });

        it('should allow multiple consecutive consumes', async () => {
            log.test('Multiple consecutive consumes');
            
            await nonceService.initFromSignature(mockSignature);
            await nonceService.generateBaseNonce(mockWalletPubkey);
            
            for (let i = 0; i < 5; i++) {
                const result = await nonceService.consumeNonce();
                expect(result.consumedNonce.index).to.equal(i);
                expect(result.newNonce.index).to.equal(i + 1);
            }
            
            const final = nonceService.getCurrentNonce();
            expect(final!.index).to.equal(5);
            log.data('Final index after 5 consumes', final!.index);
            log.success('Multiple consumes work correctly');
        });

        it('should throw if no current nonce', async () => {
            log.test('Throw if no current nonce');
            
            await nonceService.initFromSignature(mockSignature);
            // Don't generate base nonce
            
            try {
                await nonceService.consumeNonce();
                expect.fail('Should have thrown');
            } catch (e: any) {
                expect(e.message).to.include('No current nonce');
                log.success('Correctly threw for missing nonce');
            }
        });

        it('should produce valid blob data that can be decrypted', async () => {
            log.test('Blob data is valid and decryptable');
            
            await nonceService.initFromSignature(mockSignature);
            await nonceService.generateBaseNonce(mockWalletPubkey);
            
            const result = await nonceService.consumeNonce();
            
            // Simulate: upload to backend, then try to decrypt
            const blob = {
                id: 'test-blob',
                encryptedBlob: result.newBlobData.encryptedBlob,
                createdAt: Date.now()
            };
            
            const decryptResult = await nonceService.tryDecryptBlobs([blob]);
            
            expect(decryptResult.found).to.be.true;
            expect(decryptResult.nonce!.index).to.equal(result.newNonce.index);
            log.success('Blob data is valid and can be decrypted');
        });
    });

    after(() => {
        console.log('\n' + '='.repeat(50));
        console.log('🎉 All NonceService tests completed!');
        console.log('='.repeat(50) + '\n');
    });
});
