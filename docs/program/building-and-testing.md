---
description: "Cargo commands, Mollusk tests, compute-unit benchmarks, and IDL regeneration."
icon: hammer
---

# Building and testing

## Prerequisites

* Rust 1.75+
* Solana CLI with `cargo build-sbf`
* Node 18+ (for regenerating the TypeScript client)

## Building

```bash
cd shredr-program

cargo build-sbf                      # devnet (default)
cargo build-sbf --features mainnet   # pin the mainnet TEE validator
cargo build-sbf --features logging   # emit instruction names
```

Output lands in `target/deploy/shredr_program.so`.

### Features

| Feature | Effect |
|---|---|
| `devnet` (default) | `tee_validator()` returns `None` — the delegation program picks the network default |
| `mainnet` | Pins `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo` |
| `logging` | Instruction names via `pinocchio_log` on every dispatch |

{% hint style="info" %}
Devnet deliberately pins **no** validator. Hardcoding a devnet validator identity would be invalid on-chain there, so the program lets MagicBlock choose.
{% endhint %}

## Deploying

```bash
solana program deploy target/deploy/shredr_program.so
```

The program ID is declared in `lib.rs`:

```rust
declare_id!("H9pUQeNA2RwBHRwx52V8nqWpCAKReSA3gGUuRFHbEjG6");
```

{% hint style="warning" %}
Deploying to a **new** program ID means updating it in three places:

1. `declare_id!` in `shredr-program/src/lib.rs`
2. The IDL (`shredr-program/idl/shredr_program.json`)
3. Regenerate the client: `npm run generate:client`

`src/lib/ShredrProgram.ts` reads the ID from the generated client, so step 3 propagates it to the frontend. Miss a step and PDA derivations silently diverge — the addresses will be wrong, not obviously broken.
{% endhint %}

## Testing

```bash
cargo test
```

Tests live in `tests/test.rs` and run under [Mollusk](https://github.com/anza-xyz/mollusk), a lightweight SVM harness — no validator, no network, fast.

`solana-pubkey` is pulled in with the `curve25519` feature so the host side of the tests can call `find_program_address` to derive stealth PDAs.

### What Mollusk gives you

* Direct instruction invocation with hand-built accounts
* Assertions on resulting account state
* Compute-unit measurement
* Millisecond-scale runs

### Writing one

The general shape:

```rust
// 1. Set up Mollusk with the program
// 2. Build the accounts (relayer, burner, stealth PDA, ...)
// 3. Construct the instruction data
// 4. Invoke and assert on the result and resulting state
```

Read `tests/test.rs` for the established patterns before adding cases.

## Benchmarks

```bash
cargo bench
```

`benches/compute_units.rs` uses `mollusk-svm-bencher` to measure compute units per instruction.

Compute units matter here: Pinocchio was chosen specifically for its low overhead, and a regression is a real cost. Run the benchmark before and after any change to instruction logic.

## The IDL

`shredr-program/idl/shredr_program.json` is the contract between the program and the TypeScript client. Copies also live at `src/idl/` and `tests/idl/`.

Generated with [Shank](https://github.com/metaplex-foundation/shank) annotations (`shank` 0.4.8 is a dependency, and `src/instructions/idl.rs` holds the definitions).

### After changing instructions

{% stepper %}
{% step %}
### Update the program

Change the handler, its accounts, or its data layout.
{% endstep %}

{% step %}
### Regenerate the IDL

Via Shank, then verify `shredr-program/idl/shredr_program.json` reflects the change.
{% endstep %}

{% step %}
### Regenerate the client

```bash
cd ../ && npm run generate:client
```

Runs `scripts/generate-client.mjs`, which drives Codama over the IDL and rewrites `src/generated/`.
{% endstep %}

{% step %}
### Run the frontend tests

```bash
npm test
```

`tests/ShredrProgram.test.ts` pins the wire format — 20 tests covering discriminators, PDA seeds, account metas, data layout, and error codes. **This is your guard against silent client/program drift.**
{% endstep %}

{% step %}
### Update the docs

Instruction reference pages under `docs/program/instructions/`.
{% endstep %}
{% endstepper %}

{% hint style="danger" %}
Skipping steps 3–4 means the client builds transactions against the old layout. They will fail on devnet with confusing errors rather than at compile time. The test suite exists to catch exactly this.
{% endhint %}

## Constants in two languages

`shredr-program/src/constants.rs` mirrors values from `src/lib/constants.ts` and says so:

> **NOTE**: Values here must remain consistent with the canonical client-side constants in `src/lib/constants.ts`. The TypeScript file is the source of truth — update it first, then mirror here.

Mirrored: PDA seeds, normalized denominations, commit delays, the fixed salt, and the MagicBlock/ACL program IDs.

{% hint style="warning" %}
Nothing enforces this. A Rust-side change that is not mirrored to TypeScript (or vice versa) compiles cleanly on both sides. Only the *wire format* is guarded, by `tests/ShredrProgram.test.ts`.
{% endhint %}

## Formatting and linting

```bash
cargo fmt      # rustfmt.toml is present
cargo clippy
```

## Code structure

If you are adding an instruction, follow the existing pattern:

```rust
pub struct YourInstruction<'a> {
    pub account_a: &'a AccountView,
    pub amount: u64,
}

// ALL validation goes here
impl<'a> TryFrom<(&'a [AccountView], &'a [u8])> for YourInstruction<'a> {
    type Error = ProgramError;
    fn try_from(value: (&'a [AccountView], &'a [u8])) -> Result<Self, Self::Error> {
        // account count, signers, ownership, data parsing
    }
}

// Only business logic here
impl<'a> YourInstruction<'a> {
    pub fn process(self) -> ProgramResult { /* ... */ }
}
```

Then add a discriminator in `lib.rs` and wire up the dispatch.

**Keep validation in `try_from`.** It is what makes the security surface auditable — every check for an instruction is in one place, and `process()` can assume its inputs are good.

### Rules to follow

* Use `get_stealth_mut()` for state access — never cast by hand
* Never hold two mutable references to the same account (reject aliasing explicitly)
* Use `checked_add` / `checked_sub` for every arithmetic operation
* Re-derive and verify PDAs; never trust a passed-in address
* Write the discriminator before any state, and check it before any read

## Next

* [Instructions](instructions/README.md)
* [Errors](errors.md)
