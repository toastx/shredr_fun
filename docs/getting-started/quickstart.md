---
description: "Go from a connected wallet to a shredded deposit and a withdrawal."
icon: rocket
---

# Quickstart

This walks the app from a user's point of view. To stand up the whole stack yourself, see [Local development](local-development.md) first.

## Before you start

* A Solana wallet extension that can **sign messages** (Phantom, Solflare, Backpack).
* Some **devnet SOL** in a second wallet to play the role of the sender. Get it from the [Solana faucet](https://faucet.solana.com/).
* A running frontend (`npm run dev`), backend, and Kora relayer — see [Local development](local-development.md).

{% hint style="info" %}
Everything targets **devnet** by default. The program ID `H9pUQeNA2RwBHRwx52V8nqWpCAKReSA3gGUuRFHbEjG6` is deployed there.
{% endhint %}

## Receive a payment

{% stepper %}
{% step %}
### Connect your wallet

Open the app at `http://localhost:5173` and click connect. Pick your wallet.

The page moves from `disconnected` to `connected`.
{% endstep %}

{% step %}
### Sign the derivation message

Click the sign prompt. Your wallet asks you to sign:

```
SHREDR_V1:<your wallet address>
```

Approve it. This is a **message signature** — it is free, it is not a transaction, and it does not touch the chain.

Behind the scenes shredr now derives your master seeds, your main burner, and your current burner. If this is your first time, it also creates an encrypted state blob on the backend.
{% endstep %}

{% step %}
### Copy the burner address

The page displays a receive address. **This is the burner pubkey** — the one-time address to give the sender.

Copy it.

{% hint style="warning" %}
Give out exactly this address. Do not try to send to the stealth PDA — the program requires that account to be empty when it is created, so a direct deposit there would break the flow.
{% endhint %}
{% endstep %}

{% step %}
### Send SOL to it

From your second (sender) wallet, send some devnet SOL to the burner address. A plain transfer is all it is.
{% endstep %}

{% step %}
### Watch it shred

Your browser holds a WebSocket subscription on the burner. When the balance changes, the app:

1. Confirms the balance on-chain (it does not trust the notification alone),
2. Runs the four-instruction shred,
3. Rotates you to a fresh burner address.

Open the browser console to watch the signatures come back:

```
Shredded deposit: {
  initializeAndDelegate: "...",
  initializeMainPda: "...",   // null after the first shred
  privateTransfer: "...",
  commitAndUndelegate: "..."
}
```

The address on screen changes. That is your next burner.
{% endstep %}
{% endstepper %}

## Claim your funds

{% stepper %}
{% step %}
### Go to the claim page

Navigate to `/claim`.
{% endstep %}

{% step %}
### Unlock

Sign the same `SHREDR_V1:<wallet>` message again. This re-derives your main burner and main PDA — nothing is stored between sessions that could not be regenerated.
{% endstep %}

{% step %}
### Check the balance

The page shows the withdrawable balance of your main PDA.

This reads the PDA's tracked `deposited_amount`, **not** its raw lamport balance. The difference is the rent-exemption the relayer paid, which is not yours to withdraw.
{% endstep %}

{% step %}
### Withdraw

Enter a destination address and an amount (or withdraw everything).

If your main PDA is still delegated to the rollup, shredr commits and undelegates it first, then polls until Solana confirms it is back. That settlement is asynchronous — expect a wait of up to two minutes before the withdrawal itself goes through.

Your main burner signs the `Withdraw`. Kora pays the fee. Done.
{% endstep %}
{% endstepper %}

## Catching up on missed deposits

If a payment landed while the app was closed, nothing is lost — it is sitting on a burner you can re-derive.

`shredPendingDeposits()` scans forward through your nonce chain, finds every burner holding an unswept deposit, and shreds each one. The claim page uses this.

The scan checks up to 64 indices and stops early after 5 consecutive empty ones, so it stays cheap.

→ [State sync and recovery](../concepts/state-sync-and-recovery.md)

## Using a different device

Connect the same wallet, sign the same message. shredr:

1. finds no local IndexedDB state,
2. downloads every encrypted blob from the backend,
3. tries to decrypt each one — only yours succeeds,
4. picks the one with the highest nonce index (your latest state),
5. restores it locally and carries on.

No export, no import, no seed phrase.

## Next

* What the guarantees actually are: [The privacy model](../concepts/privacy-model.md)
* When something goes wrong: [Troubleshooting](../reference/troubleshooting.md)
