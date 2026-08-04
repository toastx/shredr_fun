---
description: "Privacy-first burner addresses on Solana — shred your money trail."
icon: scissors
---

# shredr.fun

**shredr.fun** hands you a throwaway Solana address every time you need to get paid. Money sent to that address is quietly moved into a private account you control, so the person paying you never learns your real wallet.

Think of it as **temp-mail, but for money**. You give out a disposable address, it does its job, and then you never use it again.

{% hint style="info" %}
shredr currently runs on Solana **devnet**.
{% endhint %}

## The problem it solves

Solana is a public ledger. If you post your wallet address to get paid, anyone who pays you can look it up and see:

* everything else you have ever received,
* everything you have ever spent,
* how much you hold right now,
* and every other person who has paid you.

One address shared once leaks your entire financial history — forever.

## The idea

Instead of sharing your real wallet, shredr gives each sender a **fresh, single-use address** (a "burner"). Behind the scenes, shredr moves the money off the public ledger into a **private rollup**, hops it into your consolidation account, and settles the result back on-chain.

The sender sees a burner address that goes nowhere. You see the money arrive. Nothing on the public chain connects the two.

```
Sender ──pays──▶ Burner #7 ──▶ [ private rollup hop ] ──▶ Your account ──▶ Your wallet
                    ▲                                          ▲
             public, visible                          public, but unlinked
                                    ▲
                          private, off the public graph
```

## What makes it usable

<table data-view="cards">
<thead><tr><th>Feature</th><th>What it means for you</th></tr></thead>
<tbody>
<tr><td><strong>One signature, no seed phrase</strong></td><td>Everything — every burner, every key — is re-derived from a single wallet signature. There is nothing extra to write down or back up.</td></tr>
<tr><td><strong>Recover on any device</strong></td><td>Connect the same wallet anywhere, sign the same message, and your entire state comes back.</td></tr>
<tr><td><strong>Nothing leaves your browser</strong></td><td>Private keys are derived and used client-side. The server only ever sees encrypted bytes it cannot read.</td></tr>
<tr><td><strong>You never pay gas from your wallet</strong></td><td>A relayer pays the transaction fees, so burner addresses never need funding from you.</td></tr>
</tbody>
</table>

## Where to go next

{% stepper %}
{% step %}
### Understand the flow

[How it works](getting-started/how-it-works.md) walks the whole journey in plain English, with no cryptography required.
{% endstep %}

{% step %}
### Try it

[Quickstart](getting-started/quickstart.md) gets you from a connected wallet to a shredded deposit.
{% endstep %}

{% step %}
### Go deep

[Concepts](concepts/README.md) explains the privacy model, the key derivation, and the on-chain lifecycle.
{% endstep %}

{% step %}
### Build on it

[Frontend library](frontend/README.md), [on-chain program](program/README.md), and [backend](backend/README.md) are the reference sections for each component.
{% endstep %}
{% endstepper %}

## Project at a glance

| Component | Path | Stack | Role |
|---|---|---|---|
| Frontend | `src/` | React 19, Vite, TypeScript | Key derivation, on-chain orchestration, UI |
| On-chain program | `shredr-program/` | Rust, Pinocchio, MagicBlock ER | Stealth PDAs and private transfers |
| Backend | `shredr-backend/` | Rust, Axum, PostgreSQL | Encrypted state sync, Helius webhook management |

Program ID (devnet): `H9pUQeNA2RwBHRwx52V8nqWpCAKReSA3gGUuRFHbEjG6`
