---
description: "Invoked by the delegation program after settlement. Never called by users."
icon: reply
---

# UndelegationCallback

**Discriminator:** `0xFF` · **Layer:** base · **Caller:** the MagicBlock delegation program, via CPI

Runs automatically at the end of undelegation. It restores the account's state on the base layer and — critically — clears the `delegated` flag.

{% hint style="warning" %}
**Not user-invoked.** The MagicBlock delegation program calls this via CPI as the final step of settlement. The client never builds this instruction, and the Codama client's `undelegationCallback` builder exists only for completeness.
{% endhint %}

## Accounts

The order is fixed by what the delegation program passes:

| # | Account | Description |
|---|---|---|
| 0 | `stealth_account` | The account being undelegated |
| 1 | `buffer_account` | Buffer holding the committed rollup state |
| 2 | `payer` | Pays for account recreation |
| 3 | `system_program` | System Program |

## Instruction data

```
[0]     discriminator = 0xFF
[1..]   opaque payload forwarded to undelegate()
```

Everything after the discriminator is passed through to the SDK's `undelegate()` — the program does not interpret it.

## What it does

```rust
pub fn process(self, program_id: &Address) -> ProgramResult {
    undelegate(stealth_account, program_id, buffer_account, payer, ix_data)?;

    let stealth_state = get_stealth_mut(stealth_account)?;
    stealth_state.delegated = false;

    Ok(())
}
```

Two steps:

1. **`undelegate()`** — the SDK helper recreates the base-layer account (program-owned) and copies the buffered rollup state back verbatim.
2. **Clear `delegated`.**

## Why that second line is essential

{% hint style="danger" %}
`undelegate()` copies the buffered state back **verbatim** — and that state still carries `delegated = true`, written during `InitializeAndDelegate` and never changed inside the rollup.

Without the explicit clear, the account would come back to the base layer still claiming to be delegated. `Withdraw` checks that flag:

```rust
if stealth_data.delegated {
    return Err(ShredrError::AlreadyDelegated.into());
}
```

Every withdrawal attempt would fail with `AlreadyDelegated`, forever. The funds would be permanently unreachable.
{% endhint %}

The source comment says exactly this, and it is worth preserving if you refactor:

> `undelegate` has just recreated the base-layer account (program-owned) and copied the buffered rollup state back verbatim — which still carries `delegated = true` from initialization. Clear it now so the account reflects that it lives on the base layer again; otherwise `Withdraw` would permanently reject with `AlreadyDelegated` and funds could never be claimed.

## Where it fits

```
CommitAndUndelegateStealth  (rollup)
              │
              ▼
   MagicBlock schedules settlement
              │
              ▼
   Delegation program writes buffered state
              │
              ▼
   Delegation program recreates the account
              │
              ▼
   ┌──────────────────────────────────┐
   │  UndelegationCallback (0xFF)     │  ← you are here
   │  • undelegate() restores state   │
   │  • delegated = false             │
   └──────────────────────────────────┘
              │
              ▼
   Account usable on the base layer
   waitForUndelegation() returns
```

`waitForUndelegation()` polls for exactly the effect of this callback:

```typescript
const state = await this.fetchStealthState(stealthPda);
if (state && !state.delegated) return state;
```

## Validation

| Check | Error |
|---|---|
| At least 4 accounts | `NotEnoughAccountKeys` |
| Account owned by shredr, correct size, valid discriminator | via `get_stealth_mut()` |

{% hint style="info" %}
The program does **not** verify that the caller is the delegation program. It relies on the delegation program being the only entity able to produce a valid buffer account, plus the checks inside the SDK's `undelegate()`.

If you are auditing this, that assumption is worth scrutinizing — an explicit caller check would be a stronger guarantee.
{% endhint %}

## Debugging

You do not call this, but you observe its effects:

<details>
<summary><strong>Account stuck as delegated</strong></summary>

If `waitForUndelegation()` keeps timing out, the callback either never fired or failed. Look at the transaction history for the delegation program's settlement transaction and check whether the CPI into shredr succeeded.
</details>

<details>
<summary><strong>Withdraw always fails with AlreadyDelegated</strong></summary>

The `delegated` flag was never cleared. Either the callback did not run, or a modified build dropped that line.
</details>

<details>
<summary><strong>State looks wrong after undelegation</strong></summary>

`undelegate()` copies the buffer verbatim, so whatever was in the rollup at commit time is what you get. If a `PrivateTransfer` did not land before the commit, its effect is simply absent.
</details>

## Next

* [CommitAndUndelegateStealth](commit-and-undelegate.md) — what triggers this
* [Accounts and state](../accounts-and-state.md) — the `delegated` field
