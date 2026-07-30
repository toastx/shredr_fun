<p align="center">
  <img src="public/banner_readme.png" alt="Shredr Banner" />
</p>

# shredr.fun

### Shred your money trail — privacy-first burner addresses on Solana

**shredr.fun** generates disposable, unlinkable burner addresses to receive funds on Solana. Funds land on a one-time **stealth account**, move privately inside a [MagicBlock](https://www.magicblock.gg/) ephemeral rollup, and are consolidated to your destination — so your main wallet is never on the same transaction graph as the sender.

Everything is derived from a **single wallet signature**: no seed phrases to store, no server-held keys, and full recovery on any device.

> [!NOTE]
> This project is a work in progress built for a hackathon. Program and relayer addresses target Solana **devnet** by default.

---

## How it works

1. **Connect & sign** — Your wallet signs one message; this deterministically derives a master seed.
2. **Generate a burner** — A one-time stealth keypair + on-chain stealth PDA is derived from `masterSeed + nonce`.
3. **Receive funds** — Share the burner address. Incoming SOL lands on the burner account itself.
4. **Shred** — `InitializeAndDelegate` sweeps the deposit into the burner's stealth PDA and delegates it to a MagicBlock TEE validator. A `PrivateTransfer` then moves the lamports into your main PDA *inside the rollup*, and the drained stealth PDA is committed and undelegated back to the base layer.
5. **Withdraw** — The main PDA is committed and undelegated, then the main burner signs a withdrawal to your destination address. A [Kora](https://github.com/solana-foundation/kora) relayer pays fees so the burner needs no funding.

Because the sender only ever sees a fresh burner and the private transfer happens off the public graph, incoming payments are unlinkable to your main wallet.

---

## Architecture

The project is a monorepo with three cooperating parts:

| Component | Path | Stack | Role |
|-----------|------|-------|------|
| **Frontend** | [`src/`](src/) | React 19, Vite, TypeScript | Key derivation, on-chain orchestration, UI |
| **On-chain program** | [`shredr-program/`](shredr-program/) | Rust, [Pinocchio](https://github.com/anza-xyz/pinocchio), MagicBlock ER | Stealth PDAs and private transfers |
| **Backend** | [`shredr-backend/`](shredr-backend/) | Rust, Axum, PostgreSQL | Encrypted blob sync, WebSocket, Helius webhooks |

### Data flow

```
   Wallet signature
        │  (once)
        ▼
┌──────────────────┐   nonce chain    ┌──────────────────┐
│  NonceService    │ ───────────────▶ │  BurnerService   │
│  (encrypted)     │                  │  (stealth keys)  │
└────────┬─────────┘                  └────────┬─────────┘
         │ encrypted blob                      │
         ▼                                      ▼
┌──────────────────┐               ┌───────────────────────────┐
│  Backend (Axum)  │               │  ShredrProgram (on-chain) │
│  blob + webhook  │               │  Initialize → Transfer →  │
│  + WebSocket     │◀── Helius ───▶│  Commit → Withdraw        │
└──────────────────┘               └────────────┬──────────────┘
                                                 │  PrivateTransfer
                                                 ▼
                                    ┌───────────────────────────┐
                                    │  MagicBlock Ephemeral      │
                                    │  Rollup (TEE-secured)      │
                                    └───────────────────────────┘
```

### Frontend library (`src/lib/`)

| Module | Responsibility |
|--------|----------------|
| `ShredrClient` | Top-level orchestrator tying signature → burners → on-chain flow |
| `NonceService` | Nonce generation, chaining, and encrypted persistence |
| `BurnerService` | Deterministic stealth / main burner keypair derivation |
| `ShredrProgram` | web3.js facade over the Codama-generated client in `src/generated` |
| `KoraRelayer` | JSON-RPC client for the Kora fee-payer / relayer |
| `StorageService` | Encrypted IndexedDB wrapper for local state |
| `ApiClient` / `WebSocketClient` | Backend blob sync and real-time deposit notifications |

### On-chain program (`shredr-program/`)

A zero-dependency Pinocchio program managing stealth PDAs derived as `["shredr_stealth_address", burner_pubkey]`. Instructions:

| # | Instruction | Purpose |
|---|-------------|---------|
| 0 | `InitializeAndDelegate` | Create a stealth PDA, sweep the burner's deposit into it, delegate it to a MagicBlock TEE validator |
| 1 | `PrivateTransfer` | Move lamports between stealth PDAs inside the rollup |
| 2 | `CommitStealth` | Flush rollup state to the base layer, staying delegated |
| 3 | `CommitAndUndelegateStealth` | Flush state and release the account back to the base layer |
| 4 | `Withdraw` | Burner withdraws to a destination once undelegated |
| — | `UndelegationCallback` | Invoked by the delegation program after finalization (not user-called) |

State stays private inside the TEE-secured rollup; only the net settlement lands on-chain.

---

## Getting started

### Prerequisites

- **Node.js** 18+ and npm
- **Rust** 1.75+ (for the program and backend)
- **Solana CLI** + [`solana-build-sbf`](https://solana.com/docs) (to build the program)
- **PostgreSQL** 14+ (for the backend)

### Frontend

```bash
git clone https://github.com/toastx/shredr_fun.git
cd shredr_fun

npm install
npm run dev      # start the Vite dev server
```

Other scripts:

```bash
npm run build    # type-check and produce a production build
npm run generate:client  # regenerate src/generated from the program IDL
npm run lint     # run ESLint
npm test         # run the Mocha test suite
```

See [tests/README.md](tests/README.md) for test coverage details.

### On-chain program

```bash
cd shredr-program

cargo build-sbf              # build the deployable program (defaults to the devnet feature)
cargo test                   # run the Mollusk SVM tests
cargo bench                  # measure compute units
```

Program ID (devnet): `H9pUQeNA2RwBHRwx52V8nqWpCAKReSA3gGUuRFHbEjG6`

### Backend

```bash
cd shredr-backend
cp .env.example .env         # set DATABASE_URL

cargo run                    # start the Axum server on :8000
```

See [shredr-backend/README.md](shredr-backend/README.md) for the full API reference (blob CRUD, WebSocket, Helius webhook).

---

## Project structure

```
shredr_fun/
├── src/
│   ├── lib/                 # Core services (nonce, burner, program, relayer, storage)
│   ├── generated/           # Codama client (npm run generate:client)
│   ├── components/          # UI components (wallet, generator, monitor, ...)
│   ├── pages/               # GeneratorPage, ClaimPage
│   └── App.tsx              # Routing
├── shredr-program/          # Pinocchio Solana program + Mollusk tests
│   ├── src/instructions/    # Instruction handlers
│   └── idl/                 # Program IDL
├── shredr-backend/          # Axum backend (blob sync, WebSocket, webhooks)
├── scripts/                 # Codama client generation
├── tests/                   # Frontend unit + integration tests
└── public/                  # Static assets
```

---

## Security model

- **Non-custodial** — Private keys are derived and used entirely in the browser; nothing leaves the client.
- **Deterministic recovery** — Every burner is recoverable from the original wallet signature, so state syncs across devices with no seed phrase to store.
- **Encrypted at rest** — Local state (IndexedDB) and synced blobs are encrypted with keys derived from the wallet signature (Web Crypto AES-GCM / SHA-256).
- **Unlinkable transfers** — Private transfers execute inside a TEE-secured MagicBlock rollup; only settlement touches the public ledger.
- **Sponsored withdrawals** — A Kora relayer pays fees, so burner accounts never need to be funded from your main wallet.

> [!WARNING]
> This is hackathon-stage software and has not been audited. Do not use it to secure real funds.

---

## Tech stack

| Layer | Technology |
|-------|------------|
| Frontend | React 19, Vite, TypeScript, `@solana/web3.js`, wallet-adapter |
| Crypto | Web Crypto API (AES-GCM, SHA-256), TweetNaCl, BIP39 |
| Storage | IndexedDB (encrypted) |
| On-chain | Rust, Pinocchio, MagicBlock ephemeral rollups |
| Relayer | Kora paymaster |
| Backend | Rust, Axum, PostgreSQL (SQLx), Helius webhooks |
| Blockchain | Solana (devnet) |
