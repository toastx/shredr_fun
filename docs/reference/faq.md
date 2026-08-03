---
description: "Common questions about how shredr works, what it protects, and what it costs."
icon: circle-question
---

# FAQ

## Using shredr

<details>
<summary><strong>Do I need to back anything up?</strong></summary>

No. Every key is derived from a signature your wallet reproduces on demand. Connect the same wallet anywhere, sign the same message, and your state returns.

Your wallet's own seed phrase is the only backup that matters — and losing that loses your wallet anyway.
</details>

<details>
<summary><strong>Which address do I give the sender?</strong></summary>

The one the app displays — the **burner address**. Never the stealth PDA.

The program requires the PDA to be empty when it is created, so a deposit sent directly there would permanently block initialization and strand the funds. The UI only ever shows the burner address for this reason.
</details>

<details>
<summary><strong>Can I reuse a burner address?</strong></summary>

You can, but do not. Two senders paying the same burner can see each other's payments.

The app rotates automatically after each shred. Copy a fresh address per sender.
</details>

<details>
<summary><strong>Does it cost anything?</strong></summary>

You pay no transaction fees. The Kora relayer pays them, and it also pays the rent-exemption for each stealth PDA.

This is a privacy requirement, not just convenience — funding a burner from your own wallet would create a public transaction linking you to it.
</details>

<details>
<summary><strong>Why is my balance lower than the explorer shows?</strong></summary>

The app shows `deposited_amount`; the explorer shows raw lamports.

```
account lamports = rent-exempt minimum (relayer's) + deposited_amount (yours)
```

Only your portion is withdrawable. The program refuses to touch the rent, because dropping below rent-exemption would let the runtime reap the account.
</details>

<details>
<summary><strong>How long does a withdrawal take?</strong></summary>

If your main PDA is still delegated, it must be committed and undelegated first — an asynchronous settlement that can take up to two minutes (120s timeout, polled every 2s).

If it is already undelegated, a withdrawal is a single fast transaction.
</details>

<details>
<summary><strong>Can I withdraw part of my balance?</strong></summary>

Technically yes, but **do not**. Withdrawing undelegates your main PDA, and an undelegated main PDA cannot be re-delegated — so you cannot shred again until you empty it.

Always withdraw everything.

→ [Limitations](limitations.md)
</details>

<details>
<summary><strong>What if a deposit arrives while the app is closed?</strong></summary>

Nothing is lost. It sits on the burner, and the claim page's scan finds it — `scanPendingUtxos()` checks indices 1–64 for unswept deposits, and `shredPendingDeposits()` shreds them.
</details>

<details>
<summary><strong>Can I use it on multiple devices?</strong></summary>

Yes. Connect the same wallet, sign the same message. Your state syncs via the encrypted blob, and the main burner is derived directly from the signature so it is identical everywhere.

Avoid shredding simultaneously on two devices — the nonce chain could diverge. Recovery's highest-index rule handles the aftermath, but it is not a good idea.
</details>

<details>
<summary><strong>Does it work with SPL tokens?</strong></summary>

No. Native SOL only.
</details>

## Privacy

<details>
<summary><strong>Can the sender find my main wallet?</strong></summary>

They see a burner with one deposit. Following it forward leads to a shredr stealth PDA, then to a MagicBlock delegation — and stops. The transfer into your main PDA has no public record.

Amounts are visible on-chain, so use round, normalized values (1, 10, 100, 1000 SOL) to keep a payment from standing out by its size.

→ [The privacy model](../concepts/privacy-model.md)
</details>

<details>
<summary><strong>Is this a mixer?</strong></summary>

Not in the ZK sense. shredr breaks the *link* by moving funds inside a TEE-secured rollup, where the transfer produces no public record, rather than by a cryptographic proof.
</details>

<details>
<summary><strong>What can the backend see?</strong></summary>

An encrypted ~200-byte blob, a timestamp, and a UUID.

It cannot decrypt it — the key is `SHA256(signature ‖ "SHREDR_STORAGE_KEY")` and the signature never leaves your browser. Blobs carry no user identifier at all, so it cannot even tell whose is whose.

