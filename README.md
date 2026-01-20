<p align="center">
  <img src="public/banner_readme.png" alt="Shredr Banner" />
</p>

# shredr.fun

### **Shred Your Money Trail - Privacy-First Burner Wallets on Solana**

**shredr.fun** is a privacy utility that generates disposable, unlinkable burner addresses to receive funds on Solana. Using deterministic key derivation and private transfers by shadowwire, it ensures your main wallet is never linked to incoming transactions.

---

## 🔄 How It Works

1. **Connect Wallet** → Sign a message to derive your encryption keys
2. **Generate Burner** → Get a fresh burner address (deterministic, recoverable)
3. **Receive Funds** → Share the burner address with sender
4. **Shred** → Deposit funds to ShadowWire pool for private transfer to your destination

---

## 🏗 Architecture

### Services

| Service | Purpose |
|---------|---------|
| **NonceService** | Manages nonce generation, chaining, and encrypted storage |
| **BurnerService** | Derives burner keypairs from nonces |
| **StorageService** | Encrypted IndexedDB wrapper for local state |
| **ShadowWireClient** | Integration with ShadowWire privacy pool |

### Flow

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Wallet Sign    │ ──▶ │  NonceService   │ ──▶ │  BurnerService  │
│  (Auth)         │     │  (Nonce Chain)  │     │  (Keypair)      │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                               │
                               ▼
                        ┌─────────────────┐
                        │  Backend API    │
                        │  (Blob Sync)    │
                        └─────────────────┘
```

### State Management

- **Local State** (IndexedDB): Encrypted cache for fast access
- **Remote State** (Backend): Source of truth for cross-device recovery
- **Sync Logic**: Higher index wins, automatic sync on init

---

## 🛠 Tech Stack

| Layer | Technology |
|-------|------------|
| **Frontend** | TypeScript, Vite, React |
| **Crypto** | Web Crypto API (AES-GCM, SHA-256) |
| **Storage** | IndexedDB (encrypted) |
| **Backend** | Rust (Axum) |
| **Privacy** | ShadowWire (@radr/shadowwire) |
| **Blockchain** | Solana |

---

## 📦 Getting Started

### Prerequisites

- Node.js 18+
- npm or pnpm

### Installation

```bash
# Clone the repository
git clone https://github.com/your-username/shredr.git
cd shredr

# Install dependencies
npm install

# Run development server
npm run dev
```

### Running Tests

```bash
npm test
```

See [tests/README.md](tests/README.md) for test coverage details.

---

## 📁 Project Structure

```
shredr/
├── src/
│   ├── lib/
│   │   ├── NonceService.ts    # Nonce management
│   │   ├── BurnerService.ts   # Burner derivation
│   │   ├── StorageService.ts  # Encrypted IndexedDB
│   │   ├── ShadowWireClient.ts # Privacy pool integration
│   │   ├── constants.ts       # Shared constants
│   │   ├── types.ts           # TypeScript types
│   │   ├── utils.ts           # Crypto utilities
│   │   └── index.ts           # Exports
│   └── ...
├── tests/
│   ├── NonceService.test.ts   # 41 unit tests
│   ├── setup.ts               # Test environment
│   └── README.md              # Test documentation
├── shredr-backend/            # Rust backend (separate)
└── ...
```

---

## 🔐 Security Features

- **Non-Custodial**: Private keys never leave the browser
- **Deterministic Recovery**: Burners recoverable from wallet signature
- **Encrypted Storage**: Local state encrypted with derived keys
- **Memory Zeroing**: Sensitive data cleared after use
- **Privacy-Preserving Keys**: Wallet hash derived via SHA-256

---

## 📄 API Reference

### NonceService

```typescript
// Initialize
await nonceService.initFromSignature(signature);

// Load or generate nonce
const nonce = await nonceService.loadCurrentNonce(pubkey);
if (!nonce) {
    await nonceService.generateBaseNonce(pubkey);
}

// Consume (after burner used)
const result = await nonceService.consumeNonce();
// result.newBlobData → upload to backend
```

### BurnerService

```typescript
// Initialize
await burnerService.initFromSignature(signature);

// Derive burner from nonce
const burner = await burnerService.deriveBurnerFromNonce(nonce);
console.log(burner.address); // Burner Solana address

// Clear when done
burnerService.clearBurner(burner);
```

---

## 🚀 Roadmap

### Core Library
- [x] NonceService with encrypted storage
- [x] BurnerService for keypair derivation
- [x] StorageService (encrypted IndexedDB)
- [x] Local/Remote state sync logic
- [x] Privacy-preserving wallet hash

### Testing
- [x] NonceService tests (41 passing)
- [x] BurnerService tests (25+ passing)
- [x] Integration flow tests (complete 5-phase flow)
- [ ] StorageService tests

### Backend
- [x] Project setup (Rust/Axum)
- [x] Blob API endpoints (CRUD)
- [ ] WebSocket for real-time notifications
- [ ] Helius webhook integration
- [ ] Database (PostgreSQL)

### Frontend
- [x] Vite + React setup
- [x] Wallet adapter integration
- [ ] User init flow UI
- [ ] Burner generation UI
- [ ] Deposit tracking UI
- [ ] Shred/sweep UI

### Privacy Integration
- [x] ShadowWire SDK integration
- [x] Deposit to pool flow
- [x] Private transfer implementation
- [ ] Fee collection

### Production
- [ ] Error handling & recovery
- [ ] Mobile responsive
- [ ] Deployment
- [ ] Documentation

---

## 📜 License

MIT
