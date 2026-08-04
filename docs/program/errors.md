---
description: "Every shredr error code, what triggers it, and how to fix it."
icon: triangle-exclamation
---

# Errors

shredr defines twelve custom errors, numbered **6000–6011**. The offset avoids collision with built-in Solana error codes.

```rust
impl From<ShredrError> for ProgramError {
    fn from(e: ShredrError) -> ProgramError {
        ProgramError::Custom(e as u32)
    }
}
```

## The codes

| Code | Name | Meaning |
|---|---|---|
| 6000 | `InvalidStealthPDA` | The account does not match the expected PDA derivation |
| 6001 | `InvalidProgramOwner` | The account is not owned by the shredr program |
| 6002 | `AccountDataTooSmall` | Data too short to hold a `StealthAccount` |
| 6003 | `InvalidDiscriminator` | The first 8 bytes are not `SHREDRSA` |
| 6004 | `AlreadyDelegated` | The account is delegated when it must not be |
| 6005 | `NotDelegated` | The account is not delegated when it must be |
| 6006 | `InvalidDestinationOwner` | The destination is not owned by the shredr program |
| 6007 | `MissingSigner` | A required signer did not sign |
| 6008 | `ClockUnavailable` | The Clock or Rent sysvar could not be read |
| 6009 | `BalanceInvariantViolation` | The operation would break the rent-exemption invariant |
| 6010 | `AccountAlreadyInitialized` | Attempted to initialize an existing account |
| 6011 | `SelfTransferNotAllowed` | Source and destination are the same account |

## In detail

<details>
<summary><strong>6000 — InvalidStealthPDA</strong></summary>

**Raised by:** `verify_stealth_pda()` in `InitializeAndDelegate`

The account passed as `stealth_account` is not `PDA(["shredr_stealth_address", burner_pubkey])` under the shredr program.

**Causes:** wrong burner pubkey; wrong seed string; wrong program ID; a hand-built instruction with a mismatched account.

**Fix:** use `deriveStealthPDA(burnerPubkey)` rather than deriving by hand.
</details>

<details>
<summary><strong>6001 — InvalidProgramOwner</strong></summary>

**Raised by:** `get_stealth_mut()`, and `PrivateTransfer`'s source check

The account is not owned by `H9pUQeNA2RwBHRwx52V8nqWpCAKReSA3gGUuRFHbEjG6`.

**Causes:** the PDA has not been created yet; a wrong account was passed; the account belongs to a different program.

**Fix:** run `InitializeAndDelegate` first. For a private transfer, `ensureMainPdaDelegated()` guarantees the destination exists.
</details>

<details>
<summary><strong>6002 — AccountDataTooSmall</strong></summary>

**Raised by:** `get_stealth_mut()`, `write_stealth_discriminator()`

`data_len() < 8 + size_of::<StealthAccount>()` (96 bytes).

**Causes:** an account created with the wrong size; a non-shredr account passed by mistake.

**Fix:** should not occur in normal operation — the program always allocates the correct size. Indicates a malformed account.
</details>

<details>
<summary><strong>6003 — InvalidDiscriminator</strong></summary>

**Raised by:** `get_stealth_mut()`

The first 8 bytes are not `SHREDRSA`.

**Causes:** an account of a different type; corrupted data; a **type-confusion attack attempt**.

**Fix:** verify you are passing an actual shredr stealth account.
</details>

<details>
<summary><strong>6004 — AlreadyDelegated</strong></summary>

**Raised by:** `Withdraw`

The account is still delegated to the rollup. Funds can only move on the base layer.

**Fix:** commit and undelegate, then **wait for settlement**:

```typescript
await shredrClient.commitAndUndelegate(pda);
await shredrClient.waitForUndelegation(pda);
```

**If this persists after a successful undelegation**, the `UndelegationCallback` did not clear the flag — see [UndelegationCallback](instructions/undelegation-callback.md).
</details>

<details>
<summary><strong>6005 — NotDelegated</strong></summary>

**Defined but not raised** by any current instruction. Reserved for a future check requiring an active delegation.
</details>

<details>
<summary><strong>6006 — InvalidDestinationOwner</strong></summary>

**Raised by:** `PrivateTransfer`

The destination PDA is not owned by the shredr program.

