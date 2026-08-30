---
description: "Why every payment involves two accounts, and which address to give out."
icon: user-secret
---

# Burners and stealth PDAs

Each payment in shredr touches two accounts: a **burner** and its **stealth PDA**. Understanding why there are two — and which one senders use — prevents the most common mistake in the system.

## The two accounts

| | Burner | Stealth PDA |
|---|---|---|
| **What it is** | An ordinary Solana keypair | A program-derived account |
| **Has a private key?** | Yes, derived in your browser | No — none exists |
| **Who controls it** | Whoever holds the key (you) | Only the shredr program |
| **Address** | The ed25519 public key | `PDA(["shredr_stealth_address", burner_pubkey])` |
| **Role** | Receives the deposit; signs to authorize | Holds the funds under program rules |
| **Lifetime** | One payment, then retired | Created, drained, released |

## Which address do senders use?

{% hint style="danger" %}
**Senders pay the burner address.** Never the stealth PDA.
{% endhint %}

`InitializeAndDelegate` **creates** the stealth PDA, and the program rejects the instruction if that account already has lamports:

```rust
if stealth_account.lamports() > 0 {
    return Err(ShredrError::AccountAlreadyInitialized.into());
}
```

A deposit sent straight to the PDA would give it a balance before it exists as a program account, permanently blocking initialization for that burner. The funds would be stuck.

This is why `ShredrClient.receiveAddress` returns the **burner pubkey**, and why the UI never displays the PDA as a receive address:

```typescript
get receiveAddress(): string | null {
    return this._currentBurner?.address ?? null;
}
```

## Why two accounts at all?

A fair question — the burner is a real account that can already hold SOL. Why move it?

<details>
<summary><strong>1. Keypair accounts cannot be delegated to a rollup</strong></summary>

MagicBlock delegation requires a **program-owned** account. A plain wallet-style account owned by the System Program cannot be handed to a rollup validator. Since the whole privacy mechanism depends on the transfer happening inside the rollup, the funds must first live in a program-owned account.
</details>

<details>
<summary><strong>2. Program rules protect the funds</strong></summary>

Once in the PDA, movement is governed by the program: ownership is checked against the recorded `owner`, balances are tracked in `deposited_amount`, and withdrawals are refused while delegated or if they would break rent-exemption.

A raw keypair account has none of that. Anyone holding the key could move the money any way they liked.
</details>

<details>
<summary><strong>3. Separating rent from your money</strong></summary>

The relayer pays the PDA's rent-exemption when creating it. The program tracks your deposit separately in `deposited_amount`, so:

```
PDA lamports = rent-exempt minimum (relayer's) + deposited_amount (yours)
```

Withdrawals are capped at `deposited_amount`, which means the account can never be drained below rent and reaped by the runtime — stranding the residual lamports.
</details>

<details>
<summary><strong>4. Uniform on-chain appearance</strong></summary>

Every stealth PDA has the same size, the same discriminator, and the same owner program. On-chain they are indistinguishable from one another, so a PDA reveals nothing about who created it.
</details>

## PDA derivation

```
seeds  = ["shredr_stealth_address", burner_pubkey]
program = H9pUQeNA2RwBHRwx52V8nqWpCAKReSA3gGUuRFHbEjG6
```

The burner pubkey is the only variable, and since each burner is one-time, the PDA is unique without any extra salt.

{% hint style="info" %}
The `StealthAccount` struct carries a 32-byte field at that offset, once a reserved `salt` and now `receipt_commitment`: an opaque receipt commitment the client writes and the program never reads. Reusing the slot kept the layout, size and rent unchanged. See [Viewing keys](viewing-keys.md).
{% endhint %}

Client side (`src/lib/ShredrProgram.ts`):

```typescript
export function deriveStealthPDA(burnerPubkey: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.STEALTH_ADDRESS, burnerPubkey.toBuffer()],
    SHREDR_PROGRAM_ID,
  );
}
```

Program side (`shredr-program/src/helpers.rs`):

