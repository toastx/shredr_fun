---
description: "Why a third party pays your fees, and why that is a privacy requirement rather than a convenience."
icon: gas-pump
---

# The Kora relayer

Every shredr transaction is paid for by a **Kora relayer**. This looks like a UX nicety. It is actually load-bearing for the privacy guarantee.

## The problem it solves

A burner keypair receives SOL. To do anything with it, someone must pay the transaction fee. If that someone is you, the fee payment is a public Solana transaction:

```
Your wallet ──0.00001 SOL──▶ Burner
```

That single transaction destroys everything. An observer following the burner backwards finds your wallet, and through it, every other burner you have funded — and therefore every payment you have received.

The problem is unavoidable in any scheme where the user pays their own fees. It is solved by having someone else pay.

## What Kora is

[Kora](https://github.com/solana-foundation/kora) is a Solana **paymaster**: a service that signs transactions as fee payer on behalf of users. It speaks JSON-RPC.

In shredr it plays two roles:

| Role | Where |
|---|---|
| **Fee payer** | Every shredr transaction. Kora's pubkey is the `payerKey` of the compiled message |
| **On-chain `relayer` account** | `InitializeAndDelegate` (account 0) and both commit instructions (account 0), where the program requires a signing relayer |

The second role matters because those instructions do more than pay fees — `InitializeAndDelegate` has the relayer pay the new PDA's **rent-exemption** via a System Program CPI.

## Why the relayer pays rent

Creating an account on Solana requires a rent-exempt minimum deposit. If that came out of the user's deposit, the accounting would be muddy: some lamports in the PDA would be rent and some would be yours, with no clean way to tell them apart.

Instead:

```
PDA lamports = rent-exempt minimum (relayer's) + deposited_amount (yours)
```

`deposited_amount` is tracked separately in the account state and is **exactly** what the sender deposited. Withdrawals are capped at it, so the account can never be drained below rent-exemption and reaped by the runtime — which would strand the residual lamports permanently.

The program enforces this with an explicit floor check in `Withdraw`:

```rust
let rent_minimum = rent.try_minimum_balance(stealth_account.data_len())?;
if new_stealth_lamports < rent_minimum {
    return Err(ShredrError::BalanceInvariantViolation.into());
}
```

## How the client talks to Kora

`src/lib/KoraRelayer.ts` is a thin JSON-RPC client. It exposes three send paths.

### `signAndSend` — base layer

Used for `InitializeAndDelegate` and `Withdraw`.

{% stepper %}
{% step %}
### Fetch the relayer pubkey

`fetchRelayerPubkey()` tries Kora's `getConfig` RPC and falls back to the configured constant on failure.
{% endstep %}

{% step %}
### Build a v0 transaction

Compile a `TransactionMessage` with Kora as `payerKey` and a recent blockhash from the base-layer connection.
{% endstep %}

{% step %}
### Pre-sign client-side

Sign with whichever burner keypairs are required — the burner for `InitializeAndDelegate`, the main burner for `Withdraw`.
{% endstep %}

{% step %}
### Hand off to Kora

Serialize, base64-encode, and call `signAndSendTransaction`. **Kora signs as fee payer and broadcasts.** The signature comes back.
{% endstep %}
{% endstepper %}

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

Used for `PrivateTransfer` and `CommitAndUndelegateStealth`.

Identical up to the handoff, then it diverges: it calls **`signTransaction`** instead, gets the signed transaction back, and **the client broadcasts it** on the rollup connection.

```typescript
const res = await this.rpc("signTransaction", { transaction, signer_key, sig_verify: false });
return connection.sendRawTransaction(base64ToUint8Array(signed), { skipPreflight: false });
```

{% hint style="info" %}
**Why the split.** Kora's `signAndSendTransaction` broadcasts on whatever RPC Kora is configured with — the base layer. A rollup transaction is built on a *rollup blockhash* and must reach the *rollup RPC*, or it is invalid. So for rollup instructions the client keeps control of broadcasting.
{% endhint %}

The response field is read tolerantly (`signed_transaction`, `signedTransaction`, or `transaction`) to accommodate different Kora versions.

### `signAndSendLegacy`

A legacy (non-versioned) `Transaction` variant, using `partialSign` and `serialize({ requireAllSignatures: false })`. Kept for debugging Pinocchio programs, which are sometimes easier to inspect with legacy transactions. Not used in the main flow.

## Configuration

| Setting | Source | Notes |
|---|---|---|
| Endpoint | `VITE_KORA_RELAYER_URL` → `KORA_RELAYER_URL` | No hardcoded default; e.g. `http://localhost:8080` locally |
| Relayer pubkey | `VITE_KORA_RELAYER_PUBKEY` / `KORA_RELAYER_PUBKEY`, or `globalThis.__KORA_RELAYER_PUBKEY__` | Falls back to Kora's `getConfig` when unset |

`getEnvironmentRelayerPubkey()` checks `import.meta.env`, then a global, then `process.env`. The result is cached after first resolution.

{% hint style="warning" %}
The relayer pubkey is the **only** setting shredr actually reads from the environment today. The endpoint URL and all RPC URLs are hardcoded in `constants.ts` despite `.env.example` suggesting otherwise.

→ [Constants and configuration](../frontend/configuration.md)
{% endhint %}

Your Kora deployment must:

* expose `signAndSendTransaction` and `signTransaction` (and ideally `getConfig`),
* allowlist the shredr program ID `H9pUQeNA2RwBHRwx52V8nqWpCAKReSA3gGUuRFHbEjG6`,
* hold a funded keypair on the target network,
* accept CORS requests from the frontend origin.

## What Kora sees

| Kora knows | Kora does not know |
|---|---|
| Every shredr transaction it signs | Your wallet address |
| Burner pubkeys, stealth PDAs, amounts | Your derived seeds or private keys |

Kora signs as fee payer only. It never holds a key that can move your funds, and it is never recorded as the owner of any stealth account — the program authorizes transfers against the burner in the account's `owner` field, which Kora does not control.

## Failure modes

<details>
<summary><strong>Kora is unreachable</strong></summary>

Every on-chain action fails. There is no fallback path where your own wallet pays — that would defeat the purpose.

Deposits already on a burner are safe and can be shredded once Kora is back.
</details>

<details>
<summary><strong>Kora's account is out of SOL</strong></summary>

Transactions fail at the relayer. Same recovery: funds stay put until it is refilled.
</details>

<details>
<summary><strong>The configured pubkey does not match Kora's actual key</strong></summary>

Instructions are built with the wrong `relayer` account, and the transaction fails signature verification.

`fetchRelayerPubkey()` calling `getConfig` is the guard against this — but it silently falls back to the constant if `getConfig` fails, so a stale constant plus an unreachable `getConfig` produces a confusing failure.
</details>

<details>
<summary><strong>Kora rejects the program</strong></summary>

Most Kora deployments allowlist which programs they will pay for. If shredr's program ID is not on the list, requests are refused.
</details>

## Next

* [KoraRelayer reference](../frontend/kora-relayer.md) — the full client API
* [The privacy model](privacy-model.md) — where the relayer sits in the trust model
