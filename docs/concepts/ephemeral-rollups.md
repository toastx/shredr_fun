---
description: "What MagicBlock does, why the private transfer happens there, and what delegation means."
icon: layer-group
---

# Ephemeral rollups

The private transfer — the step that actually breaks the link between sender and receiver — happens inside a **MagicBlock ephemeral rollup**. This page explains what that is and why shredr needs it.

## The problem

Solana is fully public. Every transaction, every account change, every balance is visible to anyone forever.

So moving money from a burner's stealth PDA into your main PDA with a normal Solana transaction would create exactly the public edge shredr exists to avoid:

```
Stealth PDA ────────────▶ Main PDA
              visible, forever
```

Anyone following the burner forward would land on your consolidation account, and from there see every other payment you have ever received.

The transfer has to happen somewhere that is not the public ledger — while still being real, and still settling back to Solana.

## What an ephemeral rollup is

A MagicBlock **ephemeral rollup (ER)** is a short-lived execution environment that temporarily takes ownership of specific Solana accounts.

```
     Solana base layer                  Ephemeral rollup
    ┌──────────────────┐              ┌──────────────────┐
    │  Account X       │──delegate───▶│  Account X        │
    │  (frozen)        │              │  (live, fast)     │
    │                  │              │  transactions run │
    │                  │◀─undelegate──│  here, privately  │
    │  final state     │              │                   │
    └──────────────────┘              └──────────────────┘
```

The key properties:

* **Selective.** Only accounts you explicitly delegate move. The rest of Solana is unaffected.
* **Fast.** Transactions inside the rollup are not competing for global Solana blockspace.
* **Settles back.** Final state is written to the base layer, so it is real money, not an IOU.
* **TEE-secured.** Validators run inside a trusted execution environment, so the operator cannot observe what executes inside.

That last property is what makes the rollup a *privacy* tool rather than just a scaling one.

## Delegation

Handing an account to the rollup is called **delegation**. `InitializeAndDelegate` does it via CPI to the MagicBlock delegation program (`DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`).

Once delegated:

| | Base layer | Rollup |
|---|---|---|
| Account readable | Yes — but frozen at the delegation snapshot | Yes, live |
| Account writable | **No** | Yes |
| Transactions execute | No | Yes |
| Publicly visible | Only the fact of delegation | No |

Reading a delegated account on the base layer gives you stale data. This is why `PrivateTransfer` and the commit instructions are dispatched to the rollup RPC (`https://devnet.magicblock.app`), not to Helius.

### Requirements

An account can only be delegated if it is **program-owned**. A plain keypair account owned by the System Program cannot be delegated — which is precisely why shredr sweeps deposits from the burner into a stealth PDA before doing anything else.

→ [Burners and stealth PDAs](burners-and-stealth-pdas.md)

### Bookkeeping accounts

Delegation creates several accounts, all derived deterministically:

| Account | Seeds | Owning program | Purpose |
|---|---|---|---|
| Delegation record | `["delegation", stealth_pda]` | Delegation program | Tracks that the account is delegated and to whom |
| Delegation metadata | `["delegation-metadata", stealth_pda]` | Delegation program | Delegation configuration |
| Delegation buffer | `["buffer", stealth_pda]` | **shredr program** | Stages state during settlement |
| Permission account | `["permission:", stealth_pda]` | Permission program (`ACLseo...`) | ACL — who may act on the account in the rollup |

The buffer being owned by the *delegated account's owner program* rather than the delegation program is easy to get wrong; `deriveDelegationPDAs()` in `src/lib/ShredrProgram.ts` handles all four.

→ [PDA derivation](../program/pdas.md)

### The ACL permission

At delegation time shredr registers the burner as the sole ACL member:

```rust
let member = [Member {
    flags: MemberFlags::new(),
    pubkey: burner_key.clone(),
}];
```

Inside the rollup, this is the key permitted to act on the account. It is the same key `PrivateTransfer` checks against the PDA's recorded `owner`.

## Commit and undelegate

Two ways to get state back to Solana:

{% tabs %}
{% tab title="CommitStealth" %}
Flushes current rollup state to the base layer, **keeping the account delegated**.

Use when you want a base-layer checkpoint but intend to keep transacting in the rollup.

```typescript
createCommitStealthInstruction(relayer, stealthPda)
```

