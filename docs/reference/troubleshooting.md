---
description: "Symptom-first debugging for the app, the program, the backend, and the relayer."
icon: wrench
---

# Troubleshooting

Organized by what you observe.

## Frontend

<details>
<summary><strong>"Kora relayer pubkey is not configured"</strong></summary>

`getRelayerPubkey()` found nothing in any of its sources.

**Fix:** set `VITE_KORA_RELAYER_PUBKEY` in `.env.local`, or `globalThis.__KORA_RELAYER_PUBKEY__` before the app loads. This is one of the few environment variables that actually works.
</details>

<details>
<summary><strong>Every transaction fails, or nothing happens on deposit</strong></summary>

Almost always the relayer.

**Check, in order:**
1. Is Kora running at `http://localhost:8080`? `curl` it.
2. Is its account funded on devnet?
3. Does `KORA_RELAYER_PUBKEY` match Kora's actual signing key? A mismatch produces `MissingSigner` (6007).
4. Does Kora allowlist program `H9pUQeNA2RwBHRwx52V8nqWpCAKReSA3gGUuRFHbEjG6`?
5. CORS — does Kora accept requests from your frontend origin?

There is no fallback path where your wallet pays. Without Kora, nothing on-chain works.
</details>

<details>
<summary><strong>Treated as a new user despite having used shredr before</strong></summary>

State resolution failed at both layers.

**Check:**
1. **Same wallet?** A different wallet means a different signature and different keys.
2. **Same message?** It must be exactly `SHREDR_V1:<wallet address>`. A changed `MASTER_MESSAGE` breaks everything.
3. **IndexedDB cleared?** Then it depends on the blob.
4. **Backend reachable?** `fetchAllBlobs()` silently returns `[]` on error, with no user-visible warning. Check the network tab.
5. **Too many blobs?** The client pages through the whole set, so scale alone should not hide your blob. If a page fails mid-walk it keeps what it already fetched, so a partial result can still look like a fresh account — check the network tab for a failed `/api/blobs` request.

**Your funds are not lost.** Run the claim page's scan — `scanPendingUtxos()` starts at index 1 regardless of current position, and the main PDA is derived directly from the signature.
</details>

<details>
<summary><strong>Balance shows 0 but the explorer shows lamports in the PDA</strong></summary>

Expected. The app reads `depositedAmount`, not the raw lamport balance:

```
account lamports = rent-exempt minimum (relayer's) + deposited_amount (yours)
```

A PDA with only rent shows a balance of 0 because there is nothing withdrawable.
</details>

<details>
<summary><strong>Deposit landed but nothing happened</strong></summary>

**Check:**
1. Signing mode — in `manual`, `GeneratorPage` does not auto-shred.
2. WebSocket connected? Look for `Connected to Proxy` in the console.
3. Shred errors are logged, not surfaced. Open the console.
4. Did the funds go to the **burner** or the **stealth PDA**? Only burner deposits are shreddable.

**Recovery:** the claim page's scan finds it. `shredPendingDeposits()` shreds everything in the `received` state.
</details>

<details>
<summary><strong>"Main PDA is undelegated and cannot be re-delegated"</strong></summary>

You withdrew (which undelegates the main PDA) without emptying it, and are now trying to shred again.

`InitializeAndDelegate` refuses any account with lamports, and it is the only path back into the rollup.

**Fix:** withdraw the **full** remaining balance, then shred. Always withdraw everything.

→ [Limitations](limitations.md)
</details>

<details>
<summary><strong>Withdrawal hangs, then "Timed out waiting for ... to undelegate"</strong></summary>

Settlement did not complete within 120 seconds. It is asynchronous — rollup commit → delegation program → `UndelegationCallback`.

**Fix:** wait a minute and retry. The second attempt finds the account already undelegated and goes straight to the transfer.

**If it never settles:** check the MagicBlock rollup's status and look for the settlement transaction in the delegation program's history.
</details>

<details>
<summary><strong>Runtime errors about <code>process</code> or <code>Buffer</code></strong></summary>

The polyfills did not load first.

**Fix:** `import './polyfills'` must be the **first** import in `main.tsx`, before anything that pulls in Solana packages.
</details>

<details>
<summary><strong>Wallet will not sign / no signMessage</strong></summary>

The wallet must support message signing. Phantom and Solflare do; some hardware setups do not.

Note `WalletProvider` registers only `PhantomWalletAdapter` and `SolflareWalletAdapter` — add others there if needed.
</details>

## Program errors

Full list in [Errors](../program/errors.md). The common ones:

| Code | Name | Usual cause |
|---|---|---|
| 6000 | `InvalidStealthPDA` | Wrong seeds or program ID in derivation |
| 6001 | `InvalidProgramOwner` | PDA not created yet |
| 6004 | `AlreadyDelegated` | Withdrawing before undelegation settled |
| 6006 | `InvalidDestinationOwner` | Main PDA not initialized |
| 6007 | `MissingSigner` | Kora misconfiguration |
| 6010 | `AccountAlreadyInitialized` | Shredding twice, or funds sent to the PDA |

<details>
<summary><strong>6010 after someone sent funds to the stealth PDA</strong></summary>

Unrecoverable. The program requires the PDA to be empty at creation, so it can never be initialized — and without initialization the program has no state through which to move the funds.

**Prevention:** only ever share the **burner address**. The UI shows only that.
</details>

