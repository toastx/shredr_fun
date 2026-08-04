---
description: "The four on-chain steps that move a deposit from a burner into your consolidation account."
icon: arrows-spin
---

# The shred lifecycle

"Shredding" is what shredr does with a deposit. It is four on-chain actions run in sequence by `ShredrClient.shredBurner()`.

## The sequence

```
        ┌─────────────┐
        │   Burner    │  SOL deposited by the sender
        └──────┬──────┘
               │  ① InitializeAndDelegate    (base layer)
               ▼
        ┌─────────────┐
        │ Stealth PDA │  created, funded, delegated to the rollup
        └──────┬──────┘
               │
               │  ② ensure main PDA exists + delegated  (base layer, first time only)
               │
               │  ③ PrivateTransfer          (INSIDE the rollup)
               ▼
        ┌─────────────┐
        │  Main PDA   │  balance grows; stays delegated
        └─────────────┘
               ▲
               │
        ┌──────┴──────┐
        │ Stealth PDA │  ④ CommitAndUndelegateStealth — now empty, released
        └─────────────┘
```

## Step 1 — InitializeAndDelegate

**Where:** base layer (Solana) · **Signers:** relayer + burner

```typescript
const lamports = await connection.getBalance(burnerKp.publicKey);
const initSig = await shredrClient.initializeAndDelegate(burner, BigInt(lamports));
```

One instruction doing five things:

{% stepper %}
{% step %}
### Create the PDA

A System Program CPI creates the stealth account, sized `8 + size_of::<StealthAccount>()` = **96 bytes**. The **relayer pays the rent**, which is what keeps your `deposited_amount` free of any lamports that are not yours.
{% endstep %}

{% step %}
### Sweep the deposit

A System Program transfer moves `deposit_amount` lamports from the burner into the PDA. The **burner signs** this — it is authorizing the movement of its own funds.

Passing `0` creates an empty delegated PDA instead, which is how the main PDA gets set up.
{% endstep %}

{% step %}
### Write state

The 8-byte discriminator `SHREDRSA` goes in first, then the `StealthAccount` struct: `owner` = burner pubkey, `deposited_amount`, `deposit_timestamp` from the Clock sysvar, `delegated = true`, and the PDA `bump`.

Writing the discriminator before any state prevents type-confusion attacks.
{% endstep %}

{% step %}
### Create the ACL permission

A CPI to the permission program registers the burner as the sole member allowed to act on this account inside the rollup. This is what `PrivateTransfer` later checks against.
{% endstep %}

{% step %}
### Delegate

A CPI to the MagicBlock delegation program hands the account to a TEE validator. On mainnet builds a specific validator is pinned; on devnet the network default is used.

From here the base-layer copy is frozen — the account lives in the rollup.
{% endstep %}
{% endstepper %}

**Guards:** both relayer and burner must sign; the PDA is re-derived and compared to the account passed in; the account must have zero lamports (not already initialized).

→ [InitializeAndDelegate reference](../program/instructions/initialize-and-delegate.md)

## Step 2 — Ensure the main PDA is ready

**Where:** base layer · **Runs:** only when needed

```typescript
const mainSig = await shredrClient.ensureMainPdaDelegated();  // null if already delegated
```

The destination of a private transfer must itself be a delegated, program-owned account. So before transferring, shredr checks the main PDA:

| Main PDA state | Action |
|---|---|
| Does not exist | `InitializeAndDelegate` with `deposit_amount = 0` — creates it empty and delegated |
| Exists, `delegated == true` | Nothing. Returns `null` |
| Exists, `delegated == false` | **Throws** |

{% hint style="warning" %}
**An undelegated main PDA cannot be re-delegated.** `InitializeAndDelegate` creates the account, and it refuses to run against an account that already has lamports. Once your main PDA has been committed back to the base layer (which happens when you withdraw), it cannot re-enter the rollup.

The client fails fast with a clear message rather than letting the transaction fail later:

> Main PDA is undelegated and cannot be re-delegated. Withdraw its balance before shredding again.

The practical consequence: **fully withdraw before shredding again.** See [Limitations](../reference/limitations.md).
{% endhint %}

## Step 3 — PrivateTransfer

**Where:** inside the MagicBlock rollup · **Signer:** source burner (Kora pays)

```typescript
const transferSig = await shredrClient.privateTransferToMainPda(burner, deposit);
```

This is the step that provides the privacy. It is dispatched against the **rollup RPC** (`https://devnet.magicblock.app`), not Solana.

The program moves lamports directly between the two accounts:

```rust
source_pda.set_lamports(source_pda.lamports() - amount);
destination_pda.set_lamports(destination_pda.lamports() + amount);
source_data.deposited_amount -= amount;
destination_data.deposited_amount += amount;
```

Direct `set_lamports` rather than a System Program CPI, because inside the rollup the program owns both accounts and CPI to the System Program may not be available.

### How a PDA is authorized

A PDA can never sign. So the transfer is authorized by the **burner recorded as the source PDA's owner**:

```rust
if &source_data.owner != source_burner.address() {
    return Err(ProgramError::IllegalOwner);
}
```

The burner signs the transaction; the program checks that signer against the `owner` written at initialization — the same key registered as the ACL member.

**Guards:** source burner must sign and match `owner`; both accounts must be owned by the shredr program; source and destination must differ (`SelfTransferNotAllowed` — aliasing two mutable references to one account would be undefined behavior); `deposited_amount` must cover the amount; all arithmetic is checked.

### Why it is private

