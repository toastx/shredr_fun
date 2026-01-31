import {
  ShadowWireClient as ShadowWireSDK,
  TokenUtils,
  initWASM,
  generateRangeProof,
  isWASMSupported,
} from "@radr/shadowwire";
import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";
import nacl from "tweetnacl";
import { HELIUS_RPC_URL } from "./constants";

// Type for transfer response from SDK (avoids fragile type casting)
interface TransferResponse {
  success: boolean;
  tx_signature: string;
  amount_hidden?: boolean;
  error?: string;
}

// Type for transaction confirmation errors (Solana-specific)
interface TransactionError extends Error {
  logs?: string[];
}

/**
 * ShadowWire wrapper class for Shredr
 * Handles deposits, transfers, withdrawals, and balance checks
 */
export class ShadowWireClient {
  private sdk: ShadowWireSDK;
  private connection: Connection;
  private keypair: Keypair | null = null;

  constructor(rpcUrl?: string) {
    this.sdk = new ShadowWireSDK({ debug: true });
    this.connection = new Connection(rpcUrl || HELIUS_RPC_URL);
  }

  /**
   * Set the keypair for signing transactions
   */
  setKeypair(keypair: Keypair): void {
    this.keypair = keypair;
  }

  /**
   * Get the current wallet public key
   */
  getPublicKey(): string {
    if (!this.keypair) throw new Error("Keypair not set");
    return this.keypair.publicKey.toBase58();
  }

  /**
   * Deposit SOL into ShadowWire pool
   */
  async deposit(
    amountInSol: number,
  ): Promise<{ signature: string; userBalancePda: string }> {
    if (!this.keypair) throw new Error("Keypair not set");

    const depositTx = await this.sdk.deposit({
      wallet: this.keypair.publicKey.toBase58(),
      amount: TokenUtils.toSmallestUnit(amountInSol, "SOL"),
    });

    console.log("Deposit transaction created");
    console.log("Pool address:", depositTx.pool_address);
    console.log("User balance PDA:", depositTx.user_balance_pda);
    console.log("Amount:", depositTx.amount);

    // Deserialize and sign the transaction
    const txBuffer = Buffer.from(depositTx.unsigned_tx_base64, "base64");
    const tx = VersionedTransaction.deserialize(txBuffer);

    const { blockhash, lastValidBlockHeight } =
      await this.connection.getLatestBlockhash();
    tx.message.recentBlockhash = blockhash;
    tx.sign([this.keypair]);

    // Send and confirm
    const signature = await this.connection.sendRawTransaction(tx.serialize());
    console.log("Transaction sent:", signature);

    try {
      await this.connection.confirmTransaction({
        signature,
        blockhash,
        lastValidBlockHeight,
      });
      console.log("Deposit confirmed!");
    } catch (e: unknown) {
      // SECURITY: Only log transaction logs, not full error object which may contain sensitive data
      const txError = e as TransactionError;
      if (txError.logs) {
        console.error("Transaction failed. Program logs available.");
      }
      throw e;
    }

    return {
      signature,
      userBalancePda: depositTx.user_balance_pda,
    };
  }

  /**
   * Internal transfer (amount hidden) to another ShadowWire user
   */
  async transferInternal(
    recipientAddress: string,
    amountInSol: number,
  ): Promise<string> {
    await this.ensureWASM();
    const amountInLamports = TokenUtils.toSmallestUnit(amountInSol, "SOL");
    const proof = await generateRangeProof(amountInLamports, 64);
    console.log(`Proof generated for ${amountInLamports} lamports`);
    if (!this.keypair) throw new Error("Keypair not set");

    // Create signMessage function using tweetnacl
    // SECURITY: This closure captures keypair reference - ensure keypair is cleared after use
    const keypairRef = this.keypair;
    const signMessage = async (message: Uint8Array): Promise<Uint8Array> => {
      console.log("signMessage called");
      const signature = nacl.sign.detached(message, keypairRef.secretKey);
      return signature;
    };

    const transferTx = await this.sdk.transferWithClientProofs({
      sender: this.keypair.publicKey.toBase58(),
      recipient: recipientAddress,
      amount: amountInSol, // SDK expects SOL, not lamports
      token: "SOL",
      type: "internal",
      customProof: proof,
      wallet: { signMessage },
    });

    const txResult = transferTx as TransferResponse;
    if (!txResult.success) {
      const errorMsg = txResult.error || "Transfer transaction failed";
      console.error("Internal transfer failed:", errorMsg);
      throw new Error(errorMsg);
    }

    console.log("Internal transfer completed");
    console.log("Transaction signature:", transferTx.tx_signature);
    console.log("Amount hidden:", transferTx.amount_hidden);

    return transferTx.tx_signature;
  }

  /**
   * External transfer (sender anonymous, amount visible) to any Solana wallet
   */
  async transferExternal(
    recipientAddress: string,
    amountInSol: number,
  ): Promise<string> {
    await this.ensureWASM();
    const amountInLamports = TokenUtils.toSmallestUnit(amountInSol, "SOL");
    const proof = await generateRangeProof(amountInLamports, 64);
    console.log(`Proof generated for ${amountInLamports} lamports`);
    if (!this.keypair) throw new Error("Keypair not set");

    // SECURITY: This closure captures keypair reference - ensure keypair is cleared after use
    const keypairRef = this.keypair;
    const signMessage = async (message: Uint8Array): Promise<Uint8Array> => {
      console.log("signMessage called");
      const signature = nacl.sign.detached(message, keypairRef.secretKey);
      return signature;
    };

    const transferTx = await this.sdk.transferWithClientProofs({
      sender: this.keypair.publicKey.toBase58(),
      recipient: recipientAddress,
      amount: amountInSol, // SDK expects SOL, not lamports
      token: "SOL",
      type: "external",
      customProof: proof,
      wallet: { signMessage },
    });

    const txResult = transferTx as TransferResponse;
    if (!txResult.success) {
      const errorMsg = txResult.error || "Transfer transaction failed";
      console.error("External transfer failed:", errorMsg);
      throw new Error(errorMsg);
    }

    console.log("External transfer completed");
    console.log("Transaction signature:", transferTx.tx_signature);

    return transferTx.tx_signature;
  }

