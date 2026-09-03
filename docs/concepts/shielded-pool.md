---
description: "One vault holds everything, deposits publish a commitment, withdrawals publish a nullifier, and nothing on Solana pairs them up."
icon: layer-group
---

# The shielded pool

The original design moves value between two stealth PDAs inside the rollup. It works, and its weakness is arithmetic: the anonymity set is however many other cycles happen to overlap yours in time. On a quiet afternoon that is one.

A pool replaces "hide the hop" with "hide in the crowd". Every deposit goes into the same vault, every withdrawal comes out of it, and the set you hide in is every unspent note in the pool.

## The note

One 32-byte secret, picked client-side, never sent to the base layer. Two domain-separated hashes come off it:

```
commitment = sha256("SHREDR_NOTE_V1" || secret)    published when you deposit
nullifier  = sha256("SHREDR_NULL_V1" || secret)    published when you spend
```

That is the whole scheme. Given a commitment you cannot compute its nullifier and vice versa, so the base layer ends up holding two sets it cannot pair. There is no proof system and no trusted setup — the step that reveals a secret happens inside the enclave instead.

The domain tags are versioned. Changing either changes every note, so a new version is a new pool, not a migration.

## Why a tree, and why one PDA per spent note

Both are here for the same reason: **nothing in a pool may be capped by how many notes it holds.** A pool's size is exactly what makes it private, so a design that stops taking deposits stops working.

The obvious implementation — keep every commitment in an array and scan it — fails that twice over. Deposits are capped by whatever fits in an account, and the scan gets slower as the pool gets more useful.

**Commitments go into an incremental Merkle tree.** On-chain state is `DEPTH` nodes and a leaf counter, fixed forever. Inserting costs `DEPTH` hashes; proving membership costs `DEPTH` hashes. Capacity is `2^DEPTH` — 1,048,576 notes at the depth used here.

The leaves are never stored on chain, and do not need to be. Deposits are public base-layer transactions, so anyone can replay them and rebuild the tree. That is the client's job, and the backend can serve the leaf list as a convenience without learning anything, since it is public either way.

`DEPTH = 20` is bounded from above by the transaction, not by storage: a spend carries one sibling per level at 32 bytes each, and depth 20 leaves comfortable room inside Solana's 1232-byte limit. Depth 26 would not.

**Spent notes become one small PDA each,** at `["shredr_nullifier", nullifier]`. Its *existence* is the double-spend check — creating it is the test, performed by the runtime, in constant time, with no set to search or outgrow. A withdrawal costs about 0.001 SOL of rent for that record, charged to the depositor as a surcharge at deposit time rather than deducted from the payout: a payout net of a fee would be a payout of a distinguishing size, and the whole point of fixed denominations is that every payout looks like every other.

### Roots and the history ring

A spender proves against the tree as it stood when their client read it, and every deposit since has moved the root. So the ledger keeps a ring of recent roots and accepts a path to any of them. Accepting only the newest would make every spend race every deposit in flight.

The ring advances once per epoch turn, so `ROOT_HISTORY_CAP` is how many epochs a proof stays valid.

## Two accounts, and why

```
   ┌───────────────────────────┐        ┌───────────────────────────┐
   │ PoolVault   ~0.7 KB       │        │ PoolLedger   ~3 KB        │
   │ base layer, always        │        │ alternates                │
   │                           │ publish│                           │
   │ • every lamport           │  root  │ • recent roots (ring)     │
   │ • tree root + frontier    │───────▶│ • payout queue            │
   │ • total_deposited/settled │        │                           │
   │ • epoch, last_epoch_at    │◀───────│                           │
   └───────────────────────────┘ settle └───────────────────────────┘
              ▲                                      ▲
              │ PoolDeposit                          │ PoolSpend
         base layer                              rollup only

   ┌───────────────────────────┐
   │ NullifierRecord   8 bytes │  one per spent note, created at settle.
   │ base layer                │  Existing *is* the double-spend check.
   └───────────────────────────┘
```

Neither pool account grows with the number of notes. Both are smaller than a single stealth PDA.

A delegated account is not writable on the base layer. Put the funds and the spend ledger in one account and deposits fail whenever the pool is busy — which is most of the time, because the pool is only useful while it is delegated.

So the funds never leave L1. The vault takes deposits at any moment and folds each commitment straight into the tree. The ledger is the half that goes to the rollup; each epoch turn publishes the vault's current root into it, which is what makes the deposits since the last turn spendable.

The vault's invariant is `lamports >= rent_minimum + (total_deposited - total_settled)`. Greater-or-equal rather than equal, for two reasons: anyone can send lamports to a derivable address, and every deposit deliberately leaves behind the rent its note's eventual nullifier record will need. Neither counts as backing. If surplus did count, a stranger could inflate the pool's apparent backing without a commitment to match it.

