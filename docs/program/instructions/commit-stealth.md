---
description: "Flush rollup state to the base layer while staying delegated."
icon: floppy-disk
---

# CommitStealth

**Discriminator:** `2` · **Layer:** rollup · **Signer:** relayer

Writes the account's current rollup state to the base layer **without** releasing it. The account stays delegated and can keep transacting in the rollup.

{% hint style="info" %}
**Built and tested, but not used by the current app flow.** shredr always commits and undelegates together via [CommitAndUndelegateStealth](commit-and-undelegate.md).

It is available for a checkpointing pattern: settle intermediate state to the base layer while continuing to operate in the rollup.
{% endhint %}

## Accounts

| # | Account | Signer | Writable | Description |
|---|---|---|---|---|
| 0 | `relayer` | ✓ | ✓ | Pays the fee and authorizes the commit |
| 1 | `stealth_account` | | ✓ | Delegated stealth PDA to commit |
| 2 | `magic_program` | | | MagicBlock delegation program |
| 3 | `magic_context` | | | MagicBlock context (singleton) |

## Instruction data

```
[0]   discriminator = 2
```

No payload — the instruction data beyond the discriminator is ignored.

## What it does

```rust
if !relayer.is_signer() {
    return Err(ProgramError::MissingRequiredSignature);
}

commit_accounts(
    relayer,
    core::slice::from_ref(stealth_account),
    magic_context,
    magic_program,
    None,   // magic_fee_vault — pass Some(...) if your setup charges fees
    None,
)?;
```

A thin wrapper over `ephemeral_rollups_pinocchio::instruction::commit_accounts`. It commits exactly one account.

The two `None` arguments are the optional MagicBlock fee vault and an additional optional parameter. Pass `Some(fee_vault_account)` if your MagicBlock deployment charges commit fees.

## Validation

| Check | Error |
|---|---|
| At least 4 accounts | `NotEnoughAccountKeys` |
| Relayer signs | `MissingRequiredSignature` |

{% hint style="warning" %}
Signer validation happens in `process()` here, not in `try_from` — unlike most other instructions in this program. Functionally equivalent, but worth knowing if you are auditing the validation surface.
{% endhint %}

## Client usage

```typescript
const ix = createCommitStealthInstruction(
  relayerPubkey,
  stealthPda,
  magicProgram,   // defaults to MAGIC_BLOCK_PROGRAM_ID
  magicContext,   // defaults to MAGIC_CONTEXT
);

// Rollup RPC, no client signers — only the relayer signs
await koraRelayer.signAndSendOn(rollupConnection, [ix], []);
```

## Commit vs. commit-and-undelegate

| | `CommitStealth` | `CommitAndUndelegateStealth` |
|---|---|---|
| State written to base layer | Yes | Yes |
| Account released | **No** | Yes |
| Still usable in the rollup | Yes | No |
| `delegated` flag afterwards | Stays `true` | Becomes `false` (via callback) |
| `UndelegationCallback` fires | No | Yes |
| Withdrawable afterwards | No | Yes |
| Used by shredr today | No | Yes |

If your goal is to withdraw, you want the undelegating variant — `Withdraw` rejects a delegated account.

## Next

* [CommitAndUndelegateStealth](commit-and-undelegate.md)
* [Ephemeral rollups](../../concepts/ephemeral-rollups.md)
