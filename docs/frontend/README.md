---
description: "The React app: what each module does and how they fit together."
icon: react
---

# Frontend overview

The frontend is where all the interesting work happens. It derives every key, builds every transaction, tracks state, and drives the whole flow. The backend is a convenience; the program is an enforcement layer. **The client is the application.**

## Stack

| Layer | Technology |
|---|---|
| Framework | React 19 + Vite 7 + TypeScript 5.9 |
| Routing | `react-router-dom` 7 |
| Solana | `@solana/web3.js` v1 + `@solana/kit` v7 |
| Wallets | `@solana/wallet-adapter-react` + `-react-ui` |
| Crypto | Web Crypto API (AES-GCM, SHA-256), TweetNaCl, BIP39 |
| Storage | IndexedDB (encrypted) |
| Tests | Mocha + Chai + `fake-indexeddb` |

## Directory layout

```
src/
├── lib/                 # Core services — the real logic
│   ├── ShredrClient.ts      # Top-level orchestrator
│   ├── NonceService.ts      # Nonce chain + encryption + blob sync
│   ├── BurnerService.ts     # Keypair derivation
│   ├── ShredrProgram.ts     # web3.js facade over the generated client
│   ├── KoraRelayer.ts       # Relayer JSON-RPC client
│   ├── StorageService.ts    # Encrypted IndexedDB
│   ├── ApiClient.ts         # Backend blob CRUD
│   ├── WebSocketClient.ts   # Helius account subscriptions
│   ├── constants.ts         # All configuration
│   ├── types.ts             # Shared types
│   └── utils.ts             # Encoding + memory zeroing
├── generated/           # Codama client from the IDL — do not edit by hand
├── components/          # UI components
├── pages/               # GeneratorPage, ClaimPage
├── providers/           # WalletProvider
├── polyfills.ts         # process/Buffer shims
└── App.tsx              # Routing
```

## How the modules relate

```
                       ┌──────────────────┐
                       │  GeneratorPage   │
                       │  ClaimPage       │
                       └────────┬─────────┘
                                │
                       ┌────────▼─────────┐
                       │  ShredrClient    │  orchestrator
                       └────────┬─────────┘
             ┌──────────┬───────┼────────┬──────────────┐
             ▼          ▼       ▼        ▼              ▼
      NonceService  Burner  Shredr    Kora         ApiClient
             │      Service  Program   Relayer          │
             ▼                  │         │             ▼
      StorageService            ▼         ▼         Backend
      (IndexedDB)          generated/   Kora
                           (Codama)     service

      WebSocketClient ──────────────────────────▶ Helius WSS
```

## The modules

<table data-view="cards">
<thead><tr><th>Module</th><th>Responsibility</th></tr></thead>
<tbody>
<tr><td><a href="shredr-client.md">ShredrClient</a></td><td>Ties everything together: initialization, shredding, withdrawal, UTXO scanning. The only module pages talk to directly.</td></tr>
<tr><td><a href="nonce-service.md">NonceService</a></td><td>The nonce hash chain, AES-GCM encryption, and blob sync logic.</td></tr>
<tr><td><a href="burner-service.md">BurnerService</a></td><td>Turns nonces into ed25519 keypairs. Derives the main burner. Zeroes secrets.</td></tr>
<tr><td><a href="shredr-program.md">ShredrProgram</a></td><td>PDA derivation and instruction builders — a web3.js v1 facade over the generated kit client.</td></tr>
<tr><td><a href="kora-relayer.md">KoraRelayer</a></td><td>JSON-RPC client for the relayer. Handles the base-layer vs. rollup send split.</td></tr>
<tr><td><a href="storage-service.md">StorageService</a></td><td>Encrypted IndexedDB with a per-key mutex.</td></tr>
<tr><td><a href="api-and-websocket.md">ApiClient / WebSocketClient</a></td><td>Backend blob CRUD and real-time deposit notifications.</td></tr>
<tr><td><a href="ui.md">UI components and pages</a></td><td>The two pages and the component library behind them.</td></tr>
<tr><td><a href="configuration.md">Constants and configuration</a></td><td>Every constant, what it does, and which ones are actually wired up.</td></tr>
</tbody>
</table>

## Singletons

Most services export a singleton alongside the class:

```typescript
export const shredrClient   = new ShredrClient();
export const nonceService   = new NonceService();
export const burnerService  = new BurnerService();
export const koraRelayer    = new KoraRelayer();
export const apiClient      = new ApiClient();
export const webSocketClient = new WebSocketClient();
```

The app uses the singletons; tests instantiate classes directly for isolation. `StorageService` is the exception — `NonceService` owns a private instance.

{% hint style="warning" %}
Singletons hold derived secrets in memory. `shredrClient.destroy()` cascades cleanup through `nonceService.destroy()` and `burnerService.destroy()`, zeroing seeds and keys. `GeneratorPage` calls it on wallet disconnect — a pattern to preserve if you add new entry points.
{% endhint %}

## The generated client

`src/generated/` is produced by [Codama](https://github.com/codama-idl/codama) from the program's IDL:

```bash
npm run generate:client   # runs scripts/generate-client.mjs
```

It contains instruction builders, the account decoder, error codes, and async PDA finders, written against `@solana/kit`.

{% hint style="danger" %}
**Never edit `src/generated/` by hand.** Change the program, regenerate the IDL, then regenerate the client. The `ShredrProgram` test suite pins the wire format so drift fails in `npm test` rather than on devnet.
{% endhint %}

`ShredrProgram.ts` adapts kit instructions to web3.js v1 `TransactionInstruction`s and provides **synchronous** PDA derivation — the generated finders are async because kit hashes via SubtleCrypto, which is awkward in synchronous UI code.

## Two Solana libraries?

Yes, and it is intentional:

| Library | Used for |
|---|---|
| `@solana/web3.js` v1 | Connections, `Keypair`, `PublicKey`, `VersionedTransaction`, wallet adapter |
| `@solana/kit` v7 | The generated instruction builders and decoders |

`ShredrProgram.ts` is the boundary. `toAddress()`, `toSigner()`, and `toTransactionInstruction()` convert between them. Nothing else in the app should need to know kit exists.

## Polyfills

`src/polyfills.ts` shims `process` and `Buffer` before the module graph evaluates. Several Solana packages assume Node globals. The import must stay at the very top of `main.tsx`, or you will get cryptic runtime errors in the browser.

## Testing

```bash
npm test
```

| Suite | Covers |
|---|---|
| `NonceService.test.ts` | Chain derivation, encryption round-trips, blob logic, edge cases (~41 tests) |
| `BurnerService.test.ts` | Keypair derivation, memory clearing, recovery scanning (~25 tests) |
| `ShredrProgram.test.ts` | Instruction wire format, PDA seeds, account metas, error codes (20 tests) |
| `IntegrationFlow.test.ts` | The full five-phase flow, plus returning-user and new-device scenarios |

Each integration test uses a distinct mock wallet pubkey so IndexedDB state from a previous run cannot collide.

## Next

Start with [ShredrClient](shredr-client.md) — everything else hangs off it.
