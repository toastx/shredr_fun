---
description: "The two pages, the component library, and the wallet provider."
icon: window
---

# UI components and pages

The UI is deliberately thin. All logic lives in `src/lib`; components render and dispatch.

## Routing

`src/App.tsx`:

```tsx
<Navbar brandName="shredr.fun" />
<Routes>
  <Route path="/"      element={<GeneratorPage />} />
  <Route path="/claim" element={<ClaimPage />} />
</Routes>
<Footer author="toastx" />
```

Two routes. That is the whole app.

## WalletProvider

`src/providers/WalletProvider.tsx` wraps the app in the Solana wallet adapter stack: `ConnectionProvider` → `WalletProvider` → `WalletModalProvider`, with `PhantomWalletAdapter` and `SolflareWalletAdapter` registered and `autoConnect` enabled.

{% hint style="warning" %}
The provider's `ConnectionProvider` endpoint is `clusterApiUrl('mainnet-beta')`, while everything else in shredr targets **devnet** via `HELIUS_RPC_URL`.

In practice this is harmless — shredr never uses the adapter's connection, since `ShredrClient` creates its own `Connection` objects. But `useConnection()` in any new component would return a mainnet connection, which is a trap worth knowing about.
{% endhint %}

## GeneratorPage

`src/pages/GeneratorPage/` — the main page, where you get a burner and receive funds.

### State machine

```typescript
type PageState =
  | "disconnected"   // wallet not connected
  | "connected"      // connected, not signed
  | "signing"        // signature in progress
  | "initializing"   // services starting
  | "ready"          // burner ready
  | "monitoring"     // watching for deposits
  | "error";
```

### What it does

{% stepper %}
{% step %}
### Connect

`useWallet()` and `useWalletModal()` from the adapter. Disconnecting resets everything, disconnects the WebSocket, and calls `shredrClient.destroy()`.
{% endstep %}

{% step %}
### Sign

```typescript
const message = `${MASTER_MESSAGE}:${publicKey.toBase58()}`;
const signature = await signMessage(new TextEncoder().encode(message));
await shredrClient.initFromSignature(signature, publicKey.toBytes());
```
{% endstep %}

{% step %}
### Display and subscribe

Renders `shredrClient.receiveAddress` (the **burner pubkey**) via `AddressDisplay`, subscribes to it over WebSocket, and fetches the initial balance.
{% endstep %}

{% step %}
### Auto-shred on deposit

On an `accountUpdate`, `handleDeposit()`:

1. Returns early if a shred is already running (`shreddingRef`)
2. Returns early if signing mode is not `auto`
3. **Confirms the balance on-chain** rather than trusting the notification
4. Runs `shredBurner()`, then `rotateBurner()`
{% endstep %}
{% endstepper %}

### Patterns worth copying

<details>
<summary><strong>Ref-synced address</strong></summary>

The WebSocket handler is registered once but must act on whichever burner is current when a deposit lands — not the one that existed at registration time. A `receiveAddressRef` mirrors the state:

```typescript
useEffect(() => { receiveAddressRef.current = receiveAddress; }, [receiveAddress]);
```
</details>

<details>
<summary><strong>Concurrency guard</strong></summary>

`shreddingRef` prevents overlapping shreds if two notifications arrive close together. Reset in a `finally` so a failure does not wedge it.
</details>

<details>
<summary><strong>Not trusting the notification</strong></summary>

Subscriptions to rotated burners are never torn down, so a stale notification is possible. The handler always re-reads the balance on-chain before acting.
</details>

<details>
<summary><strong>Teardown order</strong></summary>

On disconnect and unmount: remove the message handler, disconnect the WebSocket, **then** destroy the client. Reversing this lets a late callback run against a half-destroyed client.
</details>

<details>
<summary><strong>Silent shred failures</strong></summary>

`handleDeposit` logs errors rather than surfacing them. Deliberate: the funds stay safely on the burner and the claim page's scan will find them, so an error banner would alarm without informing.
</details>

## ClaimPage

`src/pages/ClaimPage/` — check your balance and withdraw.

### State machine

```typescript
type PageState =
  | 'idle' | 'unlocking' | 'loadingBalance'
  | 'ready' | 'withdrawing' | 'newUser' | 'error';
```

### What it does

1. **Unlock** — sign the same `SHREDR_V1:<wallet>` message to re-derive the main burner and PDA
2. **Load balance** — `getStealthBalance()`, which reads the main PDA's `depositedAmount`
3. **Withdraw** — `withdrawToWallet(destination, amount)`, undelegating first if needed

### Patterns worth copying

<details>
<summary><strong>Debounced balance fetches</strong></summary>

`BALANCE_FETCH_DEBOUNCE_MS = 1000`, tracked with a `lastBalanceFetchRef`. A `force` flag bypasses it for the initial load, so the first fetch is never dropped.
</details>

<details>
<summary><strong>Mount guard</strong></summary>

`isMountedRef` is checked after every `await` before calling `setState`, avoiding React warnings and stale updates if the user navigates away mid-request.
</details>

<details>
<summary><strong>Balance failures are not fatal</strong></summary>

A failed fetch sets the balance to 0 and moves to `ready` rather than `error` — an uninitialized main PDA is a perfectly normal state for a new user.
</details>

## Components

All in `src/components/`, barrel-exported from `src/components/index.ts`.

| Component | Props | Purpose |
|---|---|---|
| `Navbar` | `brandName?` | Top bar with the wallet button |
| `Footer` | `author` | Footer |
| `AddressDisplay` | `label`, `value`, `placeholder?`, `isCopied`, `hasValue`, `onCopy` | Click-to-copy address with copied state |
| `TransactionMonitor` | `burnerAddress` | Live feed of transactions for an address |
| `TransactionApprovalModal` | `transaction`, `burnerAddress`, `onApprove`, `onReject`, `isProcessing?` | Confirmation modal for manual signing mode |
| `WalletButton` | — | Styled wallet connect button |

Each lives in its own directory with a `.tsx`, a `.css`, and an `index.ts`.

{% hint style="info" %}
`TransactionApprovalModal` is the only component here that nothing renders. It is
the UI half of manual signing: `ShredrClient.setSigningMode("manual")` and the
`PendingTransaction` type exist, but no page wires them to the modal yet. Kept
deliberately — it is an unfinished feature, not a leftover.
{% endhint %}

### TransactionApprovalModal

Backs manual signing mode, rendering a `PendingTransaction`:

```typescript
interface PendingTransaction {
  amount: number;
  destination?: string;
  source?: string;
  kind?: 'sweep' | 'withdraw' | 'private-transfer' | 'init-delegate' | 'commit-undelegate';
}
```

## Styling

Plain CSS, one file per component, plus `App.css` and `index.css` globally. No CSS framework, no CSS-in-JS. The wallet adapter's own stylesheet is imported in `WalletProvider`.

## Adding a page

1. Create `src/pages/YourPage/` with `YourPage.tsx`, `YourPage.css`, `index.ts`
2. Export it from `src/pages/index.ts`
3. Add a `<Route>` in `App.tsx`
4. Use `shredrClient` for all logic — do not reach into `nonceService` or `burnerService` directly
5. Destroy the client and disconnect the WebSocket on unmount, **in that order**

## Next

* [ShredrClient](shredr-client.md) — the API these pages call
* [Constants and configuration](configuration.md)
