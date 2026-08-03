---
description: "What shredr hides, from whom, and where the guarantees stop."
icon: shield-halved
---

# The privacy model

Privacy tools are only useful if you know their edges. This page states precisely what shredr protects against and what it does not.

## The property being protected

**Unlinkability of a sender to your main wallet.**

Someone who pays you should not be able to determine your real wallet address, your balance, or who else has paid you.

That is the whole claim. Everything below is either how it is achieved or where it fails.

## How the link is broken

A normal payment leaves one unbroken public trail:

```
Sender ─────────────────▶ Your wallet
        (public, forever)
```

shredr inserts three breaks:

```
Sender ──▶ Burner ──▶ Stealth PDA ══▶ Main PDA ──▶ Destination
           [1]        [2]              [3]
```

| Break | Mechanism | What an observer sees |
|---|---|---|
| **1. Fresh address** | Each sender gets a burner used exactly once | An address with one deposit and no history |
| **2. Program custody** | Funds move to a PDA the shredr program controls | A shredr program account, indistinguishable from thousands of others |
| **3. Off-graph transfer** | The hop to your main PDA happens *inside the rollup* (`══▶`) | **Nothing.** There is no public Solana transaction for this step |

Break 3 is the load-bearing one. Breaks 1 and 2 alone would still leave a traceable chain of on-chain transfers.

## Why the rollup hop is private

MagicBlock's ephemeral rollup runs inside a **trusted execution environment**. When a stealth PDA is delegated:

* the base-layer account is frozen — the public ledger stops reflecting changes to it,
* transactions against it execute inside the TEE,
* only a final settled state is written back on undelegation.

So the `PrivateTransfer` moving lamports from your stealth PDA to your main PDA is never a public Solana transaction. What settles back is the *result*: an empty stealth PDA, and a main PDA with a larger balance. The connecting edge does not exist in any public dataset.

## Why the relayer matters

Consider what happens without one. A burner keypair holds SOL but cannot pay its own transaction fee unless you fund it. Funding it from your wallet creates:

```
Your wallet ──▶ Burner
```

A single public transaction linking you to the burner, and through it to the sender. The entire scheme collapses.

Kora signs as fee payer, so no funding transaction ever exists. The relayer's account appears as fee payer on every shredr transaction — which tells an observer that shredr was used, but not *by whom*.

→ [The Kora relayer](relayer.md)

## Why your wallet never appears

Your connected wallet signs exactly one thing: an **off-chain message**. It never signs a shredr transaction, never appears as an account in one, and never pays a fee.

Withdrawals are signed by your **main burner** — a key derived from your signature but with no on-chain relationship to your wallet.

This means an observer analyzing the shredr program's accounts cannot work backwards to any real identity. The main burner and your wallet share a secret (the signature) that exists only in your browser's memory.

## What the backend learns

Almost nothing:

| The backend sees | The backend cannot see |
|---|---|
| An encrypted ~200-byte blob | What is in it |
| A creation timestamp | Whose it is |
| That a blob was created or marked consumed | Any address, key, or amount |
| — | Which wallet it belongs to |

Blobs carry no user identifier at all. Recovery works by downloading every blob and trying to decrypt each — only yours succeeds. The server cannot group blobs by user, because nothing in a blob's metadata distinguishes one user from another.

The encryption key is `SHA256(signature ‖ "SHREDR_STORAGE_KEY")`, and the signature never leaves your browser.

→ [State sync and recovery](state-sync-and-recovery.md)

## What this stops

<details>
<summary><strong>A sender who wants to find your main wallet</strong></summary>

They see a burner address with one incoming payment. Following it forward leads to a shredr stealth PDA, then to a delegation to a MagicBlock validator — and then the trail stops. The transfer into your main PDA has no public record.

**Result: blocked.**
</details>

<details>
<summary><strong>Multiple senders trying to link their payments to each other</strong></summary>

Each was given a different burner, derived from a different nonce in a forward-only hash chain. Nothing about burner #4 reveals burner #5, and nothing on-chain groups them.

**Result: blocked.**
</details>

<details>
<summary><strong>The backend operator</strong></summary>

They hold encrypted blobs with no user identifiers and no decryption key. They can deny service (delete blobs) but cannot read state — and even deletion is not fatal, since all state is re-derivable from your wallet signature and an on-chain scan.

**Result: blocked** for confidentiality; availability is trusted.
</details>

<details>
<summary><strong>A stolen burner private key</strong></summary>

Burner keys are one-time. A leaked `nonce[5]` lets an attacker compute `nonce[6]`, `nonce[7]`, and so on — but never `nonce[4]` or earlier, because SHA-256 is one-way.

More importantly, a burner key alone cannot reach your funds: once shredded, the money lives in your main PDA, which only the **main burner** can withdraw from. And the main burner is derived from the signature directly, not from any nonce.

**Result: forward-only exposure of future receive addresses; funds are safe.**
</details>

<details>
<summary><strong>An attacker who steals your encrypted blob</strong></summary>

AES-GCM with a key derived from a signature they do not have. Without the wallet, the blob is noise.

**Result: blocked.**
</details>

## Using it well

A few habits are on you rather than on the protocol.

<details>
<summary><strong>Use normalized amounts</strong></summary>

Amounts are visible on-chain at both ends. Sending and withdrawing in round, standard sizes — **1, 10, 100, or 1000 SOL** — keeps a payment from standing out by its value alone.

These are the denominations shredr standardizes on, defined as `NORMALIZED_DENOMINATIONS_SOL` in `src/lib/constants.ts` and mirrored in the program's `constants.rs`.
</details>

<details>
<summary><strong>One burner, one sender</strong></summary>

If you hand the same burner to two senders, they can see each other's payments. The app rotates automatically after each shred, but a burner address you copied earlier and pasted again later is not protected.
</details>

<details>
<summary><strong>Pick your destination deliberately</strong></summary>

shredr's job ends at the destination address. If you withdraw into the same wallet you use for everything else, you have re-linked yourself by hand.
</details>

## Comparison

| Approach | Hides link | Hides amount |
|---|---|---|
| Plain Solana address | No | No |
| A fresh address per payment | Partially — until you consolidate | No |
| **shredr** | Yes | Use normalized amounts |
| ZK mixer (e.g. Tornado-style) | Yes | Yes, via fixed denominations |

shredr's advantage over a plain fresh-address-per-payment scheme is that consolidating your funds does not re-link them.

## Next

* [Key derivation](key-derivation.md) — the cryptography underneath
* [Limitations](../reference/limitations.md) — current scope and known gaps
