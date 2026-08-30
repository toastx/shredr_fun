---
description: "The StealthAccount layout, field semantics, and the balance invariant."
icon: table-cells
---

# Accounts and state

The program manages exactly one account type: the **stealth account**, stored in each stealth PDA.

## StealthAccount

```rust
#[repr(C)]
pub struct StealthAccount {
    pub owner: Address,             // 32 bytes
    pub receipt_commitment: [u8; 32], // 32 bytes — opaque, never read by the program
    pub deposited_amount: u64,      //  8 bytes
    pub deposit_timestamp: i64,     //  8 bytes
    pub delegated: bool,            //  1 byte
    pub bump: u8,                   //  1 byte
}
```

On-chain layout:

```
┌────────────────────────────────────────────┐
│ 0..8    discriminator "SHREDRSA"           │
├────────────────────────────────────────────┤
│ 8..40   owner (burner pubkey)              │
│ 40..72  receipt_commitment                 │
│ 72..80  deposited_amount (u64 LE)          │
│ 80..88  deposit_timestamp (i64 LE)         │
│ 88      delegated (bool)                   │
│ 89      bump (u8)                          │
│ 90..96  padding (repr(C) alignment)        │
└────────────────────────────────────────────┘
                Total: 96 bytes
```

`STEALTH_ACCOUNT_LEN = 96` in the client; the program computes `8 + size_of::<StealthAccount>()`.

The trailing padding comes from `#[repr(C)]` alignment: the struct contains 8-byte-aligned fields, so its size rounds up from 82 to 88 bytes.

## The discriminator

```rust
pub const STEALTH_ACCOUNT_DISCRIMINATOR: [u8; 8] =
    [0x53, 0x48, 0x52, 0x45, 0x44, 0x52, 0x53, 0x41];  // "SHREDRSA"
```

Written once during initialization, **before any state**, and verified before every read.

Without it, an attacker could pass an account of a different type whose bytes happen to parse as a plausible `StealthAccount` — a classic type-confusion attack. Pinocchio does not do this for you; shredr does it explicitly in `write_stealth_discriminator()` and `get_stealth_mut()`.

## Fields

### `owner`

The burner pubkey that controls this account. Written at initialization and checked on every operation that moves funds:

```rust
if &source_data.owner != source_burner.address() {
    return Err(ProgramError::IllegalOwner);
}
```

A PDA can never sign a transaction, so this field is how a keyless account is authorized: the burner signs, and the program checks the signer against `owner`. It is also the key registered as the ACL member at delegation time.

Zeroed to `Address::default()` when the account is fully drained.

### `receipt_commitment`

{% hint style="info" %}
**Opaque to the program.** Written verbatim from the instruction data and never read, so no handler can branch on it and it adds no authorization surface.

This slot was once a `salt` for PDA derivation. That was simplified to `["shredr_stealth_address", burner_pubkey]` — a one-time burner is unique on its own — leaving 32 rent-paid bytes doing nothing. They now hold the receipt commitment, which is why the layout, size and rent are all unchanged.

Every account carries one: a field only some clients populate would identify those clients. See [Viewing keys](../concepts/viewing-keys.md).
{% endhint %}

### `deposited_amount`

**The user's lamports, tracked separately from the account's raw balance.**

This is the most important field to understand. The account holds two kinds of lamports:

```
account lamports = rent-exempt minimum  +  deposited_amount
                   (paid by the relayer)   (the user's money)
```

Only `deposited_amount` is withdrawable. The relayer's rent stays in the account permanently, because withdrawing it would drop the account below rent-exemption and let the runtime reap it — stranding whatever was left.

This is why `ShredrClient.getStealthBalance()` reads `depositedAmount` rather than the lamport balance, and why the UI shows a smaller number than a block explorer would.

Updated atomically on both sides of a `PrivateTransfer`, and decremented on `Withdraw`.

### `deposit_timestamp`

Unix timestamp from the Clock sysvar at initialization. Set once, never updated.

