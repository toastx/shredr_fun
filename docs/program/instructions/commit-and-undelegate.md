---
description: "Flush rollup state and release the account back to the base layer."
icon: right-from-bracket
---

# CommitAndUndelegateStealth

**Discriminator:** `3` · **Layer:** rollup · **Signer:** relayer

Writes the account's final rollup state to the base layer **and** releases it from the rollup. This is what shredr uses on every drained stealth PDA, and on the main PDA before a withdrawal.

## Accounts

| # | Account | Signer | Writable | Description |
|---|---|---|---|---|
| 0 | `relayer` | ✓ | ✓ | Pays the fee and authorizes |
| 1 | `stealth_account` | | ✓ | Delegated stealth PDA to release |
| 2 | `magic_program` | | | MagicBlock delegation program |
| 3 | `magic_context` | | | MagicBlock context (singleton) |

## Instruction data

```
[0]   discriminator = 3
```

No payload.

## What it does

```rust
if !relayer.is_signer() {
    return Err(ProgramError::MissingRequiredSignature);
}

commit_and_undelegate_accounts(
    relayer,
    core::slice::from_ref(stealth_account),
    magic_context,
    magic_program,
    None,
    None,
)?;
```

Structurally identical to [CommitStealth](commit-stealth.md), calling `commit_and_undelegate_accounts` instead.

## Settlement is asynchronous

{% hint style="danger" %}
**Getting a signature back does not mean the account is available.** This is the single most common source of confusion in the whole flow.
{% endhint %}

What happens after the instruction returns:

```
   commit_and_undelegate_accounts   (inside the rollup)
              │
              ▼
   MagicBlock schedules settlement
              │
              ▼
   Delegation program writes buffered state to the base layer
              │
              ▼
   Delegation program recreates the account
              │
              ▼
   Calls shredr's UndelegationCallback (0xFF)
              │
              ▼
   Callback copies state back and sets delegated = false
              │
              ▼
   Account is usable on the base layer
```

Poll until it is done:

```typescript
await shredrClient.commitAndUndelegate(pda);
const state = await shredrClient.waitForUndelegation(pda);
// polls every 2s (UNDELEGATION_POLL_INTERVAL_MS)
// throws after 120s (UNDELEGATION_TIMEOUT_MS)
```

`waitForUndelegation` returns as soon as the base-layer account exists with `delegated == false`.

## Client usage

```typescript
const ix = createCommitAndUndelegateStealthInstruction(relayerPubkey, stealthPda);

// Rollup RPC, no client signers
await koraRelayer.signAndSendOn(rollupConnection, [ix], []);
```

Or:

```typescript
await shredrClient.commitAndUndelegate(stealthPda);
```

## Where shredr uses it

{% tabs %}
{% tab title="After a shred" %}
The drained source stealth PDA is released as the last step of `shredBurner()`. Nothing waits for settlement here — the account is empty and nothing depends on it, so polling would just slow the flow down.
{% endtab %}

{% tab title="Before a withdrawal" %}
`withdrawToWallet()` commits and undelegates the main PDA if it is still delegated, then **waits** for settlement before submitting the `Withdraw`.

Here the wait is mandatory: `Withdraw` rejects a delegated account with `AlreadyDelegated`.
{% endtab %}
{% endtabs %}

## The one-way door

{% hint style="warning" %}
**An undelegated stealth PDA cannot be re-delegated.**

`InitializeAndDelegate` is the only path into the rollup, and it refuses any account that already has lamports. Once released, a stealth PDA stays on the base layer permanently.

For rotating burners this is fine — each is used once.

For the **main PDA** it has a real consequence: withdrawing undelegates it, so after a withdrawal it can no longer receive private transfers. In practice, **withdraw your full balance before shredding again**.

`ensureMainPdaDelegated()` detects the bad state and throws a clear message rather than failing deep in a transaction.

→ [Limitations](../../reference/limitations.md)
{% endhint %}

## Common failures

<details>
<summary><strong><code>MissingRequiredSignature</code></strong></summary>

The relayer did not sign. Check that `KORA_RELAYER_PUBKEY` matches Kora's actual signing key.
</details>

<details>
<summary><strong>Timeout in <code>waitForUndelegation</code></strong></summary>

Settlement did not complete within 120 seconds. The commit was still submitted, so it may finish afterwards — retry the withdrawal, which will find the account already undelegated and skip straight to the transfer.
</details>

<details>
<summary><strong>Sent to the wrong RPC</strong></summary>

This goes to the **rollup**, not the base layer. A delegated account does not exist on Solana in a live form.
</details>

## Next

* [UndelegationCallback](undelegation-callback.md) — what runs on the other side
* [Withdraw](withdraw.md) — what this unblocks