  /**
   * Withdraw SOL from ShadowWire pool back to wallet
   */
  async withdraw(amountInSol: number): Promise<string> {
    if (!this.keypair) throw new Error("Keypair not set");

    const withdrawTx = await this.sdk.withdraw({
      wallet: this.keypair.publicKey.toBase58(),
      amount: TokenUtils.toSmallestUnit(amountInSol, "SOL"),
    });

    console.log("Withdraw transaction created");

    // Validate SDK response
    if (!withdrawTx.unsigned_tx_base64) {
      throw new Error("Withdraw transaction missing unsigned_tx_base64");
    }

    // Deserialize and sign the transaction
    const txBuffer = Buffer.from(withdrawTx.unsigned_tx_base64, "base64");
    const tx = VersionedTransaction.deserialize(txBuffer);

    const { blockhash, lastValidBlockHeight } =
      await this.connection.getLatestBlockhash();
    tx.message.recentBlockhash = blockhash;
    tx.sign([this.keypair]);

    // Send and confirm
    const signature = await this.connection.sendRawTransaction(tx.serialize());
    console.log("Withdraw transaction sent:", signature);

    try {
      await this.connection.confirmTransaction({
        signature,
        blockhash,
        lastValidBlockHeight,
      });
      console.log("Withdraw confirmed!");
    } catch (e: unknown) {
      // SECURITY: Only log transaction logs, not full error object which may contain sensitive data
      const txError = e as TransactionError;
      if (txError.logs) {
        console.error("Withdraw failed. Program logs available.");
      }
      throw e;
    }

    return signature;
  }

  /**
   * Get the full balance in ShadowWire pool
   */
  async getBalance(): Promise<{
    available: number;
    availableLamports: number;
    poolAddress: string;
  }> {
    if (!this.keypair) throw new Error("Keypair not set");

    const address = this.keypair.publicKey.toBase58();
    console.log(`ShadowWireClient.getBalance: Querying for address: ${address}`);

    const balance = await this.sdk.getBalance(address, "SOL");
    
    console.log(`ShadowWireClient.getBalance: SDK raw response:`, balance);

    const result = {
      available: TokenUtils.fromSmallestUnit(balance.available, "SOL"),
      availableLamports: balance.available,
      poolAddress: balance.pool_address,
    };
    
    console.log(`ShadowWireClient.getBalance: Converted result:`, result);

    return result;
  }

  /**
   * Get balance for a specific wallet address
   */
  async getBalanceForAddress(
    walletAddress: string,
  ): Promise<{
    available: number;
    availableLamports: number;
    poolAddress: string;
  }> {
    console.log(`ShadowWireClient.getBalanceForAddress: Querying for address: ${walletAddress}`);
    
    const balance = await this.sdk.getBalance(walletAddress, "SOL");
    
    console.log(`ShadowWireClient.getBalanceForAddress: SDK raw response:`, balance);

    const result = {
      available: TokenUtils.fromSmallestUnit(balance.available, "SOL"),
      availableLamports: balance.available,
      poolAddress: balance.pool_address,
    };
    
    console.log(`ShadowWireClient.getBalanceForAddress: Converted result:`, result);

    return result;
  }

  /**
   * Get the native SOL balance of the current wallet
   */
  async getWalletBalance(): Promise<number> {
    if (!this.keypair) throw new Error("Keypair not set");
    const balance = await this.connection.getBalance(this.keypair.publicKey);
    return balance;
  }

  /**
   * Withdraw full balance from ShadowWire pool
   */
  async withdrawAll(): Promise<string> {
    const balance = await this.getBalance();

    if (balance.available <= 0) {
      throw new Error("No balance to withdraw");
    }

    return this.withdraw(balance.available);
  }

  // Memoized WASM initialization state
  private static _wasmInitialized = false;
  private static _wasmInitPromise: Promise<void> | null = null;

  /**
   * Ensure WASM is initialized and supported (memoized for performance)
   */
  private async ensureWASM(): Promise<void> {
    // Fast path: already initialized
    if (ShadowWireClient._wasmInitialized) {
      return;
    }

    // Check support
    if (!isWASMSupported()) {
      throw new Error(
        "WASM is not supported in this environment. Privacy features (range proofs) require WASM.",
      );
    }

    // Use existing promise if initialization is in progress (prevents race conditions)
    if (ShadowWireClient._wasmInitPromise) {
      await ShadowWireClient._wasmInitPromise;
      return;
    }

    // Initialize WASM and memoize
    ShadowWireClient._wasmInitPromise = initWASM("/settler_wasm_bg.wasm").then(() => {
      ShadowWireClient._wasmInitialized = true;
    });

    await ShadowWireClient._wasmInitPromise;
  }
}

export { TokenUtils };
