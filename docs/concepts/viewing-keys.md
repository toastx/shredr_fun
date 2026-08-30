---
description: "Proving one payment happened, without proving anything about the others."
icon: file-certificate
---

# Viewing keys

shredr hides the link between a sender and your wallet. That is also its problem: **nothing can be proven afterwards.** An accountant, a tax authority, or a counterparty asking "did you receive my payment?" cannot be answered by a system whose whole design is that nobody can tell.

A viewing key answers exactly one of those questions at a time.

## What a receipt actually contains

Start from what is already public. Given a deposit PDA address, anyone can read the sender, the amount, the timestamp, and the exit destination — they are ordinary Solana transactions.

One fact is missing, and only one:

```
sender → burner_i → depositPda_i     public
depositPda_i ⇢ exitPda_j             NOT PUBLIC — happens inside the rollup
exitPda_j → destination              public
```

**Which deposit funded which exit.** That hop produces no Solana transaction, so it exists nowhere an observer can reach. It is the entire content of a receipt.

Everything else in a disclosure is a *pointer* — addresses and signatures the auditor uses to go and check the public record for themselves. This is why a receipt is small, and why it is self-checking: it agrees with the ledger or it does not.

{% hint style="info" %}
An auditor is never given derivation capability. Deriving a burner *address* requires `burnerSeed`, which also yields its *private key* — "read but not write" therefore forces a disclosure to carry addresses explicitly, authenticated by signature.
{% endhint %}

## The derivation

A fifth branch on the tree in [Key derivation](key-derivation.md), a sibling of the burner branch rather than a child of it:

```
auditSeed = SHA256( signature ‖ "SHREDR_AUDIT_MASTER" )
```

Then one key per invoice, via HKDF-SHA256 — native in WebCrypto, no dependency:

```
PRK        = HKDF-Extract( salt = depositPda, ikm = auditSeed )
vk_i ‖ iv  = HKDF-Expand ( PRK, info = "SHREDR_VK_V1" ‖ LE32(i) ‖ rev, L = 44 )
```

<details>
<summary><strong>Why the PDA is a salt and not a source of entropy</strong></summary>

The PDA pubkey is public. A key derived from public data alone is public. It goes in HKDF's `salt` parameter as a *binder*, so `vk_i` is meaningless against any other account — the secret always comes from the signature.
</details>

<details>
<summary><strong>Why <code>rev</code> exists</strong></summary>

The AEAD IV is derived rather than random, which is safe only while one key encrypts one plaintext. Two different plaintexts under the same key and IV hand an attacker the AES-GCM keystream *and* the authentication key. Bumping `rev` gives a revised receipt a fresh key instead. It costs one byte and prevents a total break.
</details>

## The commitment

Every stealth PDA carries a 32-byte commitment in `receipt_commitment` — the field that used to be the unused `salt`. It is written by the client, stored verbatim, and never read by the program.

**Every account, always.** Not a feature users opt into: a receipt is worthless if you had to predict at deposit time that you would need it eighteen months later, and a field only some clients populate would identify those clients.

A withdrawal drains N deposits into one exit, so the exit commits to a *set*:

```
leaf_i = SHA256( "SHREDR_LEAF_V1" ‖ vk_i ‖ invoice_i )
root   = SHA256( "SHREDR_ROOT_V1" ‖ sort(leaf_1 ‖ … ‖ leaf_N) )
```

An auditor holding `vk_i` recomputes `leaf_i`, takes the other leaves from the disclosure as opaque 32-byte hashes, recomputes the root, and compares. The siblings reveal nothing: they are hashes under keys the auditor does not hold. Committing to the batch directly would have forced them to reconstruct everyone else's invoice to recheck the hash.

{% hint style="warning" %}
Deposit and exit legs must never share a commitment **value**. Identical bytes in two accounts is a public equality test that rebuilds the exact edge the rollup hop hides. Distinct labels and distinct keys guarantee it.
{% endhint %}

### Surviving rent reclaim

