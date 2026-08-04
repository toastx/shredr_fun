---
description: "Every shredr-specific term, defined once, in plain language."
icon: book-a
---

# Glossary

## shredr terms

**Burner**
: A one-time Solana keypair derived from your wallet signature plus a nonce. Its public key is the address you give a sender. After a deposit is shredded, the burner is retired and never reused.

**Main burner**
: A single permanent keypair derived from your signature with a different domain tag. It owns your main PDA and signs withdrawals. Unlike ordinary burners it does not rotate, and it carries a sentinel nonce index of `-1`.

**Stealth PDA**
: A program-owned account paired with a burner, derived as `["shredr_stealth_address", burner_pubkey]`. Deposits get swept into it. It has no private key — only the shredr program can move its lamports.

**Main PDA**
: The stealth PDA belonging to your main burner. This is where all your money consolidates. It is derived exactly the same way as any other stealth PDA; it is only "main" because its burner never rotates.

**Shred**
: The four-instruction sequence that takes a deposit sitting on a burner and lands it in your main PDA: sweep and delegate → ensure destination → private transfer → commit and undelegate.

**Nonce chain**
: The hash chain `nonce[0] = SHA256(masterSeed)`, `nonce[N] = SHA256(nonce[N-1])`. Each link produces one burner. It is forward-only: a later nonce never reveals an earlier one.

**Blob**
: A small encrypted payload holding your current nonce and index, stored on the backend so you can recover on another device. The server cannot decrypt it.

**Denomination**
: A normalized payment size (1, 10, 100, or 1000 SOL). Defined in the codebase but not auto-selected, so choosing one is up to the user — see [Limitations](../reference/limitations.md).

## Solana terms

**PDA (Program Derived Address)**
: An account address derived from seeds and a program ID, deliberately chosen to fall off the ed25519 curve so no private key exists for it. Only the owning program can authorize spending from it — which is why a PDA can hold funds safely.

**Bump**
: The extra byte tried during PDA derivation until the resulting address is off-curve. Stored so the address can be re-derived cheaply later.

**Lamport**
: The smallest unit of SOL. 1 SOL = 1,000,000,000 lamports.

**Rent-exemption**
: The minimum lamport balance an account must hold to avoid being reclaimed by the runtime. In shredr the relayer pays this when creating a stealth PDA, and the program refuses to let a withdrawal drop the account below it.

**CPI (Cross-Program Invocation)**
: One program calling another. shredr uses CPIs to the System Program (create account, transfer), the permission program (ACL), and the MagicBlock delegation program.

**Discriminator**
: A fixed byte prefix identifying an account's type. shredr writes `SHREDRSA` (8 bytes) at the start of every stealth account so a malicious account of a different shape cannot be passed in its place.

**Signer**
: An account whose private key authorized the transaction. A PDA can never be a signer in the ordinary sense — which is why shredr authorizes transfers via the burner recorded as the PDA's owner.

## MagicBlock terms

**Ephemeral rollup (ER)**
: A short-lived, high-speed execution environment that temporarily takes ownership of specific Solana accounts, runs transactions on them off the base layer, and settles results back. shredr uses one so the private transfer never appears as a public Solana transaction.

**Delegation**
: Handing an account over to a rollup validator. Once delegated, the account can only be modified inside the rollup; the base-layer copy is frozen.

**Undelegation**
: Releasing the account back to Solana. The rollup's final state is written back, the account is recreated on the base layer, and the owning program's `UndelegationCallback` runs.

**Commit**
: Flushing the rollup's current state to the base layer. `CommitStealth` does this and stays delegated; `CommitAndUndelegateStealth` does it and releases.

**TEE (Trusted Execution Environment)**
: Hardware-isolated execution where even the machine's operator cannot inspect what runs inside. MagicBlock's validators run in one, which is what makes the in-rollup transfer private rather than merely off-chain.

**Delegation record / metadata / buffer**
: Bookkeeping accounts the delegation program uses to track a delegated account and stage its state during settlement. shredr derives all three deterministically — see [PDA derivation](../program/pdas.md).

**Permission account**
: An ACL account listing who may act on a delegated account inside the rollup. shredr registers the burner as the sole member at delegation time.

## Infrastructure terms

**Kora**
: A Solana paymaster/relayer. It signs transactions as fee payer so users never need funded accounts. shredr also passes it as the on-chain `relayer` account where instructions require one.

**Helius**
: The RPC provider shredr uses for base-layer reads, WebSocket account subscriptions, and (on the backend) webhook management.

**Codama**
: The tool that generates the TypeScript client in `src/generated` from the program's IDL. Regenerate with `npm run generate:client`.

**Pinocchio**
: A zero-dependency, zero-copy Solana program framework. shredr's program is built on it for low compute-unit cost.

**Mollusk**
: A lightweight SVM test harness. The program's tests and compute-unit benchmarks run under it.