Recovery works by downloading every blob and trying to decrypt each one.
</details>

<details>
<summary><strong>What can the relayer see?</strong></summary>

Kora sees the transactions it signs as fee payer — burner pubkeys, stealth PDAs, and amounts. It never holds a key that can move your funds, and it is never an owner of any account.
</details>

<details>
<summary><strong>Am I anonymous?</strong></summary>

shredr provides **unlinkability of sender to your main wallet**, not anonymity.

It does not hide that a payment happened, or how much it was.
</details>

<details>
<summary><strong>If a burner key leaks, are my funds at risk?</strong></summary>

No. Once shredded, funds live in your main PDA, which only the **main burner** can withdraw from — and the main burner is derived directly from the signature, not from any nonce.

A leaked nonce lets an attacker compute *future* burners (forward-only chain), so they could see incoming payments before you rotate past that point. They cannot compute earlier ones, and they cannot reach money already consolidated.
</details>

## Technical

<details>
<summary><strong>Why derive keys from a signature instead of a seed phrase?</strong></summary>

Ed25519 signing is deterministic — the same key over the same message always yields the same bytes. So the signature can be reproduced on demand rather than stored.

You get recoverability with nothing to back up, and no additional secret to lose.
</details>

<details>
<summary><strong>Why a hash chain instead of indexed derivation?</strong></summary>

`nonce[N] = SHA256(nonce[N-1])` is **forward-only**. A leaked nonce reveals future addresses but never past ones, because reversing it would mean inverting SHA-256.

`SHA256(seed ‖ N)` would expose every index at once if the seed leaked.
</details>

<details>
<summary><strong>Why two accounts per payment?</strong></summary>

MagicBlock delegation requires a **program-owned** account. A plain keypair account cannot be delegated, so funds must move into a PDA first.

The PDA also brings program-enforced rules — ownership checks, balance tracking, and the rent-exemption floor — that a raw keypair account has none of.

→ [Burners and stealth PDAs](../concepts/burners-and-stealth-pdas.md)
</details>

<details>
<summary><strong>How can a PDA authorize a transfer if it cannot sign?</strong></summary>

It does not. The **burner** signs, and the program checks that signer against the `owner` recorded in the PDA's state — the same key registered as the ACL member at delegation time.

```rust
if &source_data.owner != source_burner.address() {
    return Err(ProgramError::IllegalOwner);
}
```
</details>

<details>
<summary><strong>Why Pinocchio instead of Anchor?</strong></summary>

Much lower compute-unit cost — zero-copy, `#![no_std]`, no serialization layers.

The trade-off is manual safety: no automatic discriminator or ownership checks. shredr does them explicitly in `helpers.rs`.
</details>

<details>
<summary><strong>Why does the private transfer go to a different RPC?</strong></summary>

Delegated accounts live in the rollup; the base-layer copy is frozen. A transaction touching them must be built on a rollup blockhash and sent to the rollup RPC, or it is invalid.

Hence `signAndSendOn()` (Kora signs, client broadcasts) rather than `signAndSend()` (Kora broadcasts on the base layer).
</details>

<details>
<summary><strong>Can I run my own instance?</strong></summary>

Yes. See [Local development](../getting-started/local-development.md).

**Change `MASTER_MESSAGE` before anyone uses it** — it is what separates your deployment's key derivation from shredr.fun's. Changing it later breaks every existing user irrecoverably.
</details>

<details>
<summary><strong>Which network does it run on?</strong></summary>

Solana **devnet**. The program ID `H9pUQeNA2RwBHRwx52V8nqWpCAKReSA3gGUuRFHbEjG6` is deployed there, and the RPC URLs, relayer, and rollup endpoint all point at devnet.

There is a `mainnet` Cargo feature that pins a TEE validator for a mainnet build, but the rest of the stack would need repointing too.

→ [Security model](security-model.md) · [Limitations](limitations.md)
</details>

## Next

* [How it works](../getting-started/how-it-works.md)
* [Limitations](limitations.md)
* [Troubleshooting](troubleshooting.md)