{% hint style="info" %}
Built and tested, but not used by the current app flow — shredr always commits and undelegates together.
{% endhint %}
{% endtab %}

{% tab title="CommitAndUndelegateStealth" %}
Flushes state **and** releases the account back to the base layer.

This is what shredr actually uses: on the drained stealth PDA after every shred, and on the main PDA before a withdrawal.

```typescript
createCommitAndUndelegateStealthInstruction(relayer, stealthPda)
```
{% endtab %}
{% endtabs %}

Both are sent to the **rollup RPC** — the MagicBlock program schedules the settlement from inside the rollup.

### Undelegation is asynchronous

This trips people up. `commitAndUndelegate()` returning a signature does **not** mean the account is back.

What happens after:

```
   commit_and_undelegate_accounts  (in rollup)
              │
              ▼
   MagicBlock schedules settlement
              │
              ▼
   Delegation program writes buffered state to base layer
              │
              ▼
   Delegation program recreates the account
              │
              ▼
   Calls shredr's UndelegationCallback (discriminator 0xFF)
              │
              ▼
   Callback copies state back, sets delegated = false
              │
              ▼
   Account is now usable on the base layer
```

That whole chain takes time. `waitForUndelegation()` polls the base layer until `delegated == false`:

```typescript
await shredrClient.waitForUndelegation(pda);
// polls every 2s, throws after 120s
```

Constants: `UNDELEGATION_POLL_INTERVAL_MS = 2_000`, `UNDELEGATION_TIMEOUT_MS = 120_000`.

### The callback's critical line

`undelegate()` recreates the base-layer account and copies the buffered rollup state back **verbatim** — including `delegated = true`, which was written at initialization and never changed inside the rollup.

So the callback must clear it explicitly:

```rust
undelegate(stealth_account, program_id, buffer_account, payer, ix_data)?;

let stealth_state = get_stealth_mut(stealth_account)?;
stealth_state.delegated = false;
```

Without this, `Withdraw` would reject every attempt with `AlreadyDelegated` and the funds would be unreachable forever.

→ [UndelegationCallback reference](../program/instructions/undelegation-callback.md)

## The TEE validator

Validators run inside a trusted execution environment. shredr selects one at **build time** via Cargo features:

```rust
#[cfg(feature = "mainnet")]
pub fn tee_validator() -> Option<Address> {
    Some(Address::from_str_const(TEE_VALIDATOR_MAINNET))
}

#[cfg(not(feature = "mainnet"))]
pub fn tee_validator() -> Option<Address> {
    None
}
```

| Build | Validator |
|---|---|
| `cargo build-sbf` (default `devnet`) | `None` — the delegation program picks the network default |
| `cargo build-sbf --features mainnet` | Pinned to `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo` |

Devnet deliberately pins nothing, because hardcoding a devnet validator identity would be invalid on-chain there.

## Why the main PDA stays delegated

After each shred, shredr undelegates the drained stealth PDA but leaves the main PDA in the rollup. Two reasons:

1. **It must be delegated to receive private transfers.** Both sides of a `PrivateTransfer` live in the rollup.
2. **It cannot be re-delegated once released.** `InitializeAndDelegate` refuses an account that already has lamports, so an undelegated main PDA is permanently on the base layer.

That second point has a real consequence: **withdraw fully before shredding again**, since withdrawing undelegates your main PDA.

→ [Limitations](../reference/limitations.md)

## Constants

| Constant | Value |
|---|---|
| Rollup RPC (devnet) | `https://devnet.magicblock.app` |
| Rollup WSS (devnet) | `wss://devnet.magicblock.app` |
| Delegation program | `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh` |
| Magic context (singleton) | `MagicContext1111111111111111111111111111111` |
| Permission program | `ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1` |
| TEE validator (mainnet) | `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo` |

Defined in `src/lib/constants.ts` (source of truth) and mirrored in `shredr-program/src/constants.rs`.

## Further reading

* [MagicBlock documentation](https://docs.magicblock.gg/)
* `ephemeral-rollups-pinocchio` v0.11.2 — the crate providing `delegate_account`, `commit_accounts`, `commit_and_undelegate_accounts`, and `undelegate`

## Next

* [The Kora relayer](relayer.md) — the other external dependency
* [The shred lifecycle](shred-lifecycle.md) — where each instruction fits
