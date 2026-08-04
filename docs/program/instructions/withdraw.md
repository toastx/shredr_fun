---
description: "Withdraw lamports from an undelegated stealth PDA to any destination."
icon: money-bill-transfer
---

# Withdraw

**Discriminator:** `4` · **Layer:** base · **Signer:** owner (burner)

The exit. Moves lamports from a stealth PDA to any destination address. In shredr's flow this is always the **main PDA**, signed by the **main burner**.

## Accounts

| # | Account | Signer | Writable | Description |
|---|---|---|---|---|
| 0 | `owner` | ✓ | ✓ | Burner keypair recorded as the PDA's owner |
| 1 | `stealth_account` | | ✓ | Stealth PDA holding the funds |
| 2 | `destination` | | ✓ | Any address to receive the lamports |

The destination is unconstrained — any wallet, any account. It does not need to be related to shredr in any way.

## Instruction data

```
[0]      discriminator = 4
[1..9]   amount: u64 little-endian
```

Parsed with `parse_amount()`: exactly 8 bytes, **non-zero**.

## What it does

```rust
// 1. Ownership
if &stealth_data.owner != owner.address() {
    return Err(ProgramError::IllegalOwner);
}

// 2. Must be on the base layer
if stealth_data.delegated {
    return Err(ShredrError::AlreadyDelegated.into());
}

// 3. Sufficient tracked balance
if stealth_data.deposited_amount < amount {
    return Err(ProgramError::InsufficientFunds);
}

// 4. Rent-exemption floor
let rent_minimum = rent.try_minimum_balance(stealth_account.data_len())?;
if new_stealth_lamports < rent_minimum {
    return Err(ShredrError::BalanceInvariantViolation.into());
}

// 5. Move
stealth_account.set_lamports(new_stealth_lamports);
destination.set_lamports(new_destination_lamports);
stealth_data.deposited_amount -= amount;

// 6. Zero on full drain
if stealth_data.deposited_amount == 0 {
    stealth_data.owner = Address::default();
    stealth_data.delegated = false;
    stealth_data.bump = 0;
}
```

### The rent-exemption floor

This is the interesting guard. `deposited_amount` already excludes rent, so a well-formed withdrawal (`amount <= deposited_amount`) always leaves at least the rent-exempt minimum.

The explicit floor check is a **safety net against desync**. If `deposited_amount` ever drifted above the account's real lamports, a withdrawal could drop the balance below rent — and the runtime would reap the account, stranding the residual lamports permanently.

Better to fail loudly with `BalanceInvariantViolation` than to lose funds.

### Zeroing on full drain

When the last lamport of `deposited_amount` leaves, the state is cleared. The account still exists (holding the relayer's rent), but it no longer claims an owner or a delegation status.

## Validation

In `try_from`:

| Check | Error |
|---|---|
| At least 3 accounts | `NotEnoughAccountKeys` |
| Data exactly 8 bytes, non-zero | `InvalidInstructionData` |
| `destination != stealth_account` | `SelfTransferNotAllowed` (6011) |
| Owner signs | `MissingSigner` (6007) |

In `process()`:

| Check | Error |
|---|---|
| Signer matches `owner` | `IllegalOwner` |
| Not delegated | `AlreadyDelegated` (6004) |
| `deposited_amount >= amount` | `InsufficientFunds` |
| Result stays rent-exempt | `BalanceInvariantViolation` (6009) |

{% hint style="info" %}
**Why reject a self-destination?** The paired `set_lamports` calls would credit the account without a matching debit, which the Solana runtime rejects as a lamports imbalance. Failing early with a clear error beats an opaque runtime failure.
{% endhint %}

## Client usage

```typescript
const ix = createStealthWithdrawInstruction(
  mainBurnerPubkey,
  mainPda,
  destinationPubkey,
  BigInt(amountLamports),
);

await koraRelayer.signAndSend(connection, [ix], [mainBurnerKeypair]);
```

Or the full flow, which handles undelegation for you:

```typescript
const { signature, amount } = await shredrClient.withdrawToWallet(
  "DestinationAddressBase58",
  "all",     // or a number of SOL
);
```

`withdrawToWallet()`:

1. Fetches the main PDA state (throws if never initialized)
2. If delegated: commits, undelegates, and **polls** until settlement
3. Reads `depositedAmount` as the withdrawable ceiling
4. Validates the requested amount
5. Signs with the main burner, Kora pays

## How much can you withdraw?

**Only `deposited_amount`** — not the account's raw lamport balance.

```
account lamports = rent-exempt minimum  +  deposited_amount
                   (relayer's, locked)     (yours, withdrawable)
```

This is why the app's balance differs from what a block explorer shows for the same account. `getStealthBalance()` reads the tracked amount:

```typescript
const state = await this.fetchStealthState(this._mainPda);
const lamports = state ? Number(state.depositedAmount) : 0;
```

## Common failures

<details>
<summary><strong><code>AlreadyDelegated</code> (6004)</strong></summary>

The account is still in the rollup. Commit and undelegate first, then **wait for settlement** — `waitForUndelegation()` does this.

This is also the error you would see forever if `UndelegationCallback` failed to clear the `delegated` flag, which is why that one line in the callback matters so much.
</details>

<details>
<summary><strong><code>IllegalOwner</code></strong></summary>

The signer is not the PDA's recorded owner. For the main PDA this means the main burner was derived incorrectly — check that the signed message matches exactly (`SHREDR_V1:<wallet>`) and that the same wallet is connected.
</details>

<details>
<summary><strong><code>InsufficientFunds</code></strong></summary>

Requested more than `deposited_amount`. The client pre-checks this and throws a clearer message:

> Requested N lamports but only M are withdrawable
</details>

<details>
<summary><strong><code>BalanceInvariantViolation</code> (6009)</strong></summary>

The withdrawal would break rent-exemption. Should be unreachable in normal operation — it indicates `deposited_amount` has drifted from the real lamport balance. Worth investigating rather than working around.
</details>

<details>
<summary><strong>Timeout waiting for undelegation</strong></summary>

`waitForUndelegation` throws after 120 seconds. The commit was submitted and may still land. Retry — the second attempt will find the account already undelegated.
</details>

## Next

* [Errors](../errors.md) — every code
* [The shred lifecycle](../../concepts/shred-lifecycle.md)
