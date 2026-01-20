/**
 * Unit tests for BurnerService
 */

import './setup';
import { expect } from 'chai';
import { BurnerService } from '../src/lib/BurnerService';
import { NonceService } from '../src/lib/NonceService';
import type { GeneratedNonce } from '../src/lib/types';

// ============ PRETTY LOGGING ============
const log = {
    section: (name: string) => console.log(`\n${'='.repeat(50)}\n📋 ${name}\n${'='.repeat(50)}`),
    test: (name: string) => console.log(`\n  🧪 ${name}`),
    info: (msg: string) => console.log(`     ℹ️  ${msg}`),
    success: (msg: string) => console.log(`     ✅ ${msg}`),
    data: (label: string, value: any) => console.log(`     📊 ${label}: ${typeof value === 'object' ? JSON.stringify(value) : value}`),
    hex: (label: string, arr: Uint8Array) => console.log(`     🔐 ${label}: ${Buffer.from(arr).toString('hex').slice(0, 32)}...`),
};

describe('BurnerService', () => {
    let burnerService: BurnerService;
    let nonceService: NonceService;
    
    // Mock wallet signature (64 bytes like a real ed25519 signature)
    const mockSignature = new Uint8Array(64).fill(0).map((_, i) => i % 256);
    
    // Mock wallet public key (32 bytes)
    const mockWalletPubkey = new Uint8Array(32).fill(0).map((_, i) => (i * 7) % 256);

    before(() => {
        log.section('BurnerService Unit Tests');
        log.info(`Mock signature: ${Buffer.from(mockSignature).toString('hex').slice(0, 32)}...`);
        log.info(`Mock wallet pubkey: ${Buffer.from(mockWalletPubkey).toString('hex').slice(0, 32)}...`);
    });

    beforeEach(async () => {
        burnerService = new BurnerService();
        nonceService = new NonceService();
        await nonceService.initFromSignature(mockSignature);
    });

    afterEach(() => {
        burnerService.destroy();
        nonceService.destroy();
    });

    describe('initFromSignature', () => {
        before(() => log.section('initFromSignature Tests'));

        it('should initialize from a valid signature', async () => {
            log.test('Initialize from valid signature');
            
            expect(burnerService.isInitialized).to.be.false;
            log.data('Before init isInitialized', burnerService.isInitialized);
            
            await burnerService.initFromSignature(mockSignature);
            
            expect(burnerService.isInitialized).to.be.true;
            log.data('After init isInitialized', burnerService.isInitialized);
            log.success('Service initialized successfully');
        });

        it('should derive different seeds from different signatures', async () => {
            log.test('Different signatures → different burner seeds');
            
            const service1 = new BurnerService();
            const service2 = new BurnerService();
            
            const sig1 = new Uint8Array(64).fill(1);
            const sig2 = new Uint8Array(64).fill(2);
            
            log.info('Signature 1: all 0x01 bytes');
            log.info('Signature 2: all 0x02 bytes');
            
            await service1.initFromSignature(sig1);
            await service2.initFromSignature(sig2);
            
            // Create matching nonces for comparison
            const nonce1Service = new NonceService();
            const nonce2Service = new NonceService();
            await nonce1Service.initFromSignature(sig1);
            await nonce2Service.initFromSignature(sig2);
            
            const nonce1 = await nonce1Service.generateBaseNonce(mockWalletPubkey);
            const nonce2 = await nonce2Service.generateBaseNonce(mockWalletPubkey);
            
            const burner1 = await service1.deriveBurnerFromNonce(nonce1);
            const burner2 = await service2.deriveBurnerFromNonce(nonce2);
            
            log.data('Burner address from sig1', burner1.address);
            log.data('Burner address from sig2', burner2.address);
            
            expect(burner1.address).to.not.equal(burner2.address);
            log.success('Different signatures produce different burner addresses ✓');
            
            service1.destroy();
            service2.destroy();
            nonce1Service.destroy();
            nonce2Service.destroy();
        });
    });

    describe('deriveBurnerFromNonce', () => {
        before(() => log.section('deriveBurnerFromNonce Tests'));

        beforeEach(async () => {
            await burnerService.initFromSignature(mockSignature);
        });

        it('should derive a valid Solana keypair from nonce', async () => {
            log.test('Derive valid Solana keypair');
            
            const nonce = await nonceService.generateBaseNonce(mockWalletPubkey);
            log.hex('Input nonce', nonce.nonce);
            
            const burner = await burnerService.deriveBurnerFromNonce(nonce);
            
            log.data('Address', burner.address);
            log.data('Public key length', burner.publicKey.length);
            log.data('Secret key length', burner.secretKey.length);
            log.data('Nonce index', burner.nonceIndex);
            
            expect(burner.publicKey).to.be.instanceOf(Uint8Array);
            expect(burner.publicKey.length).to.equal(32);
            expect(burner.secretKey).to.be.instanceOf(Uint8Array);
            expect(burner.secretKey.length).to.equal(64);
            expect(burner.address).to.be.a('string');
            expect(burner.address.length).to.be.greaterThan(30); // Base58 Solana addresses
            expect(burner.nonceIndex).to.equal(0);
            
            log.success('Valid Solana keypair derived');
        });

        it('should derive deterministic keypair from same nonce', async () => {
            log.test('Deterministic derivation');
            
            const nonce = await nonceService.generateBaseNonce(mockWalletPubkey);
            
            const burner1 = await burnerService.deriveBurnerFromNonce(nonce);
            log.data('First derivation address', burner1.address);
            
            // Create new service with same signature
            const service2 = new BurnerService();
            await service2.initFromSignature(mockSignature);
            
            const burner2 = await service2.deriveBurnerFromNonce(nonce);
            log.data('Second derivation address', burner2.address);
            
            expect(burner1.address).to.equal(burner2.address);
            expect(Buffer.from(burner1.publicKey).toString('hex'))
                .to.equal(Buffer.from(burner2.publicKey).toString('hex'));
            
            log.success('Same nonce → same burner address ✓');
            
            service2.destroy();
        });

        it('should derive different keypairs from different nonces', async () => {
            log.test('Different nonces → different keypairs');
            
            const nonce0 = await nonceService.generateBaseNonce(mockWalletPubkey);
            const nonce1 = await nonceService.incrementNonce();
            const nonce2 = await nonceService.incrementNonce();
            
            const burner0 = await burnerService.deriveBurnerFromNonce(nonce0);
            const burner1 = await burnerService.deriveBurnerFromNonce(nonce1);
            const burner2 = await burnerService.deriveBurnerFromNonce(nonce2);
            
            log.data('Burner at index 0', burner0.address);
            log.data('Burner at index 1', burner1.address);
            log.data('Burner at index 2', burner2.address);
            
            expect(burner0.address).to.not.equal(burner1.address);
            expect(burner1.address).to.not.equal(burner2.address);
            expect(burner0.address).to.not.equal(burner2.address);
            
            log.success('Each nonce produces unique burner ✓');
        });

        it('should throw error when not initialized', async () => {
            log.test('Error when not initialized');
            
            const uninitService = new BurnerService();
            const nonce = await nonceService.generateBaseNonce(mockWalletPubkey);
            
            try {
                await uninitService.deriveBurnerFromNonce(nonce);
                expect.fail('Should have thrown');
            } catch (e: any) {
                log.data('Error message', e.message);
                expect(e.message).to.include('not initialized');
                log.success('Correct error thrown');
            }
            
            uninitService.destroy();
        });

        it('should preserve nonce data in burner result', async () => {
            log.test('Nonce data preserved in result');
            
            const nonce = await nonceService.generateBaseNonce(mockWalletPubkey);
            await nonceService.incrementNonce();
            await nonceService.incrementNonce();
            const nonce2 = await nonceService.incrementNonce();
            
            const burner = await burnerService.deriveBurnerFromNonce(nonce2);
            
            log.data('Nonce index', nonce2.index);
            log.data('Burner nonceIndex', burner.nonceIndex);
            
            expect(burner.nonceIndex).to.equal(3);
            expect(Buffer.from(burner.nonce).toString('hex'))
                .to.equal(Buffer.from(nonce2.nonce).toString('hex'));
            
            log.success('Nonce data correctly preserved');
        });
    });

    describe('clearBurner', () => {
        before(() => log.section('clearBurner Tests'));

        beforeEach(async () => {
            await burnerService.initFromSignature(mockSignature);
        });

        it('should zero the secret key from memory', async () => {
            log.test('Zero secret key');
            
            const nonce = await nonceService.generateBaseNonce(mockWalletPubkey);
            const burner = await burnerService.deriveBurnerFromNonce(nonce);
            
            log.info('Before clearing:');
            log.data('Secret key first byte', burner.secretKey[0]);
            log.data('Secret key non-zero bytes', burner.secretKey.filter(b => b !== 0).length);
            
            const hadNonZeroBytes = burner.secretKey.some(b => b !== 0);
            expect(hadNonZeroBytes).to.be.true;
            
            burnerService.clearBurner(burner);
            
            log.info('After clearing:');
            log.data('Secret key first byte', burner.secretKey[0]);
            log.data('Secret key non-zero bytes', burner.secretKey.filter(b => b !== 0).length);
            
            const allZero = burner.secretKey.every(b => b === 0);
            expect(allZero).to.be.true;
            
            log.success('Secret key zeroed from memory');
        });

        it('should not affect public key or address', async () => {
            log.test('Public key preserved after clear');
            
            const nonce = await nonceService.generateBaseNonce(mockWalletPubkey);
            const burner = await burnerService.deriveBurnerFromNonce(nonce);
            
            const addressBefore = burner.address;
            const publicKeyHexBefore = Buffer.from(burner.publicKey).toString('hex');
            
            burnerService.clearBurner(burner);
            
            expect(burner.address).to.equal(addressBefore);
            expect(Buffer.from(burner.publicKey).toString('hex')).to.equal(publicKeyHexBefore);
            
            log.success('Public key and address preserved');
        });
    });

    describe('recoverBurners', () => {
        before(() => log.section('recoverBurners Tests'));

        beforeEach(async () => {
            await burnerService.initFromSignature(mockSignature);
        });

        it('should recover burners with on-chain activity', async () => {
            log.test('Recover burners with activity');
            
            // Mock nonce generator
            const generateNonceAtIndex = async (index: number): Promise<GeneratedNonce> => {
                const tempService = new NonceService();
                await tempService.initFromSignature(mockSignature);
                let nonce = await tempService.generateBaseNonce(mockWalletPubkey);
                for (let i = 0; i < index; i++) {
                    nonce = await tempService.incrementNonce();
                }
                tempService.destroy();
                return nonce;
            };
            
            // Mock: indices 0, 2, 3 have activity
            const activeIndices = new Set([0, 2, 3]);
            const checkOnChainActivity = async (address: string): Promise<boolean> => {
                // Derive the index from address somehow - we'll track by order
                return false; // Will be overridden below
            };
            
            // Track which addresses we check
            let checkIndex = 0;
            const mockCheckActivity = async (_address: string): Promise<boolean> => {
                const hasActivity = activeIndices.has(checkIndex);
                checkIndex++;
                return hasActivity;
            };
            
            const result = await burnerService.recoverBurners(
                generateNonceAtIndex,
                mockCheckActivity,
                20 // Max index
            );
            
            log.data('Recovered count', result.burners.length);
            log.data('Recovered indices', result.recoveredIndices);
            
            expect(result.burners.length).to.equal(3);
            expect(result.recoveredIndices).to.deep.equal([0, 2, 3]);
            
            log.success('Recovered correct burners');
        });

        it('should stop after consecutive empty threshold', async () => {
            log.test('Early termination on empty addresses');
            
            const generateNonceAtIndex = async (index: number): Promise<GeneratedNonce> => {
                const tempService = new NonceService();
                await tempService.initFromSignature(mockSignature);
                let nonce = await tempService.generateBaseNonce(mockWalletPubkey);
                for (let i = 0; i < index; i++) {
                    nonce = await tempService.incrementNonce();
                }
                tempService.destroy();
                return nonce;
            };
            
            // Only index 0 has activity, then 10+ empty
            let checkCount = 0;
            const mockCheckActivity = async (_address: string): Promise<boolean> => {
                const result = checkCount === 0;
                checkCount++;
                return result;
            };
            
            const result = await burnerService.recoverBurners(
                generateNonceAtIndex,
                mockCheckActivity,
                100
            );
            
            log.data('Total checks performed', checkCount);
            log.data('Recovered count', result.burners.length);
            
            // Should have stopped after CONSECUTIVE_EMPTY_THRESHOLD (10) consecutive empties
            expect(checkCount).to.be.lessThan(20);
            expect(result.burners.length).to.equal(1);
            
            log.success('Early termination worked correctly');
        });

        it('should throw if not initialized', async () => {
            log.test('Error when not initialized');
            
            const uninitService = new BurnerService();
            
            try {
                await uninitService.recoverBurners(
                    async () => ({ nonce: new Uint8Array(32), index: 0, walletPubkeyHash: 'test' }),
                    async () => false,
                    10
                );
                expect.fail('Should have thrown');
            } catch (e: any) {
                log.data('Error message', e.message);
                expect(e.message).to.include('not initialized');
                log.success('Correct error thrown');
            }
            
            uninitService.destroy();
        });
    });

    describe('destroy', () => {
        before(() => log.section('destroy Tests'));

        it('should clear burner seed', async () => {
            log.test('Clear burner seed on destroy');
            
            await burnerService.initFromSignature(mockSignature);
            expect(burnerService.isInitialized).to.be.true;
            log.data('Before destroy isInitialized', burnerService.isInitialized);
            
            burnerService.destroy();
            
            expect(burnerService.isInitialized).to.be.false;
            log.data('After destroy isInitialized', burnerService.isInitialized);
            
            log.success('Burner seed cleared');
        });

        it('should allow re-initialization after destroy', async () => {
            log.test('Re-initialization after destroy');
            
            await burnerService.initFromSignature(mockSignature);
            const nonce = await nonceService.generateBaseNonce(mockWalletPubkey);
            const burner1 = await burnerService.deriveBurnerFromNonce(nonce);
            
            burnerService.destroy();
            
            await burnerService.initFromSignature(mockSignature);
            const burner2 = await burnerService.deriveBurnerFromNonce(nonce);
            
            expect(burner1.address).to.equal(burner2.address);
            log.success('Re-initialization produces same results');
        });
    });

    describe('Edge Cases', () => {
        before(() => log.section('Edge Case Tests'));

        beforeEach(async () => {
            await burnerService.initFromSignature(mockSignature);
        });

        it('should handle empty signature', async () => {
            log.test('Empty signature handling');
            
            const service = new BurnerService();
            await service.initFromSignature(new Uint8Array(0));
            
            expect(service.isInitialized).to.be.true;
            
            const nonce = await nonceService.generateBaseNonce(mockWalletPubkey);
            const burner = await service.deriveBurnerFromNonce(nonce);
            
            expect(burner.address).to.be.a('string');
            log.success('Empty signature handled');
            
            service.destroy();
        });

        it('should generate many unique burners', async () => {
            log.test('Generate 50 unique burners');
            
            const seenAddresses = new Set<string>();
            let nonce = await nonceService.generateBaseNonce(mockWalletPubkey);
            
            for (let i = 0; i < 50; i++) {
                const burner = await burnerService.deriveBurnerFromNonce(nonce);
                expect(seenAddresses.has(burner.address)).to.be.false;
                seenAddresses.add(burner.address);
                
                if (i < 49) {
                    nonce = await nonceService.incrementNonce();
                }
            }
            
            log.data('Unique addresses generated', seenAddresses.size);
            expect(seenAddresses.size).to.equal(50);
            log.success('50 unique burner addresses generated');
        });

        it('should produce valid Base58 Solana addresses', async () => {
            log.test('Valid Base58 addresses');
            
            const nonce = await nonceService.generateBaseNonce(mockWalletPubkey);
            const burner = await burnerService.deriveBurnerFromNonce(nonce);
            
            // Solana addresses are Base58 encoded, typically 32-44 characters
            const base58Regex = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
            
            log.data('Address', burner.address);
            log.data('Address length', burner.address.length);
            
            expect(burner.address).to.match(base58Regex);
            log.success('Valid Base58 Solana address');
        });
    });
});
