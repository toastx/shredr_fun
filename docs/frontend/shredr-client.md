---
description: "The orchestrator that ties signature, burners, and on-chain flow together."
icon: circle-nodes
---

# ShredrClient

`src/lib/ShredrClient.ts` — the only module the UI talks to directly. It coordinates every other service and exposes the complete flow as a handful of methods.

```typescript
import { shredrClient } from './lib';
```

## What it holds

| Field | Meaning |
|---|---|
| `_currentNonce` | Position in the nonce chain |
| `_currentBurner` | Burner for that position — its pubkey is your receive address |
| `_stealthPda` | PDA derived from the current burner |
| `_mainBurner` | Permanent burner that owns the consolidation account |
| `_mainPda` | The consolidation account |
| `_walletPubkey` | Connected wallet pubkey (for hashing, never signs on-chain) |
| `_currentBlobId` | Backend blob ID for the current state |
| `_connection` | Base-layer RPC (lazy) |
| `_rollupConnection` | MagicBlock rollup RPC (lazy) |

## Getters

```typescript
shredrClient.initialized          // boolean
shredrClient.receiveAddress       // ← give THIS to senders (burner pubkey)
shredrClient.stealthAddress       // current stealth PDA
shredrClient.mainBurnerAddress    // permanent burner pubkey
shredrClient.mainPdaAddress       // consolidation account
shredrClient.currentBurner        // full BurnerKeyPair
shredrClient.signingMode          // "auto" | "manual"
shredrClient.isNewUser            // set during init
shredrClient.state                // everything above as one object
```

{% hint style="danger" %}
**`receiveAddress` returns the burner pubkey, not the stealth PDA.** The program requires the PDA to be empty when created, so a deposit sent there directly would permanently block initialization for that burner.

→ [Burners and stealth PDAs](../concepts/burners-and-stealth-pdas.md)
{% endhint %}

Several deprecated aliases exist for older UI code — `shadowireAddress`, `stealthBurner`, `shadowireBurner`, `getShadowireBalance()`. Do not use them in new code.

## Initialization

```typescript
await shredrClient.initFromSignature(signature, walletPubkeyBytes);
```

{% stepper %}
{% step %}
### Initialize crypto services

`nonceService.initFromSignature()` and `burnerService.initFromSignature()` derive the master seeds and the storage key.
{% endstep %}

{% step %}
### Derive the main burner and PDA

Directly from the signature — independent of the nonce chain, so it is always the same.
{% endstep %}

{% step %}
### Resolve nonce state

IndexedDB first. If empty, download backend blobs and try to decrypt each; use the highest index that succeeds. If neither works, generate the base nonce, increment to index 1, mark `isNewUser`, and upload the first blob.
{% endstep %}

{% step %}
### Derive the current burner and stealth PDA

From the resolved nonce. `initialized` becomes `true`.
{% endstep %}
{% endstepper %}

Both network functions are injectable, which is how the integration tests run without a backend:

```typescript
await shredrClient.initFromSignature(
  signature, walletPubkey,
  async () => mockBlobs,           // fetchBlobsFn
  async (data) => ({ id: "test" }) // createBlobFn
);
```

### Checking first

```typescript
const isNew = await shredrClient.checkIfNewUser(signature, walletPubkey);
```

Runs the same resolution without side effects, so the UI can branch before committing.

## Rotation

```typescript
const newBurner = await shredrClient.consumeAndGenerateNew();
```

Zeroes the old burner's key, advances the chain, uploads a new blob, deletes the old one, and derives the new burner. Blob operations only warn on failure — local state is already correct.

## The shred

```typescript
const result = await shredrClient.shredBurner();  // defaults to current burner
```

Returns:

```typescript
{
  burnerAddress: string,
  stealthPda: string,
  lamports: number,
  signatures: {
    initializeAndDelegate: string,
    initializeMainPda: string | null,   // null when already delegated
    privateTransfer: string,
    commitAndUndelegate: string,
  }
}
```

Throws if the burner has no balance. Note it does **not** rotate — call `consumeAndGenerateNew()` afterwards.

### The individual steps

Exposed separately for debugging or custom flows:

```typescript
await shredrClient.initializeAndDelegate(burner?, depositAmount?);
await shredrClient.ensureMainPdaDelegated();      // null if already delegated
await shredrClient.privateTransferToMainPda(sourceBurner, amountLamports);
await shredrClient.commitAndUndelegate(stealthPda);
await shredrClient.waitForUndelegation(stealthPda, timeoutMs?);
```

