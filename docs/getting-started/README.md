---
description: "What shredr.fun is, who it is for, and what it does not do."
icon: flag-checkered
---

# Overview

shredr.fun is a web app that gives you **disposable Solana addresses** for receiving money, and then privately consolidates that money into an account only you can withdraw from.

## Who this is for

* **Freelancers and contractors** who invoice clients and do not want each client seeing their full balance and payment history.
* **Anyone accepting donations or tips** publicly, who does not want a permanent public record tied to their main wallet.
* **Developers** who want a worked example of MagicBlock ephemeral rollups, Pinocchio programs, and relayer-sponsored transactions.

## What you need

* A Solana wallet that supports **message signing** (Phantom, Solflare, Backpack — anything supported by `@solana/wallet-adapter`).
* Nothing else. No seed phrase to store, no account to register, no funds to pre-deposit.

## What it does

{% stepper %}
{% step %}
### Gives you a burner address

Each time you need to be paid, shredr shows a fresh Solana address. It is a real, ordinary address — the sender does not need to know or do anything special.
{% endstep %}

{% step %}
### Shreds the deposit

Once money arrives, shredr sweeps it into a program-controlled account, moves it through a private rollup into your consolidation account, and settles the result back to Solana.
{% endstep %}

{% step %}
### Lets you claim

Whenever you want, you withdraw the accumulated balance to any destination address you choose.
{% endstep %}
{% endstepper %}

## What it does **not** do

shredr hides the *link* between sender and receiver. A few things are outside its scope:

| It does not... | Why |
|---|---|
| Hide that a payment happened | The sender's transaction to the burner is a normal, public Solana transaction. |
| Hide the amount | Deposit and withdrawal amounts are visible on-chain. Use round, normalized amounts (1, 10, 100, 1000 SOL) so they blend in. |
| Work with SPL tokens | Only native SOL is supported today. |
| Protect you from a compromised browser | Keys are derived and held client-side, so the machine running the app has to be one you trust. |

## The three pieces

shredr is a monorepo with three cooperating parts. You do not need to run all three to understand it, but you do to run it locally.

| Piece | What it is | Read more |
|---|---|---|
| **Frontend** | A React app that derives all keys, builds transactions, and drives the flow | [Frontend](../frontend/README.md) |
| **On-chain program** | A Rust (Pinocchio) Solana program that owns the stealth accounts | [Program](../program/README.md) |
| **Backend** | A small Rust (Axum) service that stores encrypted state blobs and manages Helius webhooks | [Backend](../backend/README.md) |

Plus two external services:

* **[MagicBlock](https://www.magicblock.gg/)** — the ephemeral rollup where the private transfer happens.
* **[Kora](https://github.com/solana-foundation/kora)** — the relayer that pays transaction fees so burners never need funding.

## Next

Read [How it works](how-it-works.md) for the full journey in plain language.