```rust
Address::derive_program_address(
    &[seeds::STEALTH_ADDRESS, burner_pubkey.as_ref()],
    &PROGRAM_ADDRESS,
)
```

`verify_stealth_pda()` re-derives the address on every instruction and compares it against the account passed in, so a caller cannot substitute a different account.

→ [PDA derivation](../program/pdas.md) for the delegation-related PDAs too

## Rotating burners

After a deposit is shredded, that burner is finished. `consumeAndGenerateNew()`:

1. Zeroes the old burner's secret key from memory,
2. Advances the nonce chain by one (`consumeNonce()`),
3. Uploads a new encrypted blob for the new position,
4. Deletes the old blob,
5. Derives the new burner and refreshes the stealth PDA.

```typescript
const newBurner = await shredrClient.consumeAndGenerateNew();
// receiveAddress now points at the new burner
```

{% hint style="warning" %}
Rotation happens on **shred**, not on display. If you copy a burner address and hand it to two different senders before any deposit lands, both payments go to the same burner — and those two senders can see each other's payments. One address, one sender.
{% endhint %}

## The main burner is different

Your consolidation account uses the **same PDA derivation** but a burner that never rotates:

| | Rotating burner | Main burner |
|---|---|---|
| Derived from | `SHA256(burnerSeed ‖ nonce[N])` | `SHA256(signature ‖ "SHREDR_MAIN_BURNER")` |
| Position in nonce chain | Index `N` | None — sentinel index `-1` |
| Rotates | Every payment | Never |
| Its PDA | Receives one deposit, then drained | Accumulates everything |
| Stays delegated | No — released after each shred | Yes, until you withdraw |

Both PDAs are structurally identical. "Main" is purely a matter of which burner owns it.

## The lifecycle of one burner

```
       derived from nonce[N]
                │
                ▼
    ┌───────────────────────┐
    │  empty                │  ← displayed as your receive address
    └───────────┬───────────┘
                │  sender deposits SOL
                ▼
    ┌───────────────────────┐
    │  received             │  ← SOL sits on the burner keypair account
    └───────────┬───────────┘
                │  InitializeAndDelegate (burner signs)
                ▼
    ┌───────────────────────┐
    │  delegated            │  ← swept into the stealth PDA, now in the rollup
    └───────────┬───────────┘
                │  PrivateTransfer → main PDA (inside rollup)
                │  CommitAndUndelegateStealth
                ▼
    ┌───────────────────────┐
    │  spent                │  ← PDA is empty and back on the base layer
    └───────────────────────┘
```

`ShredrClient.scanPendingUtxos()` reports exactly these states:

| Status | Detected by |
|---|---|
| `empty` | Neither burner nor PDA holds anything |
| `received` | Burner has lamports; PDA has no `deposited_amount` |
| `delegated` | PDA has `deposited_amount` and `delegated == true` |
| `ready` | PDA has `deposited_amount` and `delegated == false` — withdrawable |
| `spent` | Already withdrawn (defined in the type; the scanner reports it as `empty`) |

## Scanning for missed deposits

If deposits landed while the app was closed, they are sitting on burners in the `received` state. `scanPendingUtxos()` walks the chain to find them:

```typescript
const pending = await shredrClient.scanPendingUtxos();
// [{ nonceIndex: 3, burnerAddress: "...", stealthPda: "...",
//    lamports: 500000000, status: "received" }]

await shredrClient.shredPendingDeposits();  // shreds every "received" one
```

The scan starts at index 1, checks up to `MAX_UTXO_SCAN_INDEX` (64), and stops after `UTXO_SCAN_EMPTY_THRESHOLD` (5) consecutive empty indices. For each index it fetches the burner balance and the PDA account in parallel, then zeroes the burner's key before moving on.

{% hint style="warning" %}
A gap of more than 5 unused indices will terminate the scan early and miss anything beyond it. In normal use the chain has no gaps, since it only advances when a burner is consumed.
{% endhint %}

## Next

* [The shred lifecycle](shred-lifecycle.md) — what happens between `received` and `spent`
* [Accounts and state](../program/accounts-and-state.md) — the on-chain layout