Because it happens inside the rollup, it is not a Solana transaction. It produces no public signature, no log, no account-change record on the base layer. When the accounts eventually settle, the ledger shows only the net result — an empty source and a fuller destination — with no edge connecting them.

→ [PrivateTransfer reference](../program/instructions/private-transfer.md) · [Ephemeral rollups](ephemeral-rollups.md)

## Step 4 — CommitAndUndelegateStealth

**Where:** dispatched to the rollup RPC · **Signer:** relayer only

```typescript
const commitSig = await shredrClient.commitAndUndelegate(stealthPda);
```

The now-empty source PDA is released. The MagicBlock program schedules settlement from inside the rollup, which then:

1. writes the final rollup state back to the base layer,
2. recreates the account there,
3. calls shredr's `UndelegationCallback`.

The callback copies the buffered state back and then clears the `delegated` flag:

```rust
undelegate(stealth_account, program_id, buffer_account, payer, ix_data)?;
let stealth_state = get_stealth_mut(stealth_account)?;
stealth_state.delegated = false;
```

{% hint style="info" %}
That last line matters more than it looks. The buffered state still carries `delegated = true` from initialization. Without explicitly clearing it, `Withdraw` would reject forever with `AlreadyDelegated` and the funds would be permanently unreachable.
{% endhint %}

The **main PDA is deliberately left delegated** so it can keep receiving private transfers from future deposits without being re-created.

→ [CommitAndUndelegateStealth reference](../program/instructions/commit-and-undelegate.md)

## The result

`shredBurner()` returns every signature:

```typescript
{
  burnerAddress: "...",
  stealthPda: "...",
  lamports: 500000000,
  signatures: {
    initializeAndDelegate: "5xY...",
    initializeMainPda: "3aB...",   // null on subsequent shreds
    privateTransfer: "7cD...",
    commitAndUndelegate: "9eF..."
  }
}
```

## Withdrawal

Not part of shredding, but the end of the story.

```typescript
const { signature, amount } = await shredrClient.withdrawToWallet(destination, "all");
```

{% stepper %}
{% step %}
### Read state

Fetch the main PDA. Throws if it was never initialized.
{% endstep %}

{% step %}
### Undelegate if needed

If `delegated`, run `commitAndUndelegate`, then **poll** the base layer until the account reappears with `delegated == false`.

Polling every `2s`, timeout `120s` (`UNDELEGATION_POLL_INTERVAL_MS`, `UNDELEGATION_TIMEOUT_MS`). Settlement is asynchronous and this genuinely takes time.
{% endstep %}

{% step %}
### Withdraw

The **main burner** signs; Kora pays. Only `deposited_amount` is withdrawable — the rent-exemption is off limits, enforced by a floor check in the program.

If the withdrawal drains the account completely, the program zeroes `owner`, `delegated`, and `bump`.
{% endstep %}
{% endstepper %}

→ [Withdraw reference](../program/instructions/withdraw.md)

## Which RPC each step uses

Getting this wrong is a common source of confusion, since delegated accounts only exist on the rollup:

| Step | RPC | Kora method | Client signers |
|---|---|---|---|
| `InitializeAndDelegate` | Base layer (Helius) | `signAndSendTransaction` | Burner |
| Ensure main PDA | Base layer (Helius) | `signAndSendTransaction` | Main burner |
| `PrivateTransfer` | **Rollup** (MagicBlock) | `signTransaction`, then broadcast locally | Source burner |
| `CommitAndUndelegate` | **Rollup** (MagicBlock) | `signTransaction`, then broadcast locally | None |
| `Withdraw` | Base layer (Helius) | `signAndSendTransaction` | Main burner |

Rollup-bound transactions use `signAndSendOn()`: Kora signs as fee payer, then the **client** broadcasts to the rollup. Kora's own `signAndSendTransaction` would broadcast on whatever RPC Kora is configured with — the base layer — which is wrong for a rollup transaction built on a rollup blockhash.

→ [KoraRelayer](../frontend/kora-relayer.md)

## Failure modes

<details>
<summary><strong>Step 1 fails</strong></summary>

The deposit stays on the burner in the `received` state. The next `scanPendingUtxos()` picks it up, and `shredPendingDeposits()` retries. Nothing is lost.
</details>

<details>
<summary><strong>Step 3 fails after step 1 succeeded</strong></summary>

The deposit is in a delegated stealth PDA (`delegated` status). Funds are safe but in the rollup. Recovering means committing and undelegating that PDA, then withdrawing from it directly — the app does not currently expose a one-click path for this.
</details>

<details>
<summary><strong>Step 4 fails after step 3 succeeded</strong></summary>

Money already reached the main PDA. The stray delegated (empty) stealth PDA is harmless — it holds only the relayer's rent.
</details>

<details>
<summary><strong>Undelegation times out during withdrawal</strong></summary>

`waitForUndelegation` throws after 120 seconds. The commit was still submitted, so settlement may complete afterwards. Retry the withdrawal — it will find the account already undelegated and skip straight to the transfer.
</details>

<details>
<summary><strong>Auto-shred fails in the UI</strong></summary>

`GeneratorPage` logs the error rather than surfacing it, deliberately: the funds remain on the burner, and the claim page's scan will find them. A `shreddingRef` guard prevents overlapping shreds from concurrent WebSocket notifications.
</details>

## Next

* [Ephemeral rollups](ephemeral-rollups.md) — what delegation actually does
* [Instructions](../program/instructions/README.md) — account tables and byte layouts