Intended to support the randomized commit delay (`COMMIT_DELAY_MIN_SECS` / `MAX_SECS`), which is **not implemented**. Currently informational only.

### `delegated`

Whether the account is currently delegated to a MagicBlock validator.

| Set to | When |
|---|---|
| `true` | `InitializeAndDelegate` |
| `false` | `UndelegationCallback`, and on full drain in `Withdraw` |

`Withdraw` rejects with `AlreadyDelegated` while this is `true`, since funds can only move on the base layer.

{% hint style="warning" %}
`UndelegationCallback` must clear this **explicitly**. The delegation program copies the buffered rollup state back verbatim, and that state still carries `delegated = true` from initialization:

```rust
undelegate(stealth_account, program_id, buffer_account, payer, ix_data)?;
let stealth_state = get_stealth_mut(stealth_account)?;
stealth_state.delegated = false;
```

Without that line, `Withdraw` would reject forever and the funds would be permanently unreachable.
{% endhint %}

### `bump`

The PDA bump seed, stored so the address can be re-derived cheaply. Used to build signer seeds for the CPIs in `InitializeAndDelegate`. Zeroed on full drain.

## Safe access

`helpers.rs` provides the only sanctioned way to read or write the struct:

```rust
pub fn get_stealth_mut(account: &AccountView) -> Result<&mut StealthAccount, ProgramError>
```

Three checks before the `unsafe` cast:

1. The account is owned by the shredr program → else `InvalidProgramOwner`
2. `data_len() >= 8 + size_of::<StealthAccount>()` → else `AccountDataTooSmall`
3. The first 8 bytes match the discriminator → else `InvalidDiscriminator`

Only then does it cast:

```rust
unsafe {
    let data = account.borrow_unchecked_mut();
    if data[0..8] != STEALTH_ACCOUNT_DISCRIMINATOR {
        return Err(ShredrError::InvalidDiscriminator.into());
    }
    Ok(&mut *(data.as_mut_ptr().add(8) as *mut StealthAccount))
}
```

{% hint style="danger" %}
The function's documented safety contract is that **the caller must ensure no aliasing mutable references exist**. Calling it twice on the same account would produce two `&mut` to the same bytes — undefined behavior.

This is exactly why `PrivateTransfer` rejects self-transfers before doing anything:

```rust
if source_pda.address() == destination_pda.address() {
    return Err(ShredrError::SelfTransferNotAllowed.into());
}
```
{% endhint %}

`write_stealth_discriminator()` performs the same length check before its unsafe write, so it can never index out of bounds.

## Reserved structs

Defined in `state.rs` but never instantiated:

```rust
#[repr(C)]
pub struct UserAddress {
    pub owner: Address,
    pub available_balance: u64,
    pub total_ever_received: u64,
    pub bump: u8,
}

#[repr(C)]
pub struct ProgramConfig {
    pub admin_multisig: Address,
    pub paused: bool,
    pub min_flush_delay_secs: i64,
    pub bump: u8,
}
```

`UserAddress` was intended for per-user aggregation. `ProgramConfig` for admin features — storing the TEE validator per environment, pausing the program, setting minimum flush delays.

Their PDA seeds (`shredr_user_address`, `shredr_program_config`) exist in `constants.rs` and `SEEDS` on the client. **Neither is used by any instruction.**

## Client-side parsing

```typescript
const state = parseStealthAccount(new Uint8Array(accountInfo.data));
// null if too short or the discriminator does not match
```

```typescript
interface StealthAccountData {
  owner: PublicKey;
  receiptCommitment: Uint8Array;
  depositedAmount: bigint;
  depositTimestamp: bigint;
  delegated: boolean;
  bump: number;
}
```

Decoding uses the Codama-generated `getStealthAccountDecoder()`, so the layout stays in lockstep with the IDL.

## Next

* [PDA derivation](pdas.md)
* [Instructions](instructions/README.md)
