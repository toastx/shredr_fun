# Shredr Tests

This directory contains unit tests for the Shredr library.

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

### Test Suites Breakdown

| Suite | Description | Test Count |
|-------|-------------|------------|
| `initFromSignature` | Initialization from wallet signature | 4 |
| `getEncryptionKey` | Encryption key access | 3 |
| `loadCurrentNonce` | Loading from local storage | 4 |
| `generateBaseNonce` | Creating first nonce | 4 |
| `incrementNonce` | Nonce chaining | 5 |
| `encryptNonce/decryptNonce` | Encryption round-trips | 6 |
| `Edge Cases` | Overflow, empty inputs, etc. | 8 |
| `tryDecryptBlobs` | Finding user's blob in list | 3 |
| `createBlobData` | Creating encrypted blob | 2 |
| `setCurrentState` | Setting state from external | 3 |
| `consumeNonce` | Consume and create blob data | 5 |

## Future Tests (Nice-to-Have)

| Test Area | Why |
|-----------|-----|
| Concurrent access | Multiple tabs scenario |
| Storage corruption recovery | Robustness |
| Large blob lists (100+ blobs) | Performance testing |
| BurnerService | Currently no tests |
| Integration tests | Full end-to-end flow |

## Test Structure

```
tests/
├── setup.ts              # Test environment setup (IndexedDB polyfill)
├── NonceService.test.ts  # NonceService unit tests
└── README.md             # This file
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
};
```

Example test:

```typescript
it('should do something', async () => {
    log.test('Test description');
    
    // Setup
    await nonceService.initFromSignature(mockSignature);
    
    // Action
    const result = await nonceService.someMethod();
    
    // Assert
    expect(result).to.equal(expected);
    log.success('Test passed!');
});
```
