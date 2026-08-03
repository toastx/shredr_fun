---
description: "The whole shredr journey explained in plain language, one step at a time."
icon: route
---

# How it works

This page walks the entire flow with no cryptography prerequisites. Every step links to the deeper reference if you want the details.

## The cast

Before the steps, meet the accounts. There are four, and keeping them straight makes everything else easy.

| Name | What it is | How many |
|---|---|---|
| **Your wallet** | Phantom, Solflare, etc. The wallet you connect. | One |
| **Burner** | A throwaway keypair. This is the address you give to a sender. | A new one per payment |
| **Stealth PDA** | A program-owned account paired with a burner. Money gets swept in here. | One per burner |
| **Main burner + main PDA** | Your permanent consolidation account. All money ends up here. | One, forever |

{% hint style="info" %}
A **PDA** ("program derived address") is a Solana account that has no private key. Only the program that created it can move its money. That is exactly what you want for holding funds safely.
{% endhint %}

Your wallet **never appears on-chain** in any shredr transaction. It is used once, to produce a signature. Everything else is signed by derived keys and the relayer.

## Step 1 — Connect and sign

You connect your wallet and sign a short message:

```
SHREDR_V1:<your wallet address>
```

This is a **message signature**, not a transaction. It costs nothing, moves nothing, and touches no chain.

That signature is the seed for everything. shredr feeds it through a hash function several times to produce:

* a **nonce master seed** — drives the chain of burner addresses,
* a **burner master seed** — turns each nonce into an actual keypair,
* a **storage key** — encrypts your local and synced state,
* your **main burner** — the permanent key that owns your consolidation account.

Because a wallet signature over a fixed message is deterministic, signing the same message again on any device reproduces exactly the same keys. That is why there is no seed phrase: your wallet *is* the backup.

→ [Key derivation](../concepts/key-derivation.md)

## Step 2 — Get a burner address

shredr derives the burner for your current position in the chain and shows you its address.

The chain works like this:

```
nonce[0] = SHA256(nonce master seed)
nonce[1] = SHA256(nonce[0])
nonce[2] = SHA256(nonce[1])
...
```

Each nonce yields one burner keypair. Index `0` is reserved, so your first usable burner is at index `1`.

Two useful properties fall out of this:

* **Forward-only.** Knowing `nonce[5]` lets you compute `nonce[6]`, but not `nonce[4]`. Leaking a later nonce does not expose earlier ones.
* **Fully recoverable.** From the signature alone you can regenerate every burner you have ever had, in order.

→ [Burners and stealth PDAs](../concepts/burners-and-stealth-pdas.md)

## Step 3 — Someone pays you

You share the burner address. The sender does a completely ordinary SOL transfer to it.

Meanwhile your browser has an open WebSocket subscription to that address, so the moment the balance changes, shredr knows.

{% hint style="warning" %}
Senders must pay the **burner address**, not the stealth PDA. The program requires the PDA to be empty when it is created, so sending directly there would break initialization. The app only ever displays the burner address for this reason.
{% endhint %}

## Step 4 — Shred

This is the interesting part. It is four on-chain actions in sequence, and the app does them automatically.

{% stepper %}
{% step %}
### Sweep and delegate

`InitializeAndDelegate` creates the burner's stealth PDA, moves the deposit from the burner into it, and hands the PDA over to a MagicBlock TEE validator.

The relayer pays the rent for the new account, so every lamport recorded as your deposit is genuinely yours.
{% endstep %}

{% step %}
### Prepare the destination

If your main PDA is not already delegated, shredr creates it as an empty delegated account so it can receive funds inside the rollup.
{% endstep %}

{% step %}
### Private transfer

`PrivateTransfer` moves the lamports from the stealth PDA into your main PDA — **inside the ephemeral rollup**, not on Solana.

This is the step that breaks the link. The rollup runs in a trusted execution environment; the transfer is not a public Solana transaction and does not appear on the public graph.
{% endstep %}

{% step %}
### Commit and release

`CommitAndUndelegateStealth` flushes the (now empty) stealth PDA's state back to Solana and releases it from the rollup. The burner is finished; shredr rotates to the next one.
{% endstep %}
{% endstepper %}

Your main PDA deliberately **stays delegated**, so it can keep accepting private transfers from future deposits without being re-created each time.

→ [The shred lifecycle](../concepts/shred-lifecycle.md) · [Ephemeral rollups](../concepts/ephemeral-rollups.md)

## Step 5 — Withdraw

When you want your money, you go to the claim page and pick a destination address.

1. If your main PDA is still delegated, shredr commits and undelegates it first, then polls Solana until the account is back on the base layer. This settlement is asynchronous and takes a little time.
2. Your **main burner** signs a `Withdraw` instruction sending lamports to your destination.
3. The relayer pays the fee.

Only the tracked `deposited_amount` is withdrawable. The remaining lamports in the account are the rent-exemption the relayer paid, and the program refuses to touch them — otherwise Solana would reap the account.

→ [Withdraw](../program/instructions/withdraw.md)

## Who pays for all this?

The **Kora relayer** does. It signs every shredr transaction as fee payer, and it also acts as the on-chain `relayer` account for the instructions that need one.

This matters for privacy, not just convenience. If you had to fund each burner from your own wallet to cover fees, that funding transaction would link your wallet to the burner — undoing the entire point.

→ [The Kora relayer](../concepts/relayer.md)

## What the server sees

Almost nothing. The backend stores one small **encrypted blob** holding your current position in the nonce chain, so you can pick up where you left off on a new device.

It is encrypted with a key derived from your wallet signature, which the server never has. To the backend, your state is an opaque ~200-byte string. It cannot tell whose it is, and it cannot read it.

Recovery on a new device works by fetching all blobs and trying to decrypt each one. Only yours succeeds.

→ [State sync and recovery](../concepts/state-sync-and-recovery.md)

## Putting it together

```
   Wallet signature
        │  (once, off-chain)
        ▼
┌──────────────────┐   nonce chain    ┌──────────────────┐
│  NonceService    │ ───────────────▶ │  BurnerService   │
│  (encrypted)     │                  │  (stealth keys)  │
└────────┬─────────┘                  └────────┬─────────┘
         │ encrypted blob                      │
         ▼                                     ▼
┌──────────────────┐              ┌───────────────────────────┐
│  Backend (Axum)  │              │  ShredrProgram (on-chain) │
│  blob storage    │              │  Initialize → Transfer →  │
│  + Helius hooks  │              │  Commit → Withdraw        │
└──────────────────┘              └────────────┬──────────────┘
                                               │  PrivateTransfer
                                               ▼
                                  ┌───────────────────────────┐
                                  │  MagicBlock Ephemeral     │
                                  │  Rollup (TEE-secured)     │
                                  └───────────────────────────┘
```

## Next

* Try it: [Quickstart](quickstart.md)
* Understand the guarantees and their limits: [The privacy model](../concepts/privacy-model.md)