## Instructions

| | Layer | Ledger must be | Who |
|---|---|---|---|
| `InitializePool` | base | — (creates it) | anyone |
| `PoolDeposit` | base | either | the depositor |
| `PoolSpend` | **rollup** | delegated | anyone with the secret |
| `AdvanceEpoch` | base | undelegated | anyone |
| `DelegatePoolLedger` | base | undelegated | anyone |

Committing and undelegating the ledger reuses `CommitStealth` and `CommitAndUndelegateStealth` unchanged — they never looked at the account they were flushing.

### Delegation must be private, explicitly

`DelegatePoolLedger` creates an ACL permission for the ledger with
`MembersArgs::private()` before delegating, and that CPI is the single line the
pool's privacy rests on.

The naming is a trap worth spelling out. `MembersArgs::public()` is
`members: None`; `private()` is `Some(&[])` — an **empty** member list. Omitting
the permission entirely lands in the same place as `public()`: a delegated
account that is not gated, in a rollup anyone can read. Since `PoolSpend` puts a
note secret and a leaf index in its instruction data, a public ledger means
every deposit is pairable with its withdrawal by anyone watching, and the pool
degrades to an expensive way of moving money in public.

Members are *readers*, not writers — their `MemberFlags` grant `TX_LOGS`,
`TX_MESSAGE`, `TX_BALANCES`, `ACCOUNT_SIGNATURES`. Nobody needs to be named in
order to spend, because the note secret is the authorization. Naming anyone
would only hand them the transcript, which is why the list is empty rather than
populated.

Nothing here has an admin. `InitializePool` is permissionless because both addresses derive from the denomination alone, so running it first only means paying everyone's rent. `AdvanceEpoch` is permissionless because the payout queue is authoritative: whoever pays the fee just executes what the enclave already authorized, and a pool with a privileged keeper is a pool with a liveness hostage.

### Denominations

Four pools: 1, 10, 100 and 1000 SOL, enforced on-chain against `constants::DENOMINATIONS`.

This is the part that actually makes withdrawals unlinkable. A pool taking arbitrary amounts leaks the link in the amount itself — a 47.3 SOL deposit and a 47.3 SOL withdrawal find each other without any help. Fixed sizes mean every payout out of a pool looks like every other.

Enforcing it on-chain rather than trusting the client is not paternalism. An odd denomination someone creates is a pool of one for them and a smaller anonymity set for everyone in the real pools.

### Deposits are public, on purpose

There is no burner and no stealth PDA on this path. The depositing wallet signs its own transfer and is plainly visible.

That is not a regression, it is how a pool works: your anonymity set is every other note, so you *want* the deposit list to be long and public. What has to stay hidden is which deposit funded which withdrawal, and nothing about a deposit reveals that.

It also gains something. Because the wallet is an account in the transaction, this is the one place the KYT attestation's `depositor` field can be checked against reality. On the stealth path it cannot be — funds arrive from a one-time burner and there is nothing to compare. Without the check, an attestation issued for a clean wallet could be presented by a dirty one that happened to learn the commitment. See [KYT gating](kyt-gating.md).

### The epoch

An epoch is the batch. Spends accumulate a payout queue inside the rollup; a turn drains it on the base layer and publishes the root that deposits have been folding into meanwhile.

`MIN_EPOCH_SECS` is a floor under how often that can happen, and it is a privacy control rather than a rate limit. If anyone could turn the epoch on demand, they would do it immediately after a spend, the payout would land alone in its batch, and the timing would tie it straight back to the spend that queued it. The floor forces payouts to leave in groups.

It is only a minimum. The keeper is expected to wait a **randomized** interval above it — a fixed cadence is itself a fingerprint, and the program has no cheap randomness to impose one. Longer means bigger batches, better privacy and slower withdrawals; that trade belongs to whoever runs the pool, not to the program.

Trailing accounts come in `(destination, nullifier_record)` pairs, matched positionally against the front of the queue. Pass fewer pairs than the queue holds and the rest stay for the next turn, which is how a queue bigger than one transaction's account limit drains.

Two kinds of entry are consumed without being paid, and both are dropped rather than raised as errors. A failure here aborts the entire epoch turn, so anything a *spender* can trigger has to be survivable or it becomes a way to freeze everyone else's withdrawals:

* **Already spent.** Its nullifier record exists from an earlier epoch.
* **Aimed at the vault.** A spender picks their own destination, and nothing stops them naming the vault — but crediting the vault from itself is an unbalanced instruction the runtime rejects. The note is burned and nothing is paid; the loss stays with whoever chose the address.

Both leave the denomination in the vault as surplus backing. The accounting errs toward over-collateralized, never under.