**Causes:** the main PDA has not been initialized; a non-shredr account was passed.

**Fix:** call `ensureMainPdaDelegated()` before transferring.
</details>

<details>
<summary><strong>6007 — MissingSigner</strong></summary>

**Raised by:** `InitializeAndDelegate` (relayer and burner), `PrivateTransfer` (source burner), `Withdraw` (owner)

**Causes:** Kora did not sign (misconfiguration, wrong pubkey, service down); a client keypair was not passed to `signAndSend`.

**Fix:** check `KORA_RELAYER_PUBKEY` matches Kora's actual signing key, and that the burner keypair is in the signers array.

Note the commit instructions raise `MissingRequiredSignature` (a built-in) rather than this code.
</details>

<details>
<summary><strong>6008 — ClockUnavailable</strong></summary>

**Raised by:** `InitializeAndDelegate` — used for both `Clock::get()` and `Rent::get()` failures

**Causes:** should never occur on a real validator. Usually a test-harness misconfiguration where sysvars are not set up.

**Fix:** in Mollusk tests, ensure the sysvars are provided.
</details>

<details>
<summary><strong>6009 — BalanceInvariantViolation</strong></summary>

**Raised by:** `Withdraw`

The withdrawal would drop the account below its rent-exempt minimum.

**Why it exists:** `deposited_amount` excludes rent, so a well-formed withdrawal can never trigger this. It is a safety net against `deposited_amount` drifting above the real lamport balance — dropping below rent would let the runtime reap the account and strand the residual lamports.

**Fix:** investigate rather than work around. It indicates a state inconsistency.
</details>

<details>
<summary><strong>6010 — AccountAlreadyInitialized</strong></summary>

**Raised by:** `InitializeAndDelegate`

`stealth_account.lamports() > 0` — the account already exists.

**Causes:**
* Trying to shred the same burner twice
* Trying to re-delegate a main PDA that was undelegated by a withdrawal
* **Someone sent funds directly to the stealth PDA instead of the burner**

That last case is unrecoverable through the app: the PDA can never be initialized, so those funds are stuck. It is why the UI only ever shows the burner address.

**Fix:** for the main PDA case, withdraw fully before shredding again. See [Limitations](../reference/limitations.md).
</details>

<details>
<summary><strong>6011 — SelfTransferNotAllowed</strong></summary>

**Raised by:** `PrivateTransfer` (source == destination), `Withdraw` (destination == stealth account)

More than a sanity check:

* In `PrivateTransfer`, aliasing would produce two `&mut StealthAccount` references to the same bytes — undefined behavior.
* In `Withdraw`, the paired `set_lamports` calls would credit without a matching debit, which the runtime rejects as a lamports imbalance.

**Fix:** pass distinct accounts.
</details>

## Client-side lookup

```typescript
import { getShredrErrorMessage } from './lib/ShredrProgram';

getShredrErrorMessage(6004);  // "The stealth account is already delegated."
getShredrErrorMessage(1);     // null — not a shredr error
```

Returns `null` outside 6000–6011, which lets you distinguish shredr errors from System Program or delegation-program errors:

```typescript
const message = getShredrErrorMessage(code);
if (message) {
  console.error("Shredr error:", message);
} else {
  console.error("Non-shredr error:", code);
}
```

## Non-shredr errors you will see

From Pinocchio's built-in `ProgramError`:

| Error | Raised by |
|---|---|
| `IllegalOwner` | `PrivateTransfer`, `Withdraw` — signer does not match the recorded `owner` |
| `InsufficientFunds` | `PrivateTransfer`, `Withdraw` — `deposited_amount` too low |
| `ArithmeticOverflow` | Any checked-add that would overflow |
| `InvalidInstructionData` | Unknown discriminator, wrong data length, or a zero amount where non-zero is required |
| `NotEnoughAccountKeys` | Too few accounts |
| `MissingRequiredSignature` | The commit instructions, when the relayer did not sign |
| `InvalidAccountData` | PDA derivation failure in `derive_stealth_account_from_pubkey` |

You may also see errors originating from the System Program, the MagicBlock delegation program, or the permission program during CPIs — those carry their own codes and are not translated by shredr.

## Next

* [Troubleshooting](../reference/troubleshooting.md) — symptom-first debugging
* [Instructions](instructions/README.md) — where each check lives
