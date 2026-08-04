---
description: "All six instructions at a glance."
icon: list-ol
---

# Instructions

Six instructions, dispatched on the first byte of the instruction data.

| Byte | Instruction | Layer | Signers | Purpose |
|---|---|---|---|---|
| `0` | [InitializeAndDelegate](initialize-and-delegate.md) | Base | Relayer + burner | Create the stealth PDA, sweep the deposit, delegate |
| `1` | [PrivateTransfer](private-transfer.md) | **Rollup** | Source burner | Move lamports between stealth PDAs |
| `2` | [CommitStealth](commit-stealth.md) | **Rollup** | Relayer | Flush state, stay delegated |
| `3` | [CommitAndUndelegateStealth](commit-and-undelegate.md) | **Rollup** | Relayer | Flush state, release to base layer |
| `4` | [Withdraw](withdraw.md) | Base | Owner (burner) | Withdraw to any destination |
| `0xFF` | [UndelegationCallback](undelegation-callback.md) | Base | — (CPI) | Called by the delegation program after settlement |

## Dispatch

```rust
let (discriminator, data) = instruction_data
    .split_first()
    .ok_or(ProgramError::InvalidInstructionData)?;

let instruction = InstructionDiscriminator::from_byte(*discriminator)?;
```

Unknown bytes return `InvalidInstructionData`. Empty instruction data does too.

## The shape of every handler

Each instruction is a struct with a `TryFrom<(&[AccountView], &[u8])>` impl and a `process()` method:

```rust
pub struct Withdraw<'a> {
    pub owner: &'a AccountView,
    pub stealth_account: &'a AccountView,
    pub destination: &'a AccountView,
    pub amount: u64,
}

impl<'a> TryFrom<(&'a [AccountView], &'a [u8])> for Withdraw<'a> { /* validation */ }
impl<'a> Withdraw<'a> { pub fn process(self) -> ProgramResult { /* logic */ } }
```

**All account and signer validation happens in `try_from`.** By the time `process()` runs, the accounts are known-good. This separation makes the security surface easy to audit — every check is in one place per instruction.

## Amount parsing

`PrivateTransfer` and `Withdraw` use the shared helper:

```rust
pub fn parse_amount(data: &[u8]) -> Result<u64, ProgramError> {
    if data.len() != core::mem::size_of::<u64>() {
        return Err(ProgramError::InvalidInstructionData);
    }
    let amt = u64::from_le_bytes(data.try_into().unwrap());
    if amt == 0 {
        return Err(ProgramError::InvalidInstructionData);
    }
    Ok(amt)
}
```

Exactly 8 bytes, little-endian, and **non-zero**.

{% hint style="info" %}
`InitializeAndDelegate` parses its own u64 instead, because it must accept `0` — that is how an empty delegated PDA is created for the main PDA. It also checks `len() >= 8` rather than `== 8`.
{% endhint %}

## Which layer

Getting this wrong is the most common integration mistake. A delegated account only exists in the rollup; the base-layer copy is frozen.

{% tabs %}
{% tab title="Base layer" %}
Sent to the Helius RPC, via `koraRelayer.signAndSend()` (Kora broadcasts).

* `InitializeAndDelegate` — the PDA does not exist yet
* `Withdraw` — requires an undelegated account
* `UndelegationCallback` — invoked by the delegation program
{% endtab %}

{% tab title="Rollup" %}
Sent to `https://devnet.magicblock.app`, via `koraRelayer.signAndSendOn()` (client broadcasts).

* `PrivateTransfer` — both accounts are delegated
* `CommitStealth` / `CommitAndUndelegateStealth` — MagicBlock schedules settlement from inside the rollup

These are built on a **rollup blockhash**, so they must reach the rollup RPC or they are invalid.
{% endtab %}
{% endtabs %}

## Compute units

Measured by `cargo bench` (`benches/compute_units.rs`) via `mollusk-svm-bencher`. Pinocchio's zero-copy design keeps these low; run the benchmark to get current numbers for your build.

## Next

Start with [InitializeAndDelegate](initialize-and-delegate.md) — the most involved of the six.
