---
description: "The Pinocchio Solana program that owns stealth accounts and enforces the rules."
icon: microchip
---

# On-chain program overview

`shredr-program/` — a zero-dependency [Pinocchio](https://github.com/anza-xyz/pinocchio) Solana program that manages stealth PDAs and moves lamports between them inside a MagicBlock ephemeral rollup.

**Program ID (devnet):** `H9pUQeNA2RwBHRwx52V8nqWpCAKReSA3gGUuRFHbEjG6`

## What it is responsible for

The program is the enforcement layer. It does not decide *what* to do — the client does that — but it decides what is *allowed*:

* only the recorded owner can move a stealth PDA's funds,
* funds cannot leave while the account is delegated,
* an account cannot be initialized twice,
* balances stay consistent and rent-exemption is never breached,
* accounts passed in must actually be the PDAs they claim to be.

## Why Pinocchio

Pinocchio is a zero-dependency, zero-copy framework. Compared to Anchor it gives:

* **Much lower compute-unit cost** — direct byte manipulation instead of serialization layers
* **No hidden allocations** — `#![no_std]`, no heap
* **Explicit control** — every account check is code you wrote

The trade-off is that safety is your responsibility: no automatic discriminator checks, no automatic ownership validation. shredr does these manually in `helpers.rs`, and the `unsafe` casts there are guarded by explicit precondition checks.

## Layout

```
shredr-program/
├── src/
│   ├── lib.rs                    # Entrypoint + instruction dispatch
│   ├── state.rs                  # StealthAccount and reserved structs
│   ├── constants.rs              # Seeds, program IDs, denominations
│   ├── errors.rs                 # ShredrError (6000-6011)
│   ├── helpers.rs                # PDA derivation, safe state access
│   ├── instructions/
│   │   ├── initialize_delegate.rs
│   │   ├── private_transfer.rs
│   │   ├── commit_undelegate.rs  # CommitStealth, CommitAndUndelegate, callback
│   │   ├── withdraw.rs
│   │   └── idl.rs
│   └── idl/shredr_program.json
├── tests/test.rs                 # Mollusk SVM tests
├── benches/compute_units.rs      # Compute-unit benchmarks
└── Cargo.toml
```

## Dispatch

`lib.rs` reads the first instruction byte:

| Byte | Instruction | Caller |
|---|---|---|
| `0` | `InitializeAndDelegate` | Client |
| `1` | `PrivateTransfer` | Client (inside the rollup) |
| `2` | `CommitStealth` | Client |
| `3` | `CommitAndUndelegateStealth` | Client |
| `4` | `Withdraw` | Client |
| `0xFF` | `UndelegationCallback` | **Delegation program only** |

Anything else returns `InvalidInstructionData`.

Each variant parses via `TryFrom<(&[AccountView], &[u8])>` — which is where account and signer validation lives — and then runs `process()`. Parsing and execution are cleanly separated: if `try_from` succeeds, the accounts are known-good.

With the `logging` feature enabled, the instruction name is emitted via `pinocchio_log`.

## Dependencies

| Crate | Version | Purpose |
|---|---|---|
| `pinocchio` | 0.10.2 | Core framework |
| `pinocchio-system` | 0.5.0 | System Program CPIs |
| `pinocchio-pubkey` | 0.3.0 | `declare_id!` |
| `pinocchio-log` | 0.5.1 | Optional logging |
| `ephemeral-rollups-pinocchio` | 0.11.2 | MagicBlock delegation, commit, ACL |
| `bytemuck` | 1.14 | Byte casting |
| `shank` | 0.4.8 | IDL generation |

Dev: `mollusk-svm` 0.14, `mollusk-svm-bencher`, and the Solana account/instruction/pubkey crates.

## Features

| Feature | Effect |
|---|---|
| `devnet` (default) | No pinned TEE validator — the delegation program picks the network default |
| `mainnet` | Pins `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo` |
| `logging` | Emit instruction names |

## Security invariants

Enforced across the instruction handlers:

<details>
<summary><strong>PDAs are always re-derived, never trusted</strong></summary>

`verify_stealth_pda()` recomputes the address from the burner and compares it to the account passed in. A caller cannot substitute a different account.
</details>

<details>
<summary><strong>Discriminator before state</strong></summary>

`SHREDRSA` (8 bytes) is written before any state, and checked before any read. Prevents type confusion — an account of a different shape cannot be reinterpreted as a `StealthAccount`.
</details>

<details>
<summary><strong>Ownership is checked against recorded state</strong></summary>

Both `PrivateTransfer` and `Withdraw` compare the signer to the PDA's stored `owner` field. A PDA can never sign, so this is how a keyless account is authorized.
</details>

<details>
<summary><strong>No re-initialization</strong></summary>

`InitializeAndDelegate` rejects any account with a non-zero lamport balance, so an existing stealth PDA cannot be reset.
</details>

<details>
<summary><strong>Delegation state gates withdrawal</strong></summary>

`Withdraw` refuses while `delegated == true` — funds can only leave on the base layer. The `UndelegationCallback` is what clears the flag.
</details>

<details>
<summary><strong>Rent-exemption floor</strong></summary>

`Withdraw` refuses any amount that would drop the account below its rent-exempt minimum, even if `deposited_amount` says otherwise. A safety net against lamport/state desync — dropping below rent would let the runtime reap the account and strand the residual lamports.
</details>

<details>
<summary><strong>No self-transfers</strong></summary>

`PrivateTransfer` rejects identical source and destination; `Withdraw` rejects a destination equal to the stealth account. Beyond being meaningless, the former would create two aliasing `&mut` references to the same bytes (undefined behavior) and the latter would produce a lamport imbalance the runtime rejects.
</details>

<details>
<summary><strong>Checked arithmetic everywhere</strong></summary>

Every lamport and `deposited_amount` operation uses `checked_add` / `checked_sub`, returning `ArithmeticOverflow` or `InsufficientFunds` rather than wrapping.
</details>

## Where to go

<table data-view="cards">
<thead><tr><th>Page</th><th>Contents</th></tr></thead>
<tbody>
<tr><td><a href="accounts-and-state.md">Accounts and state</a></td><td>The <code>StealthAccount</code> byte layout and field semantics</td></tr>
<tr><td><a href="pdas.md">PDA derivation</a></td><td>Every PDA the program and delegation flow use</td></tr>
<tr><td><a href="instructions/README.md">Instructions</a></td><td>Account tables, data layouts, and guards for all six</td></tr>
<tr><td><a href="errors.md">Errors</a></td><td>Codes 6000–6011 and what triggers them</td></tr>
<tr><td><a href="building-and-testing.md">Building and testing</a></td><td>Cargo, Mollusk, benchmarks, IDL regeneration</td></tr>
</tbody>
</table>
