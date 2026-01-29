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
import {} from "@radr/shadowwire";

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
    } catch (e: any) {
      if (e.logs) {
        console.error("Transaction failed. Logs:", e.logs);
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
    if (isWASMSupported()) {
      await initWASM("/settler_wasm_bg.wasm");
    } else {
      console.log("WASM not supp");
    }
    const proof = await generateRangeProof(100000000, 64);
    console.log("proof generated");
    if (!this.keypair) throw new Error("Keypair not set");

    // Create signMessage function using tweetnacl
    const signMessage = async (message: Uint8Array): Promise<Uint8Array> => {
      console.log("signMessage called");
      const signature = nacl.sign.detached(message, this.keypair!.secretKey);
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

    if (!transferTx.success) {
      const errorMsg = ((transferTx as unknown) as { error?: string }).error || "Transfer transaction failed";
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
    await initWASM("/settler_wasm_bg.wasm");
    const proof = await generateRangeProof(100000000, 64);
    if (!this.keypair) throw new Error("Keypair not set");

    const signMessage = async (message: Uint8Array): Promise<Uint8Array> => {
      console.log("signMessage called");
      const signature = nacl.sign.detached(message, this.keypair!.secretKey);
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

    if (!transferTx.success) {
      const errorMsg = ((transferTx as unknown) as { error?: string }).error || "Transfer transaction failed";
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
    } catch (e: any) {
      if (e.logs) {
        console.error("Withdraw failed. Logs:", e.logs);
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

    const balance = await this.sdk.getBalance(
      this.keypair.publicKey.toBase58(),
      "SOL",
    );

    return {
      available: TokenUtils.fromSmallestUnit(balance.available, "SOL"),
      availableLamports: balance.available,
      poolAddress: balance.pool_address,
    };
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
    const balance = await this.sdk.getBalance(walletAddress, "SOL");

    return {
      available: TokenUtils.fromSmallestUnit(balance.available, "SOL"),
      availableLamports: balance.available,
      poolAddress: balance.pool_address,
    };
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
}

export { TokenUtils };