<details>
<summary><strong>6004 that never clears</strong></summary>

If the account is genuinely undelegated on the base layer but `Withdraw` still rejects, `UndelegationCallback` did not clear the `delegated` flag.

Fetch the account and check the byte at offset 88. It should be `0`.

→ [UndelegationCallback](../program/instructions/undelegation-callback.md)
</details>

<details>
<summary><strong>"Transaction not found" on a rollup instruction</strong></summary>

Sent to the wrong RPC. `PrivateTransfer` and the commit instructions must go to `https://devnet.magicblock.app` via `signAndSendOn()`, not to Helius via `signAndSend()`.

Delegated accounts do not exist in a live form on the base layer.
</details>

## Backend

<details>
<summary><strong>Panics on startup: "DATABASE_HOST is required"</strong></summary>

The message names an old variable. The code reads **`PGHOST`**.

Set all four: `PGHOST` (with port), `PGUSER`, `PGPASSWORD`, `PGDATABASE`. `.env.example` is stale.
</details>

<details>
<summary><strong>Panics: "HELIUS_API_KEY required"</strong></summary>

Mandatory even though nothing calls the webhook endpoints — the Helius client is constructed unconditionally at startup.
</details>

<details>
<summary><strong>Cannot connect to a local PostgreSQL</strong></summary>

`sslmode=require` is always appended to the connection string.

**Fix:** enable SSL on your PostgreSQL, or edit `build_database_url()` in `main.rs` for local work.
</details>

<details>
<summary><strong>CORS errors from the frontend</strong></summary>

`ENVIRONMENT` is set to something other than `development`, and your origin is not in the hardcoded production allowlist (`https://shredr.fun`, `https://www.shredr.fun`).

**Fix:** set `ENVIRONMENT=development` locally, or add your domain to the list in `main.rs`.
</details>

<details>
<summary><strong>429 Too Many Requests</strong></summary>

Rate limits are per client IP:

| Endpoints | Limit |
|---|---|
| Blob writes | Burst 5, refill every 10s |
| Blob reads | 30/sec, burst 60 |
| Webhooks | Burst 5, refill every 12s |

Behind a proxy, verify it sets `X-Forwarded-For` — otherwise every client shares the proxy's IP and one user's activity throttles everyone.
</details>

<details>
<summary><strong>"Blob too large"</strong></summary>

Over 2048 bytes. Real blobs are ~200. Something is wrong with what you are sending.
</details>

## Development

<details>
<summary><strong>Client and program out of sync</strong></summary>

Symptom: transactions fail on devnet with account or data errors that make no sense from the client's perspective.

**Fix:**
```bash
cd shredr-program && cargo build-sbf   # regenerate the IDL
cd .. && npm run generate:client
npm test                                # ShredrProgram tests catch drift
```
</details>

<details>
<summary><strong>Tests fail with IndexedDB errors</strong></summary>

`tests/setup.ts` installs `fake-indexeddb` and the crypto polyfill. Confirm `.mocharc.json` loads it.
</details>

<details>
<summary><strong>Integration tests interfere with each other</strong></summary>

Each test must use a **unique** mock wallet pubkey — the wallet hash is the IndexedDB record key, and `fake-indexeddb` state can persist within a process.
</details>

<details>
<summary><strong>Program build fails</strong></summary>

Check Rust 1.75+, a current Solana CLI with `cargo build-sbf`, and that you are in `shredr-program/`. The `.cargo/config.toml` there matters.
</details>

## Diagnostics

{% tabs %}
{% tab title="Client state" %}
```javascript
console.log(shredrClient.state);
// { initialized, currentNonce, currentBurner, stealthPda,
//   mainBurnerAddress, mainPda, signingMode, currentBlobId, ... }
```
{% endtab %}

{% tab title="On-chain accounts" %}
```javascript
const conn = new Connection(HELIUS_RPC_URL);

// Burner (undelegated deposits)
await conn.getBalance(new PublicKey(shredrClient.receiveAddress));

// Main PDA state
const info = await conn.getAccountInfo(new PublicKey(shredrClient.mainPdaAddress));
console.log(parseStealthAccount(new Uint8Array(info.data)));
```
{% endtab %}

{% tab title="Pending funds" %}
```javascript
console.table(await shredrClient.scanPendingUtxos());
// nonceIndex | burnerAddress | stealthPda | lamports | status
```
{% endtab %}

{% tab title="Services" %}
```bash
curl http://localhost:8000/health          # backend → OK
curl -X POST http://localhost:8080 \       # Kora
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getConfig","params":{}}'
```
{% endtab %}
{% endtabs %}

## Where funds are, by symptom

| Symptom | Location | Recovery |
|---|---|---|
| Deposit not shredded | On the burner | `shredPendingDeposits()` |
| Shred failed at step 1 | On the burner | Retry the shred |
| Shred failed after step 1 | Stealth PDA, delegated | Commit + undelegate, then withdraw from that PDA |
| Shred completed | Main PDA | `withdrawToWallet()` |
| Withdrawal failed | Main PDA, undelegated | Retry the withdrawal |
| Sent to the stealth PDA | Stuck in the PDA | **Unrecoverable** |

In every recoverable case the funds are on-chain and re-derivable from your wallet signature.

## Next

* [Errors](../program/errors.md)
* [FAQ](faq.md)
