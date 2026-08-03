---
description: "Create a stealth PDA, sweep the burner's deposit into it, and delegate it to the rollup."
icon: play
---

# InitializeAndDelegate

**Discriminator:** `0` · **Layer:** base · **Signers:** relayer + burner

The most involved instruction. It creates the account, moves the money, writes the state, sets up permissions, and hands everything to MagicBlock — in one atomic transaction.

## Accounts

| # | Account | Signer | Writable | Description |
|---|---|---|---|---|
| 0 | `relayer` | ✓ | ✓ | Pays the transaction fee **and the PDA's rent** |
| 1 | `burner` | ✓ | ✓ | One-time burner keypair holding the deposit |
| 2 | `owner_program` | | | The shredr program's own address |
| 3 | `stealth_account` | | ✓ | Stealth PDA to create |
| 4 | `permission_account` | | ✓ | ACL permission account |
| 5 | `delegation_buffer` | | ✓ | MagicBlock delegation buffer |
| 6 | `delegation_record` | | ✓ | MagicBlock delegation record |
| 7 | `delegation_metadata` | | ✓ | MagicBlock delegation metadata |
| 8 | `system_program` | | | System Program |

## Instruction data

```
[0]      discriminator = 0
[1..9]   deposit_amount: u64 little-endian
```

`deposit_amount` is the lamports to sweep from the burner into the PDA.

{% hint style="info" %}
**`0` is valid here**, unlike other instructions. It creates an empty delegated PDA — exactly how the main PDA is prepared before it receives its first private transfer.

The handler parses its own u64 (checking `len() >= 8`) rather than using `parse_amount()`, which would reject zero.
{% endhint %}

The burner's identity comes from account 1, not from the data. No pubkey and no salt are passed — the one-time burner alone makes the PDA unique.

## What it does

{% stepper %}
{% step %}
### Verify the PDA

`verify_stealth_pda()` re-derives `["shredr_stealth_address", burner_pubkey]` and compares it to account 3. Mismatch → `InvalidStealthPDA`. Returns the bump for the CPI signer seeds.
{% endstep %}

{% step %}
### Guard against re-initialization

```rust
if stealth_account.lamports() > 0 {
    return Err(ShredrError::AccountAlreadyInitialized.into());
}
```

Zero lamports means uninitialized. This is the check that makes a stealth PDA one-shot.
{% endstep %}

{% step %}
### Create the account

A System Program CPI creates it with `space = 8 + size_of::<StealthAccount>()` = 96 bytes, owner = the shredr program, and `lamports = rent.try_minimum_balance(96)`.

**The relayer pays.** That is what keeps `deposited_amount` free of any lamports that are not the user's.
{% endstep %}

{% step %}
### Sweep the deposit

```rust
if deposit_amount > 0 {
    Transfer { from: burner, to: stealth_account, lamports: deposit_amount }.invoke()?;
}
```

The **burner signs** this — it is authorizing movement of its own received funds.
{% endstep %}

{% step %}
### Write state

Discriminator first (`write_stealth_discriminator`), then the struct:

```rust
stealth_state.owner             = burner_key.clone();
stealth_state.deposited_amount  = deposit_amount;
stealth_state.deposit_timestamp = clock.unix_timestamp;
stealth_state.delegated         = true;
stealth_state.bump              = bump;
```

Discriminator before state, always — it prevents type confusion.
{% endstep %}

{% step %}
### Create the ACL permission

```rust
let member = [Member { flags: MemberFlags::new(), pubkey: burner_key.clone() }];
CreatePermissionCpiBuilder::new(
    stealth_account, permission_account, relayer, system_program, &permission_program,
).members(MembersArgs { members: Some(&member) })
 .seeds(signer_seeds)
 .invoke()?;
```

The burner becomes the sole member allowed to act on this account inside the rollup — the same key `PrivateTransfer` later checks against `owner`.
{% endstep %}

{% step %}
### Delegate

```rust
let delegate_config = DelegateConfig {
    validator: tee_validator(),
    ..Default::default()
};

delegate_account(
    &[burner, stealth_account, owner_program,
      delegation_buffer, delegation_record, delegation_metadata, system_program],
    signer_seeds, bump, delegate_config,
)?;
```

`tee_validator()` returns `Some(...)` on a `mainnet` build and `None` on devnet (letting the delegation program pick the network default).

From here the base-layer account is frozen and lives in the rollup.
{% endstep %}
{% endstepper %}

The signer seeds used for both CPIs:

```rust
let signer_seeds: &[&[u8]] = &[seeds::STEALTH_ADDRESS, burner_key.as_array(), &bump_slice];
```

## Validation

| Check | Error |
|---|---|
| At least 9 accounts | `NotEnoughAccountKeys` |
| Relayer signs | `MissingSigner` (6007) |
| Burner signs | `MissingSigner` (6007) |
| Data at least 8 bytes | `InvalidInstructionData` |
| PDA matches derivation | `InvalidStealthPDA` (6000) |
| Account has zero lamports | `AccountAlreadyInitialized` (6010) |
| Clock available | `ClockUnavailable` (6008) |

## Client usage

```typescript
const ix = createInitializeAndDelegateInstruction(
  relayerPubkey,
  burnerPubkey,
  BigInt(depositLamports),
);

await koraRelayer.signAndSend(connection, [ix], [burnerKeypair]);
```

The builder derives the stealth PDA and all four delegation PDAs internally, so callers pass only two pubkeys and an amount.

```typescript
// Full balance (the default)
await shredrClient.initializeAndDelegate(burner);

// Empty delegated PDA — how the main PDA is created
await shredrClient.initializeAndDelegate(mainBurner, 0n);
```

## Common failures

<details>
<summary><strong><code>AccountAlreadyInitialized</code> (6010)</strong></summary>

The stealth PDA already has lamports. Either it was already initialized, or **someone sent funds directly to the PDA instead of the burner**.

The second case is unrecoverable through the app: the account can never be initialized, so those funds are stuck.

This is why the UI only ever displays the burner address.
</details>

<details>
<summary><strong>Cannot re-delegate an undelegated main PDA</strong></summary>

Once your main PDA has been committed and undelegated (which happens when you withdraw), it has lamports and cannot go back through `InitializeAndDelegate`.

`ShredrClient.ensureMainPdaDelegated()` detects this and throws a clear message rather than letting the transaction fail:

> Main PDA is undelegated and cannot be re-delegated. Withdraw its balance before shredding again.

→ [Limitations](../../reference/limitations.md)
</details>

<details>
<summary><strong><code>MissingSigner</code> (6007)</strong></summary>

Either the relayer or the burner did not sign. Usually a Kora configuration problem — check that `KORA_RELAYER_PUBKEY` matches the key Kora actually signs with.
</details>

<details>
<summary><strong><code>InvalidStealthPDA</code> (6000)</strong></summary>

The passed account is not the correct derivation for the burner. Check the seed string and the program ID on the client side.
</details>

## Next

* [PrivateTransfer](private-transfer.md) — the next step
* [The shred lifecycle](../../concepts/shred-lifecycle.md)
