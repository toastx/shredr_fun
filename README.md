# ✂️ shredr.fun

### **The Solana Address Alternative to TempMail**

**shredr.fun** is a privacy-first utility that allows users to generate disposable, zero-link burner addresses to receive funds. Operating on a **Commitment-Claim architecture**, it ensures that the transaction history of the burner is cryptographically isolated from your main wallet until the moment of the claim—at which point the link is broken through **Multi-Party Computation (MPC)**.

---

## 🔄 User Flow

The "shredding" process occurs through four distinct stages:

1.  **Generation:**
    *   The user clicks **"Generate"** on the frontend.
    *   A **12-word BIP39 mnemonic** is generated locally in the browser (client-side only).

2.  **Commitment:**
    *   The mnemonic is hashed into a **Commitment ($C$)**:
        $$C = \text{Hash}(\text{mnemonic} + \text{nullifier})$$
    *   This commitment is stored on-chain, serving as the cryptographic lock.

3.  **Receive:**
    *   A **burner PDA (Program Derived Address)** is initialized.
    *   The payer sends SOL or SPL tokens to this address. The funds sit in this PDA, publicly visible but cryptographically claimed by the commitment.

4.  **Shred & Claim:**
    *   To withdraw, the user enters the 12-word note.
    *   An **Arcium MPC cluster** verifies the note against the on-chain commitment.
    *   **Critical:** No single node (nor the blockchain) ever sees the plaintext words.
    *   Once verified, the funds are "shredded" (transferred) to the user's main wallet.

---

## 🛠 The Tech Stack

*   **Solana:** The high-speed settlement layer where commitments and PDAs live.
*   **Arcium (MPC):** The **"Encrypted Supercomputer"** that handles the private verification of your 12-word note. It ensures the link between the burner and your main wallet is never exposed.
*   **C-SPL (Confidential SPL):** A Token-2022 extension used to hide the transaction amount. This prevents observers from linking accounts via "amount matching" (e.g., seeing 4.20 SOL leave one wallet and enter another).

---

## 📦 Getting Started

### Prerequisites
* [Solana CLI](https://docs.solana.com/cli/install-solana-cli-tools)
* [Anchor Framework](https://www.anchor-lang.com/)
* [Arcium SDK](https://docs.arcium.com/)

### Installation

```bash
# Clone the repository
git clone https://github.com/your-username/shredr-fun.git

# Install dependencies
cd shredr-fun
npm install

# Deploy Anchor program
anchor deploy
```