`initializeAndDelegate` defaults `depositAmount` to the burner's full balance — correct because Kora pays the rent, so every lamport on the burner is genuinely user deposit.

`ensureMainPdaDelegated()` throws if the main PDA exists but is undelegated:

> Main PDA is undelegated and cannot be re-delegated. Withdraw its balance before shredding again.

→ [The shred lifecycle](../concepts/shred-lifecycle.md)

## Withdrawal

```typescript
const { signature, amount } = await shredrClient.withdrawToWallet(
  "DestinationAddressBase58",
  "all",        // or a number of SOL
);
```

Fetches the main PDA state; if delegated, commits, undelegates, and polls until settlement (2s interval, 120s timeout). Then the main burner signs `Withdraw` and Kora pays.

**Only `depositedAmount` is withdrawable.** The rest is the relayer's rent-exemption, which the program refuses to touch.

Throws on: uninitialized main PDA, non-positive amount, amount exceeding `depositedAmount`, or undelegation timeout.

## Balance

```typescript
const { available, availableLamports, address, delegated } =
  await shredrClient.getStealthBalance();
```

Reads the main PDA's `depositedAmount`, **not** its raw lamport balance. Returns zero if the PDA does not exist yet. `address` is the main PDA, not the burner.

## Scanning

```typescript
const pending = await shredrClient.scanPendingUtxos();
// [{ nonceIndex, burnerAddress, stealthPda, lamports, status }]

const results = await shredrClient.shredPendingDeposits();
```

`scanPendingUtxos()` walks indices 1..64, stopping after 5 consecutive empty ones, classifying each as `empty` / `received` / `delegated` / `ready`. Every derived burner key is zeroed before moving on.

`shredPendingDeposits()` shreds everything in the `received` state, re-deriving each burner on demand and clearing it in a `finally` block.

| Status | Meaning |
|---|---|
| `empty` | Nothing here |
| `received` | SOL on the burner, not yet swept — shreddable |
| `delegated` | In the stealth PDA, live in the rollup |
| `ready` | Committed back to the base layer, withdrawable |
| `spent` | Already withdrawn (type member; scanner reports these as `empty`) |

## Signing mode

```typescript
shredrClient.setSigningMode("manual");
```

| Mode | Behaviour |
|---|---|
| `auto` (default) | `GeneratorPage` shreds automatically when a deposit lands |
| `manual` | Deposits stay on the burner until the claim page shreds them |

## Cleanup

```typescript
shredrClient.destroy();
```

Zeroes both burners' secret keys, cascades `destroy()` into `nonceService` and `burnerService`, and resets every field including the cached connections.

{% hint style="warning" %}
Call this on wallet disconnect. `GeneratorPage` does — and importantly it disconnects the WebSocket **first**, so no callback fires against a half-torn-down client.
{% endhint %}

## Connections

Both are created lazily and cached:

| | RPC | Used for |
|---|---|---|
| `getConnection()` | `HELIUS_RPC_URL` | Base layer: init, withdraw, balances, scanning |
| `getRollupConnection()` | `MAGICBLOCK_RPC_URL` | Rollup: private transfer, commit |

Both use `"confirmed"` commitment. `getConnection(rpcUrl)` accepts an override that bypasses the cache.

## Full example

```typescript
import { shredrClient, webSocketClient } from './lib';
import { MASTER_MESSAGE } from './lib/constants';

// 1. Sign
const message = `${MASTER_MESSAGE}:${publicKey.toBase58()}`;
const signature = await signMessage(new TextEncoder().encode(message));

// 2. Initialize
await shredrClient.initFromSignature(signature, publicKey.toBytes());

// 3. Share the receive address and watch it
const address = shredrClient.receiveAddress;
webSocketClient.subscribeToAccount(address);

// 4. On deposit: shred, then rotate
const result = await shredrClient.shredBurner();
await shredrClient.consumeAndGenerateNew();

// 5. Later: claim
const { available } = await shredrClient.getStealthBalance();
await shredrClient.withdrawToWallet(myWallet, "all");

// 6. Clean up
shredrClient.destroy();
```

## Next

* [NonceService](nonce-service.md) — the chain and encryption
* [ShredrProgram](shredr-program.md) — the instruction builders