`CloseStealthAccount` resizes the account to zero and returns it to the System Program, so reclaiming rent erases the field. The commitment therefore travels in two places, at no extra cost, being the same 32 bytes:

| Path | Where | Lifetime |
|---|---|---|
| Fast | the `receipt_commitment` field | while the account is open |
| Durable | the `InitializeAndDelegate` instruction data | permanent, in ledger history |

They cannot disagree — the program copies one into the other. Close everything freely.

## The proof

Notation: `H` is SHA-256, and `PRF_k` is HMAC-SHA-256 keyed by `k`. HKDF-Extract is `PRK = PRF_salt(ikm)`; HKDF-Expand is a counter-mode chain of `PRF_PRK`. `n` is the number of invoices, `q` the number of keys disclosed, `t` the adversary's running time.

**Adversary.** `A` is given `vk_i` for every `i` in a set `D` of disclosed invoices of its own choosing, every ciphertext, every commitment, and the entire public ledger. `A` is probabilistic polynomial time.

---

### Theorem 1 — a disclosed key does not yield the master secret

*No efficient `A` holding the keys for `D` can output `auditSeed` with non-negligible probability.*

**Proof.** Suppose `A` recovers `auditSeed` with probability `ε`. Build `B` against the PRF security of HMAC-SHA-256.

`B` receives an oracle `O` that is either `PRF_k` for a random unknown `k`, or a random function `R`. `B` sets `PRK := k` implicitly, answers each of `A`'s key requests by querying `O` on the HKDF-Expand inputs for that index, and returns the results as the viewing keys. The simulation is perfect when `O = PRF_k`.

If `A` outputs a candidate `auditSeed`, `B` recomputes `PRK = PRF_depositPda(auditSeed)` and checks it against the oracle on a fresh input. A match means `O` was the PRF, so `B` answers "PRF". When `O = R`, the outputs carry no information about any `auditSeed`, so `A` succeeds only by guessing — probability at most `2^-256` per attempt.

Therefore `Adv_B >= ε - 2^-256`, and

```
ε  <=  Adv^PRF_HMAC(q, t)  +  2^-256
```

Recovering `auditSeed` is at least as hard as breaking HMAC-SHA-256 as a PRF. ∎

{% hint style="info" %}
Second pre-image resistance of SHA-256 extends this one step further up: `auditSeed = H(signature ‖ tag)`, so even `auditSeed` does not yield the wallet signature. Compromise of the audit branch never reaches the burner branch — that is what "sibling, not child" buys.
{% endhint %}

### Theorem 2 — a disclosed key says nothing about any other invoice's key

*For an undisclosed index `j`, no efficient `A` distinguishes `vk_j` from a uniformly random 32-byte string.*

**Proof.** By a hybrid over HKDF-Expand's outputs. Each key is `PRF_PRK(info_i)` where `info_i = "SHREDR_VK_V1" ‖ LE32(i) ‖ rev`. The indices are distinct, so the info strings are distinct, and no query `A` makes ever collides with the challenge input.

Game 0 is the real game. Game 1 replaces `PRF_PRK` with a random function `R`. Any distinguisher between the two games is an HMAC distinguisher, so the gap is at most `Adv^PRF_HMAC(q+1, t)`. In Game 1, `vk_j = R(info_j)` is uniform and independent of every disclosed `R(info_i)`, so `A`'s advantage is exactly zero. Hence

```
Adv^dist_A  <=  Adv^PRF_HMAC(q+1, t)
```

This holds for *any* `D`, including one of size `n-1`: an auditor holding every key but one learns nothing about the one they were not given. ∎

### Theorem 3 — an invoice without its key is unreadable

*For an undisclosed index `j`, receipt `j` is indistinguishable from an encryption of any equal-length plaintext.*

**Proof.** By Theorem 2, `vk_j` is computationally indistinguishable from a uniformly random key. Substituting a truly random key changes `A`'s advantage by at most `Adv^PRF_HMAC(q+1, t)`. Under a uniformly random key used for exactly one encryption, AES-256-GCM is IND-CPA and INT-CTXT by assumption. Attestations are fixed-width, so ciphertext length leaks nothing. Composing:

```
Adv^IND_A  <=  Adv^PRF_HMAC(q+1, t)  +  Adv^AE_AES-GCM(t)
```
∎

### Corollary — commitments leak nothing

`leaf_i = H("SHREDR_LEAF_V1" ‖ vk_i ‖ invoice_i)`. For an undisclosed `i`, the key contributes 256 bits of entropy unknown to `A`, so the hash is computationally hiding in the random oracle model for SHA-256.

This matters more than it may look. The committed values are otherwise **low entropy** — amounts and addresses are guessable, and a commitment over them alone would fall to a dictionary attack in seconds. The key is what blinds them.

### Composition

```
Adv^total  <=  Adv^PRF_HMAC(q+1, t)  +  Adv^AE_AES-GCM(t)  +  q²/2^256
```

with the final term the birthday bound on key collisions. Under standard assumptions for HMAC-SHA-256 and AES-256-GCM, every term is negligible.

## What this does not prove

The proof covers confidentiality of undisclosed invoices. It says nothing about the following, all of which are real.

<details>
<summary><strong>Disclosure exposes the destination — permanently, and retroactively</strong></summary>

The destination is normally your own wallet. Disclosing one receipt tells that auditor "this money is mine", and from then on **every other invoice you withdraw to that address is linkable to you by them**, just by watching it. One disclosure taints every payment sharing its destination, including past ones.

Use a fresh destination per invoice, or per auditor.
</details>

<details>
<summary><strong>A disclosed key is disclosed forever</strong></summary>

There is no expiry and there cannot be one. Once an auditor decrypts, they hold the plaintext; no cipher takes that back. Anything marketed as self-destructing data is access control wearing a costume.

The proof is also **transferable** by design — an auditor can forward it to a third party and it still verifies. That is what makes it useful for compliance, and it is irreversible.
</details>

<details>
<summary><strong>Timing and amount correlation</strong></summary>

Both public legs show an amount, and a deposit followed shortly by a withdrawal of a similar size is a correlation no key management fixes. Use the normalized denominations. This is the same limitation as the rest of the protocol, not a new one.
</details>

<details>
<summary><strong>The batch size N</strong></summary>

The sorted-concat root discloses how many payments were batched into one withdrawal, because the auditor receives `N-1` sibling hashes. A binary Merkle tree would reduce this to `log N`. N is 1–5 in practice.
</details>

<details>
<summary><strong>The receipt log is not reconstructable from the chain</strong></summary>

Deposit receipts are: derive `vk_i`, read the public values, recompute, compare — a fresh device with only the wallet signature rebuilds every incoming receipt. The **exit** side needs the batch composition, which only the log holds. Losing it loses the link half of some receipts. It never loses funds.

At `N = 1` even that disappears: the root equals the leaf, so the link is recoverable by trial-matching candidate deposits against each exit commitment.
</details>

## Why not Token-2022 Confidential Balances

Its auditor key is **global**. One key decrypts every transfer ever made under that mint — a single compromise deanonymises the entire history, retroactively, for everyone. That is a honeypot with a bullseye on it.

Every key here is transaction-scoped, derived client-side, and never transmitted. No key's compromise affects more than one invoice, and no party other than the user ever holds one.

## Where to find it in the code

| Piece | File |
|---|---|
| Master seed, key derivation, sealing, verification | `src/lib/AuditService.ts` |
| Where a commitment is stored on-chain | `src/lib/anchor.ts` |
| Building and sealing receipts during a withdrawal | `src/lib/ShredrClient.ts` |
| Receipt blobs | `src/lib/UtxoService.ts` (`recordReceipt`, `loadReceipts`) |
| The stored field | `shredr-program/src/state.rs` (`receipt_commitment`) |
| Parsing the commitment | `shredr-program/src/instructions/initialize_delegate.rs` |

## Next

* [Key derivation](key-derivation.md) — the four branches this one joins
* [The privacy model](privacy-model.md) — what shredr hides, and from whom
