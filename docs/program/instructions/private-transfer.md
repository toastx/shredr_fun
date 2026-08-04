---
description: "Move lamports between two stealth PDAs inside the MagicBlock rollup."
icon: shuffle
---

# PrivateTransfer

**Discriminator:** `1` · **Layer:** **rollup** · **Signer:** source burner

The instruction that provides the privacy. It executes inside the ephemeral rollup, so it is not a public Solana transaction and leaves no trace on the base layer connecting the two accounts.

## Accounts

| # | Account | Signer | Writable | Description |
|---|---|---|---|---|
| 0 | `source_burner` | ✓ | | Burner that owns the source PDA — authorizes the transfer |
| 1 | `source_pda` | | ✓ | Source stealth PDA |
| 2 | `destination_pda` | | ✓ | Destination stealth PDA (usually the main PDA) |

Note that `source_burner` is a **signer but not writable** — it does not pay anything here. Kora is the fee payer.

## Instruction data

```
[0]      discriminator = 1
[1..9]   amount: u64 little-endian
```

Parsed with `parse_amount()`: exactly 8 bytes, and **non-zero**.

## How a keyless account is authorized

A PDA can never sign a transaction. So the transfer is authorized by the burner recorded as the source PDA's owner:

```rust
if &source_data.owner != source_burner.address() {
    return Err(ProgramError::IllegalOwner);
}
```

The burner signs the transaction, and the program checks that signer against the `owner` field written at initialization — the same key registered as the ACL member during delegation.

Two independent things must line up:

* the ACL says the burner may act on this account inside the rollup,
* the account state says the burner owns it.

## What it does

```rust
// Debit source
let new_source_lamports = source_pda.lamports().checked_sub(amount)
    .ok_or(ProgramError::InsufficientFunds)?;
source_pda.set_lamports(new_source_lamports);
source_data.deposited_amount = source_data.deposited_amount.checked_sub(amount)
    .ok_or(ProgramError::InsufficientFunds)?;

// Credit destination
let new_dest_lamports = destination_pda.lamports().checked_add(amount)
    .ok_or(ProgramError::ArithmeticOverflow)?;
destination_pda.set_lamports(new_dest_lamports);
destination_data.deposited_amount = destination_data.deposited_amount.checked_add(amount)
    .ok_or(ProgramError::ArithmeticOverflow)?;
```

Both the raw lamports **and** `deposited_amount` are updated on both sides, keeping the invariant `lamports = rent + deposited_amount` intact for each account.

Every operation is checked arithmetic.

### Why `set_lamports` rather than a CPI

Inside a MagicBlock ephemeral rollup, the program owns both accounts and CPI to the System Program may not be available. Direct lamport manipulation is valid here precisely because the program is the owner of both.

On the base layer this would be unusual; inside the rollup it is the correct approach.

## Validation

Everything happens in `try_from` before `process()` runs:

| Check | Error |
|---|---|
| At least 3 accounts | `NotEnoughAccountKeys` |
| Data is exactly 8 bytes, non-zero | `InvalidInstructionData` |
| `source_pda != destination_pda` | `SelfTransferNotAllowed` (6011) |
| Source burner signs | `MissingSigner` (6007) |
| Source PDA owned by shredr | `InvalidProgramOwner` (6001) |
| Destination PDA owned by shredr | `InvalidDestinationOwner` (6006) |

Then in `process()`:

| Check | Error |
|---|---|
| Signer matches `source_data.owner` | `IllegalOwner` |
| `deposited_amount >= amount` | `InsufficientFunds` |

{% hint style="danger" %}
**The self-transfer check is a memory-safety guard, not just a sanity check.**

Passing the same account as both source and destination would make `get_stealth_mut()` hand out two aliasing `&mut StealthAccount` references to the same bytes — undefined behavior, and a violation of that helper's documented safety contract. It would also be a meaningless no-op.
{% endhint %}

## Client usage

```typescript
const ix = createPrivateTransferInstruction(
  sourceBurnerPubkey,
  sourcePda,
  destinationPda,
  BigInt(amountLamports),
);

// MUST go to the rollup connection
await koraRelayer.signAndSendOn(rollupConnection, [ix], [sourceBurnerKeypair]);
```

Or via the client:

```typescript
await shredrClient.privateTransferToMainPda(sourceBurner, BigInt(lamports));
```

{% hint style="warning" %}
**Use `signAndSendOn`, not `signAndSend`.**

`signAndSend` lets Kora broadcast on whatever RPC it is configured with — the base layer. This transaction is built on a *rollup blockhash* and must reach the *rollup RPC*. `signAndSendOn` has Kora sign only, then the client broadcasts to the rollup.
{% endhint %}

## Preconditions

Both PDAs must already be:

* created and owned by the shredr program,
* delegated to the rollup,
* live in the rollup the transaction is sent to.

`ShredrClient.shredBurner()` guarantees this by running `initializeAndDelegate` and `ensureMainPdaDelegated` first.

## Common failures

<details>
<summary><strong><code>IllegalOwner</code></strong></summary>

The signing burner does not match the source PDA's `owner`. Usually means the wrong burner was derived — check the nonce index.
</details>

<details>
<summary><strong><code>InvalidProgramOwner</code> (6001) or <code>InvalidDestinationOwner</code> (6006)</strong></summary>

One of the accounts is not a shredr-owned PDA. Most often the destination main PDA has not been created yet — `ensureMainPdaDelegated()` exists to prevent this.
</details>

<details>
<summary><strong><code>InsufficientFunds</code></strong></summary>

`deposited_amount` is less than the requested amount. Note this checks the **tracked** amount, not raw lamports, so the rent-exemption is correctly excluded.
</details>

<details>
<summary><strong>Transaction not found / blockhash errors</strong></summary>

Almost always sending to the wrong RPC. Delegated accounts do not exist on the base layer.
</details>

## Next

* [CommitAndUndelegateStealth](commit-and-undelegate.md) — the step after
* [Ephemeral rollups](../../concepts/ephemeral-rollups.md) — why this is private
