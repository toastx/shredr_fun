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

That is the whole scheme. Given a commitment you cannot compute its nullifier and vice versa, so the base layer ends up holding two lists it cannot pair. There is no Merkle tree, no proof system, and no trusted setup: membership is a scan of the commitment list, and the step that reveals a secret happens inside the enclave.

The domain tags are versioned. Changing either changes every note, so a new version is a new pool, not a migration.

## Two accounts, and why

```
   ┌───────────────────────────┐        ┌───────────────────────────┐
   │ PoolVault                 │        │ PoolLedger                │
   │ base layer, always        │        │ alternates                │
   │                           │        │                           │
   │ • every lamport           │        │ • commitments (ingested)  │
   │ • pending commitments     │───────▶│ • nullifiers              │
   │ • total_deposited/settled │ ingest │ • payout queue            │
   │ • epoch, last_epoch_at    │◀───────│                           │
   └───────────────────────────┘ settle └───────────────────────────┘
              ▲                                      ▲
              │ PoolDeposit                          │ PoolSpend
         base layer                              rollup only
```

A delegated account is not writable on the base layer. Put the funds and the spend ledger in one account and deposits fail whenever the pool is busy — which is most of the time, because the pool is only useful while it is delegated.

So the funds never leave L1. The vault takes deposits at any moment and parks their commitments in `pending`. The ledger is the half that goes to the rollup, and it picks up those commitments the next time it comes back.

The vault's invariant is `lamports >= rent_minimum + (total_deposited - total_settled)`. Greater-or-equal rather than equal, because anyone can send lamports to a derivable address; the surplus is unaccounted and deliberately never credited. If it were, a stranger could inflate the pool's apparent backing without a commitment to match it.

## Instructions

| | Layer | Ledger must be | Who |
|---|---|---|---|
| `InitializePool` | base | — (creates it) | anyone |
| `PoolDeposit` | base | either | the depositor |
| `PoolSpend` | **rollup** | delegated | anyone with the secret |
| `AdvanceEpoch` | base | undelegated | anyone |
| `DelegatePoolLedger` | base | undelegated | anyone |

Committing and undelegating the ledger reuses `CommitStealth` and `CommitAndUndelegateStealth` unchanged — they never looked at the account they were flushing.

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

An epoch is the batch. Spends accumulate a payout queue inside the rollup; a turn drains it on the base layer and folds in whatever deposits arrived meanwhile.

`MIN_EPOCH_SECS` is a floor under how often that can happen, and it is a privacy control rather than a rate limit. If anyone could turn the epoch on demand, they would do it immediately after a spend, the payout would land alone in its batch, and the timing would tie it straight back to the spend that queued it. The floor forces payouts to leave in groups.

It is only a minimum. The keeper is expected to wait a **randomized** interval above it — a fixed cadence is itself a fingerprint, and the program has no cheap randomness to impose one. Longer means bigger batches, better privacy and slower withdrawals; that trade belongs to whoever runs the pool, not to the program.

Destinations are passed as trailing accounts and matched positionally against the front of the queue. Pass fewer than the queue holds and the rest stay for the next turn, which is how a queue bigger than one transaction's account limit drains.

## System flow

```
 1. client picks secret, computes commitment
 2. relayer screens the wallet, signs an attestation over the commitment
 3. PoolDeposit ─── base layer, public ───▶ vault += 1 denomination
                                            pending.push(commitment)

        ... deposit sits in `pending` until the next epoch turn ...

 4. AdvanceEpoch ──▶ ledger.commitments.push(commitment)     now spendable
 5. DelegatePoolLedger ──▶ ledger goes to the rollup

        ... time passes, other people deposit and spend ...

 6. PoolSpend ─── inside the enclave ───▶ nullifier published
                                          payout {nullifier, destination} queued
        the secret is revealed here, and only here

 7. CommitAndUndelegateStealth ──▶ ledger returns to the base layer
 8. AdvanceEpoch ──▶ vault pays every queued destination, one denomination each
```

What an observer with the full ledger has at the end: a set of deposits, a set of nullifiers, and a batch of identical transfers. Pairing any deposit with any withdrawal needs a secret they never saw.

## What this does not hide

Being precise about the residue matters more than the diagram.

**The rollup fee payer sees the link.** This is the big one and it follows directly from having no proof system. `PoolSpend` carries the note secret in its instruction data, so anyone who handles that transaction before it reaches the enclave can hash it twice and pair the commitment with the nullifier themselves. In practice that is Kora, which signs as fee payer.

The repo already keeps a separate instance for rollup traffic (`KORA_ROLLUP_RELAYER_URL`), and that separation stops being a convenience here and becomes a requirement: **the rollup relayer has to sit inside the same trust domain as the enclave**. Co-locate it, treat its logs the way `docs/concepts/rpc-opsec.md` treats the router's, and do not point it at a shared or third-party paymaster.

The fix, if this is not acceptable for a deployment, is a proof: replace the secret with a Groth16 proof over Solana's `alt_bn128` syscalls and the fee payer learns nothing. That is a different project — circuits, a trusted setup, a browser prover — and it is the reason the note format is deliberately simple rather than half-way to one.

**A compromised enclave can steal within the pool.** The queue is authoritative, so an enclave that lied could name its own destinations. What it cannot do is mint: `AdvanceEpoch` refuses to pay more than `total_deposited - total_settled`, checked against counters the base layer maintains itself. So the blast radius is the pool's balance, not the program's. This is a real change from the stealth path, where a compromised validator could only reach the funds delegated to it — one cycle at a time. A single vault is one address worth attacking.

**The pool is only as private as it is busy.** Six notes is six-note privacy, whatever the cryptography says. This is why the denominations are fixed and why splitting them further is refused.

**Deposit and withdrawal amounts are public**, as they are in any pool. Only the pairing is hidden.

**The relayer knows.** Screening records `(wallet, commitment)` by construction — that is what makes the deposit auditable — and the commitment is on-chain. So the relayer's logs identify which deposit belongs to whom. They do not identify which withdrawal, which is the line the whole design draws: provable to an auditor, invisible to an observer.

## Coexistence with the stealth path

Both live in the program and share no state. Cycles already in flight finish on the old instructions; new deposits go to the pool. The stealth instructions can be removed once the last cycle drains — there is no migration and nothing to strand.

## Capacities

| | Value | What runs out |
|---|---|---|
| `PENDING_COMMITMENT_CAP` | 64 | deposits between epoch turns |
| `POOL_COMMITMENT_CAP` | 512 | deposits, **for the pool's lifetime** |
| `POOL_NULLIFIER_CAP` | 512 | matches commitments |
| `PAYOUT_QUEUE_CAP` | 32 | spends between epoch turns |

The ledger is ~34KB, about 0.24 SOL of rent. The commitment cap is a lifetime total, not a rolling window: a pool takes 512 deposits and then refuses.

The upgrade path is **pool rotation**, not a bigger account — key the PDAs by `(denomination, generation)` and have the client deposit into the newest. Growing the array instead costs rent linearly and makes the membership scan longer, and the scan is on every spend.

## See also

* [KYT gating](kyt-gating.md) — the screening that gates every deposit
* [Ephemeral rollups](ephemeral-rollups.md) — delegation and the TEE validator
* [RPC operational security](rpc-opsec.md) — the fee payer's trust domain, in detail
* [The privacy model](privacy-model.md) — what the older path claims
