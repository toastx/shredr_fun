---
description: "JSON-RPC client for the Kora paymaster, and the base-layer vs. rollup send split."
icon: paper-plane
---

# KoraRelayer

`src/lib/KoraRelayer.ts` — a deliberately thin JSON-RPC client for the [Kora](https://github.com/solana-foundation/kora) paymaster.

The pattern throughout: the frontend builds the transaction and pre-signs with whatever burner keys it holds, then Kora adds the fee-payer signature.

```typescript
import { koraRelayer } from './lib';
```

## Getting the relayer pubkey

```typescript
koraRelayer.getRelayerPubkey();          // sync, from config
await koraRelayer.fetchRelayerPubkey();  // async, asks Kora's getConfig
```

Resolution order for the sync version:

1. `import.meta.env.VITE_KORA_RELAYER_PUBKEY` or `KORA_RELAYER_PUBKEY`
2. `globalThis.__KORA_RELAYER_PUBKEY__`
3. `process.env.KORA_RELAYER_PUBKEY` / `VITE_KORA_RELAYER_PUBKEY`
4. The `KORA_RELAYER_PUBKEY` constant (`shredrWUYk1famp42neAhaJb9PAB69WoSTDhMUdcbjS`)

Throws if nothing resolves. The result is cached.

`fetchRelayerPubkey()` calls Kora's `getConfig` and accepts either `pubkey` or `relayerPubkey` in the response. On failure it warns and falls back to the sync path — which means a stale constant plus an unreachable `getConfig` produces a confusing signature-verification failure rather than a clear error.

## The three send paths

### `signAndSend` — base layer

```typescript
const signature = await koraRelayer.signAndSend(connection, instructions, [burnerKp]);
```

Used for `InitializeAndDelegate` and `Withdraw`.

1. Resolve the relayer pubkey
2. Fetch a recent blockhash from `connection`
3. Compile a v0 `TransactionMessage` with the relayer as `payerKey`
4. Pre-sign with the client signers
5. Serialize, base64, and call **`signAndSendTransaction`**
6. **Kora broadcasts** and returns the signature

```json
{
  "jsonrpc": "2.0", "id": 1,
  "method": "signAndSendTransaction",
  "params": {
    "transaction": "<base64 VersionedTransaction>",
    "signer_key": "<relayer pubkey>",
    "sig_verify": false
  }
}
```

### `signAndSendOn` — rollup

```typescript
const signature = await koraRelayer.signAndSendOn(rollupConnection, instructions, [burnerKp]);
```

Used for `PrivateTransfer` and `CommitAndUndelegateStealth`.

Identical up to step 5, then diverges: it calls **`signTransaction`**, receives the signed transaction back, and **the client broadcasts it** on the rollup connection.

```typescript
const res = await this.rpc("signTransaction", { transaction, signer_key, sig_verify: false });
const signed = res.signed_transaction ?? res.signedTransaction ?? res.transaction;
return connection.sendRawTransaction(base64ToUint8Array(signed), { skipPreflight: false });
```

{% hint style="info" %}
**Why the split matters.** Kora's `signAndSendTransaction` broadcasts on whichever RPC Kora is configured with — the base layer. A rollup transaction is built on a *rollup blockhash* and must reach the *rollup RPC*, or it is rejected. So rollup instructions keep broadcasting client-side.
{% endhint %}

The response field is read tolerantly across three possible names to accommodate different Kora versions.

### `signAndSendLegacy`

```typescript
const signature = await koraRelayer.signAndSendLegacy(connection, instructions, [burnerKp]);
```

Builds a legacy (non-versioned) `Transaction`, uses `partialSign`, and serializes with `requireAllSignatures: false`. Kept because Pinocchio programs are sometimes easier to debug with legacy transactions. Not used in the main flow.

## Which path each instruction uses

| Instruction | Method | RPC | Client signers |
|---|---|---|---|
| `InitializeAndDelegate` | `signAndSend` | Base layer | Burner |
| Ensure main PDA | `signAndSend` | Base layer | Main burner |
| `PrivateTransfer` | `signAndSendOn` | Rollup | Source burner |
| `CommitAndUndelegateStealth` | `signAndSendOn` | Rollup | **None** |
| `Withdraw` | `signAndSend` | Base layer | Main burner |

Commit needs no client signer — only the relayer signs, and Kora provides that.

## Error handling

The private `rpc()` helper throws on:

* non-2xx HTTP responses — `Kora <method> failed: <status> <body>`
* a JSON-RPC `error` field — `Kora <method> error: <message>`

Both propagate to the caller. There is no retry logic.

## Configuration

| Setting | Default | Source |
|---|---|---|
| Endpoint | `http://localhost:8080` | `KORA_RELAYER_URL` in `constants.ts` |
| Relayer pubkey | `shredrWUYk1famp42neAhaJb9PAB69WoSTDhMUdcbjS` | `VITE_KORA_RELAYER_PUBKEY` or the constant |

```typescript
const custom = new KoraRelayer("https://relayer.example.com");
```

{% hint style="warning" %}
The pubkey is the only setting shredr actually reads from the environment. The endpoint is hardcoded — to point at a different relayer you must edit `constants.ts`.

→ [Constants and configuration](configuration.md)
{% endhint %}

## Requirements for your deployment

* Expose `signAndSendTransaction`, `signTransaction`, and ideally `getConfig`
* Allowlist program `H9pUQeNA2RwBHRwx52V8nqWpCAKReSA3gGUuRFHbEjG6`
* Hold a funded keypair on the target network
* Allow CORS from the frontend origin

## Base64 helpers

The file inlines its own `uint8ArrayToBase64` / `base64ToUint8Array` rather than importing from `utils.ts`, to avoid a circular import. Duplicated on purpose.

## Next

* [The Kora relayer](../concepts/relayer.md) — why the relayer exists and what it can see
* [The shred lifecycle](../concepts/shred-lifecycle.md) — where each send path is used
