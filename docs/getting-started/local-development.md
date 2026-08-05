---
description: "Run the frontend, the backend, the program, and the relayer on your own machine."
icon: laptop-code
---

# Local development

shredr has three parts you can run and two external services it talks to. You can work on any one part without running the others — this page covers each in isolation, then the full stack.

## Prerequisites

| Tool | Version | Needed for |
|---|---|---|
| Node.js | 18+ | Frontend |
| Rust | 1.75+ | Program and backend |
| Solana CLI + `cargo build-sbf` | latest | Building/deploying the program |
| PostgreSQL | 14+ | Backend |
| Docker | any | Optional, easiest way to get Postgres |

## Frontend

```bash
git clone https://github.com/toastx/shredr_fun.git
cd shredr_fun

npm install
npm run dev
```

The Vite dev server comes up on `http://localhost:5173`.

Other scripts:

```bash
npm run build            # type-check (tsc -b) and produce a production build
npm run generate:client  # regenerate src/generated from the program IDL
npm run lint             # ESLint
npm test                 # Mocha test suite
npm run preview          # serve the production build locally
```

{% hint style="info" %}
`src/polyfills.ts` shims `process` and `Buffer` before the module graph evaluates — several Solana packages assume a Node environment. Do not remove the import at the top of `main.tsx`.
{% endhint %}

### Configuration

Copy `.env.example` to `.env` and fill it in — every value below is read at runtime:

```bash
VITE_KORA_RELAYER_URL=http://localhost:8080
VITE_KORA_RELAYER_PUBKEY=shredrWUYk1famp42neAhaJb9PAB69WoSTDhMUdcbjS
VITE_HELIUS_RPC_URL=https://devnet.helius-rpc.com/?api-key=YOUR_HELIUS_API_KEY
VITE_HELIUS_WSS_URL=wss://devnet.helius-rpc.com/?api-key=YOUR_HELIUS_API_KEY
VITE_MAGICBLOCK_RPC_URL=https://devnet.magicblock.app
VITE_MAGICBLOCK_WSS_URL=wss://devnet.magicblock.app
VITE_API_BASE_URL=http://localhost:8000
```

{% hint style="warning" %}
**There are no hardcoded fallbacks.** `src/lib/constants.ts` reads each of these from `import.meta.env`; an unset variable becomes `""` and the dependent feature fails (with a `console.warn` in dev). Vite inlines them at build time, so `npm run build` and container builds need them present in the build environment — `.env` is gitignored and the `Dockerfile` does not copy it.

See [Constants and configuration](../frontend/configuration.md) for the full picture.
{% endhint %}

## On-chain program

```bash
cd shredr-program

cargo build-sbf     # build the deployable .so (defaults to the `devnet` feature)
cargo test          # Mollusk SVM tests
cargo bench         # compute-unit measurements
```

Cargo features:

| Feature | Effect |
|---|---|
| `devnet` (default) | No pinned TEE validator — the delegation program picks the network default |
| `mainnet` | Pins `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo` as the TEE validator |
| `logging` | Emits an instruction name via `pinocchio_log` on every dispatch |

Build for mainnet with:

```bash
cargo build-sbf --features mainnet
```

{% hint style="info" %}
If you change instruction layouts, regenerate the IDL and then run `npm run generate:client` at the repo root so `src/generated` stays in sync. The `ShredrProgram` test suite pins the client wire format against the program, so a drift shows up in `npm test` rather than on devnet.
{% endhint %}

→ [Building and testing](../program/building-and-testing.md)

## Backend

### 1. Start PostgreSQL

{% tabs %}
{% tab title="Docker" %}
```bash
docker run --name shredr-postgres \
  -e POSTGRES_PASSWORD=password \
  -e POSTGRES_DB=shredr_db \
  -p 5432:5432 \
  -d postgres:14
```
{% endtab %}

{% tab title="Local install" %}
```bash
createdb shredr_db
```
{% endtab %}
{% endtabs %}

### 2. Set environment variables

{% hint style="warning" %}
`shredr-backend/.env.example` is out of date — it lists a single `DATABASE_URL`. The current `main.rs` builds the connection string from four separate `PG*` variables and will **panic on startup** if any is missing.
{% endhint %}

Create `shredr-backend/.env`:

```bash
PGHOST=localhost:5432
PGUSER=postgres
PGPASSWORD=password
PGDATABASE=shredr_db

HELIUS_API_KEY=your_helius_api_key
ENVIRONMENT=development
PORT=8000
RUST_LOG=shredr_backend=debug,tower_http=debug,sqlx=info
```

The connection string is assembled as:

```
postgres://{PGUSER}:{PGPASSWORD}@{PGHOST}/{PGDATABASE}?sslmode=require
```

{% hint style="info" %}
`sslmode=require` is always appended. For a plain local Postgres without TLS you will need to enable SSL on the server or adjust `build_database_url()` in `main.rs`.
{% endhint %}

### 3. Run

```bash
cd shredr-backend
cargo run
```

The server listens on `0.0.0.0:8000` and creates its schema on first run.

Check it:

```bash
curl http://localhost:8000/health   # → OK
```

→ [Backend configuration](../backend/configuration.md)

## Kora relayer

shredr expects a Kora paymaster at `http://localhost:8080` speaking JSON-RPC, exposing `signAndSendTransaction`, `signTransaction`, and ideally `getConfig`.

Kora must be configured to:

* sign as the fee payer for every shredr transaction,
* allow the shredr program ID,
* have a funded relayer keypair on devnet.

The default relayer pubkey baked into the app is `shredrWUYk1famp42neAhaJb9PAB69WoSTDhMUdcbjS`. Override it with `VITE_KORA_RELAYER_PUBKEY` if your deployment uses a different key.

See the [Kora repository](https://github.com/solana-foundation/kora) for setup, and [The Kora relayer](../concepts/relayer.md) for how shredr uses it.

{% hint style="danger" %}
Without a working relayer, **nothing on-chain works**. Every shredr instruction has Kora as fee payer, and `InitializeAndDelegate` and the commit instructions require it as a signing account. There is no fallback path where your own wallet pays.
{% endhint %}

## The full stack

Four terminals:

```bash
# 1. Postgres
docker start shredr-postgres

# 2. Backend
cd shredr-backend && cargo run

# 3. Kora relayer
kora --config kora.toml     # see Kora docs

# 4. Frontend
npm run dev
```

Then open `http://localhost:5173`.

## Running the tests

{% tabs %}
{% tab title="Frontend" %}
```bash
npm test
```

Mocha + Chai, with `fake-indexeddb` polyfilling IndexedDB. Covers `NonceService`, `BurnerService`, `ShredrProgram` wire format, and the full integration flow.

Config lives in `.mocharc.json`; `tests/setup.ts` installs the IndexedDB and crypto polyfills.
{% endtab %}

{% tab title="Program" %}
```bash
cd shredr-program
cargo test      # Mollusk SVM tests
cargo bench     # compute units
```
{% endtab %}

{% tab title="Backend" %}
```bash
cd shredr-backend
cargo test
```

The current tests cover blob size validation and do not require a live database — they use a lazy connection pool.
{% endtab %}
{% endtabs %}

→ [tests/README.md](https://github.com/toastx/shredr_fun/blob/main/tests/README.md) has the per-suite breakdown.

## Docker

A `Dockerfile` and `.dockerignore` sit at the repo root for the frontend, and `shredr-backend/Dockerfile` builds the backend. The backend reads `PORT` from the environment, which suits platforms like Koyeb or Fly.

→ [Configuration and deployment](../backend/configuration.md)
