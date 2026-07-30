# Shredr Tests

This directory contains unit and integration tests for the Shredr library.

## Running Tests

```bash
npm test
```

## Test Framework

- **Mocha** - Test runner
- **Chai** - Assertions
- **fake-indexeddb** - IndexedDB polyfill for Node.js

## Test Coverage

### NonceService (41 tests)

| Area | Tests | Status |
|------|-------|--------|
| `initFromSignature` | ✅ Multiple | Covered |
| `getEncryptionKey` | ✅ Multiple | Covered |
| `loadCurrentNonce` | ✅ Multiple | Covered |
| `generateBaseNonce` | ✅ Multiple | Covered |
| `incrementNonce` | ✅ Multiple | Covered |
| `encryptNonce/decryptNonce` | ✅ Multiple | Covered |
| `tryDecryptBlobs` | ✅ 3 tests | Covered |
| `createBlobData` | ✅ 2 tests | Covered |
| `setCurrentState` | ✅ 3 tests | Covered |
| `consumeNonce` | ✅ 5 tests | Covered |
| Edge cases | ✅ Multiple | Covered |

### BurnerService (25+ tests)

| Area | Tests | Status |
|------|-------|--------|
| `initFromSignature` | ✅ 2 tests | Covered |
| `deriveBurnerFromNonce` | ✅ 5 tests | Covered |
| `clearBurner` | ✅ 2 tests | Covered |
| `recoverBurners` | ✅ 3 tests | Covered |
| `destroy` | ✅ 2 tests | Covered |
| Edge cases | ✅ Multiple | Covered |

### ShredrProgram (20 tests)

Pins the client's wire format against the on-chain program, so a program
change that is not regenerated into `src/generated` fails here instead of on
devnet.

| Area | Tests | Status |
|------|-------|--------|
| Program ID and instruction discriminators | ✅ 2 tests | Covered |
| `deriveStealthPDA` (salt-free, cross-checked with the generated PDA finder) | ✅ 2 tests | Covered |
| `InitializeAndDelegate` data + 9 accounts | ✅ 4 tests | Covered |
| `PrivateTransfer` burner authorization | ✅ 2 tests | Covered |
| `CommitStealth` / `CommitAndUndelegateStealth` | ✅ 2 tests | Covered |
| `Withdraw` data + accounts | ✅ 2 tests | Covered |
| `parseStealthAccount` layout and rejections | ✅ 4 tests | Covered |
| `getShredrErrorMessage` | ✅ 2 tests | Covered |

### Integration Flow Tests (Complete 5-Phase Flow)

| Phase | Description | Status |
|-------|-------------|--------|
| Phase 1 | Initialization (wallet signature → service init) | ✅ Covered |
| Phase 2 | Nonce State Resolution (local → remote → new) | ✅ Covered |
| Phase 3 | Burner Wallet Derivation | ✅ Covered |
| Phase 4 | Nonce Consumption & Backend Sync | ✅ Covered |
| Phase 5 | Cleanup (memory zeroing) | ✅ Covered |

**Additional Integration Scenarios:**
- ✅ Returning user (same device, local data)
- ✅ New device (sync from remote)
- ✅ Deterministic recovery (same sig → same burner)
- ✅ Forward-secret nonce chain (SHA256 verification)
- ✅ Multiple burner generation
- ✅ Error handling

## Test Suites Breakdown