Settling happens in two passes: every nullifier record is written first, and only then do lamports move. The runtime reconciles balances at each CPI boundary, so a direct transfer left sitting between two record creations is an unbalanced instruction even when the batch would have balanced out by its end. Without the split, a turn could settle exactly one payout — which would make every batch a batch of one, and the batching is the point.

## System flow

```
 1. client picks secret, computes commitment
 2. relayer screens the wallet, signs an attestation over the commitment
 3. PoolDeposit ─── base layer, public ───▶ vault += 1 denomination
                                            pending.push(commitment)

        ... the root has moved; the ledger has not seen it yet ...

 4. AdvanceEpoch ──▶ publishes the new root       the note is now spendable
 5. DelegatePoolLedger ──▶ ledger goes to the rollup

        ... time passes, other people deposit and spend ...

 6. PoolSpend ─── inside the enclave ───▶ Merkle path checked against a known root
                                          payout {nullifier, destination} queued
        the secret and the leaf index are revealed here, and only here

 7. CommitAndUndelegateStealth ──▶ ledger returns to the base layer
 8. AdvanceEpoch ──▶ one nullifier record created and one denomination paid,
                     per queued payout
```

What an observer with the full ledger has at the end: a set of deposits, a set of nullifiers, and a batch of identical transfers. Pairing any deposit with any withdrawal needs a secret they never saw.

## What this does not hide

Being precise about the residue matters more than the diagram.

**The rollup fee payer sees the link.** This is the big one and it follows directly from having no proof system. `PoolSpend` carries the note secret *and its leaf index* in its instruction data, so anyone who handles that transaction before it reaches the enclave can pair the exact deposit with the withdrawal. In practice that is Kora, which signs as fee payer.

The repo already keeps a separate instance for rollup traffic (`KORA_ROLLUP_RELAYER_URL`), and that separation stops being a convenience here and becomes a requirement: **the rollup relayer has to sit inside the same trust domain as the enclave**. Co-locate it, treat its logs the way `docs/concepts/rpc-opsec.md` treats the router's, and do not point it at a shared or third-party paymaster.

The fix, if this is not acceptable for a deployment, is a proof: replace the secret with a Groth16 proof over Solana's `alt_bn128` syscalls and the fee payer learns nothing. That is a different project — circuits, a trusted setup, a browser prover — and it is the reason the note format is deliberately simple rather than half-way to one.

**A compromised enclave can steal within the pool.** The queue is authoritative, so an enclave that lied could name its own destinations. What it cannot do is mint: `AdvanceEpoch` refuses to pay more than `total_deposited - total_settled`, checked against counters the base layer maintains itself. So the blast radius is the pool's balance, not the program's. This is a real change from the stealth path, where a compromised validator could only reach the funds delegated to it — one cycle at a time. A single vault is one address worth attacking.

**The pool is only as private as it is busy.** Six notes is six-note privacy, whatever the cryptography says. This is why the denominations are fixed and why splitting them further is refused.

**Deposit and withdrawal amounts are public**, as they are in any pool. Only the pairing is hidden.

**The relayer knows.** Screening records `(wallet, commitment)` by construction — that is what makes the deposit auditable — and the commitment is on-chain. So the relayer's logs identify which deposit belongs to whom. They do not identify which withdrawal, which is the line the whole design draws: provable to an auditor, invisible to an observer.

## Coexistence with the stealth path

Both live in the program and share no state. Cycles already in flight finish on the old instructions; new deposits go to the pool. The stealth instructions can be removed once the last cycle drains — there is no migration and nothing to strand.

## Limits

| | Value | What it bounds |
|---|---|---|
| `merkle::DEPTH` | 20 | 1,048,576 deposits per pool, ever |
| `ROOT_HISTORY_CAP` | 32 | epochs a spend proof stays valid |
| `PAYOUT_QUEUE_CAP` | 32 | spends between epoch turns, and settlements per turn |
| withdrawals | — | **unbounded** |

Only the first is a real ceiling, and reaching it means the pool took a million deposits. The other two are keeper-liveness bounds: a full payout queue makes further spends wait for a settle, and a proof older than 32 epochs needs regenerating against a newer root — which the client can always do, since it holds the leaves.

Raising the depth is a redeploy with a new zero table and a larger spend instruction, and 20 already uses most of the transaction budget's headroom. If a pool ever fills, rotate it: key the PDAs by `(denomination, generation)` and have clients deposit into the newest.

## See also

* [KYT gating](kyt-gating.md) — the screening that gates every deposit
* [Ephemeral rollups](ephemeral-rollups.md) — delegation and the TEE validator
* [RPC operational security](rpc-opsec.md) — the fee payer's trust domain, in detail
* [The privacy model](privacy-model.md) — what the older path claims