| Suite | Description | Test Count |
|-------|-------------|------------|
| `NonceService.initFromSignature` | Initialization from wallet signature | 4 |
| `NonceService.getEncryptionKey` | Encryption key access | 3 |
| `NonceService.loadCurrentNonce` | Loading from local storage | 4 |
| `NonceService.generateBaseNonce` | Creating first nonce | 4 |
| `NonceService.incrementNonce` | Nonce chaining | 5 |
| `NonceService.encryptNonce/decryptNonce` | Encryption round-trips | 6 |
| `NonceService.Edge Cases` | Overflow, empty inputs, etc. | 8 |
| `NonceService.tryDecryptBlobs` | Finding user's blob in list | 3 |
| `NonceService.createBlobData` | Creating encrypted blob | 2 |
| `NonceService.setCurrentState` | Setting state from external | 3 |
| `NonceService.consumeNonce` | Consume and create blob data | 5 |
| `BurnerService.initFromSignature` | Initialization | 2 |
| `BurnerService.deriveBurnerFromNonce` | Keypair derivation | 5 |
| `BurnerService.clearBurner` | Memory cleanup | 2 |
| `BurnerService.recoverBurners` | Recovery with on-chain check | 3 |
| `BurnerService.destroy` | Full cleanup | 2 |
| `Integration.Complete New User Flow` | Full 5-phase flow | 1 |
| `Integration.Returning User` | Local data reload | 1 |
| `Integration.New Device Sync` | Remote sync | 1 |
| `Integration.Deterministic Recovery` | Same sig → same burner | 2 |
| `Integration.Multiple Burners` | Unique burner generation | 1 |
| `Integration.Error Handling` | Graceful failures | 2 |
| `ShredrProgram.constants` | Program ID and discriminators | 2 |
| `ShredrProgram.deriveStealthPDA` | PDA seeds | 2 |
| `ShredrProgram.createInitializeAndDelegateInstruction` | Data and account metas | 4 |
| `ShredrProgram.createPrivateTransferInstruction` | Burner-authorized transfer | 2 |
| `ShredrProgram.commit instructions` | MagicBlock accounts | 2 |
| `ShredrProgram.createStealthWithdrawInstruction` | Data and account metas | 2 |
| `ShredrProgram.parseStealthAccount` | Account layout | 4 |
| `ShredrProgram.getShredrErrorMessage` | Custom error codes | 2 |

## Future Tests (Nice-to-Have)

| Test Area | Why |
|-----------|-----|
| Concurrent access | Multiple tabs scenario |
| Storage corruption recovery | Robustness |
| Large blob lists (100+ blobs) | Performance testing |
| StorageService unit tests | Direct storage layer testing |

## Test Structure

```
tests/
├── setup.ts                  # Test environment setup (IndexedDB, crypto polyfill)
├── NonceService.test.ts      # NonceService unit tests (41 tests)
├── BurnerService.test.ts     # BurnerService unit tests (25+ tests)
├── IntegrationFlow.test.ts   # Full flow integration tests
└── README.md                 # This file
```

## Writing New Tests

Tests use pretty logging for readability:

```typescript
const log = {
    section: (name: string) => console.log(`\n${'='.repeat(50)}\n📋 ${name}\n${'='.repeat(50)}`),
    test: (name: string) => console.log(`\n  🧪 ${name}`),
    info: (msg: string) => console.log(`     ℹ️  ${msg}`),
    success: (msg: string) => console.log(`     ✅ ${msg}`),
    data: (label: string, value: any) => console.log(`     📊 ${label}: ${value}`),
    hex: (label: string, arr: Uint8Array) => console.log(`     🔐 ${label}: ${Buffer.from(arr).toString('hex').slice(0, 32)}...`),
    address: (label: string, addr: string) => console.log(`     💳 ${label}: ${addr}`),
};
```

Example test:

```typescript
it('should derive burner from nonce', async () => {
    log.test('Derive valid Solana keypair');
    
    // Setup
    await nonceService.initFromSignature(mockSignature);
    await burnerService.initFromSignature(mockSignature);
    
    // Action
    const nonce = await nonceService.generateBaseNonce(mockWalletPubkey);
    const burner = await burnerService.deriveBurnerFromNonce(nonce);
    
    // Assert
    expect(burner.address).to.be.a('string');
    expect(burner.publicKey.length).to.equal(32);
    log.success('Valid Solana keypair derived');
});
```

## Test Isolation

Each integration test uses a **unique wallet pubkey** to avoid data collisions from IndexedDB persistence across test runs:

```typescript
// Each test gets its own isolated data
const newUserWalletPubkey = new Uint8Array(32).fill(0).map((_, i) => (i * 31 + 200) % 256);
const returningUserWallet = new Uint8Array(32).fill(0).map((_, i) => (i * 41 + 100) % 256);
// etc.
```
