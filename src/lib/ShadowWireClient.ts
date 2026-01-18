import { ShadowWireClient as ShadowWireSDK, TokenUtils } from '@radr/shadowwire';
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import nacl from 'tweetnacl';

/**
 * ShadowWire wrapper class for Shredr
 * Handles deposits, transfers, withdrawals, and balance checks
 */
export class ShadowWireClient {
    private sdk: ShadowWireSDK;
    private connection: Connection;
    private keypair: Keypair | null = null;

    constructor(rpcUrl: string = '') {
        this.sdk = new ShadowWireSDK({ debug: true });
        this.connection = new Connection(rpcUrl || 'https://api.mainnet-beta.solana.com');
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
        if (!this.keypair) throw new Error('Keypair not set');
        return this.keypair.publicKey.toBase58();
    }

    /**
     * Deposit SOL into ShadowWire pool
     */
    async deposit(amountInSol: number): Promise<string> {
        if (!this.keypair) throw new Error('Keypair not set');

        const depositTx = await this.sdk.deposit({
            wallet: this.keypair.publicKey.toBase58(),
            amount: TokenUtils.toSmallestUnit(amountInSol, 'SOL'),
        });

        console.log('Deposit transaction created');
        console.log('Pool address:', depositTx.pool_address);
        console.log('User balance PDA:', depositTx.user_balance_pda);
        console.log('Amount:', depositTx.amount);

        // Deserialize and sign the transaction
        const txBuffer = Buffer.from(depositTx.unsigned_tx_base64, 'base64');
        const tx = VersionedTransaction.deserialize(txBuffer);
        
        const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();
        tx.message.recentBlockhash = blockhash;
        tx.sign([this.keypair]);

        // Send and confirm
        const signature = await this.connection.sendRawTransaction(tx.serialize());
        console.log('Transaction sent:', signature);
        
        await this.connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight });
        console.log('Deposit confirmed!');

        return signature;
    }

    /**
     * Internal transfer (amount hidden) to another ShadowWire user
     */
    async transferInternal(recipientAddress: string, amountInSol: number): Promise<string> {
        if (!this.keypair) throw new Error('Keypair not set');

        // Create signMessage function using tweetnacl
        const signMessage = async (message: Uint8Array): Promise<Uint8Array> => {
            console.log('signMessage called');
            const signature = nacl.sign.detached(message, this.keypair!.secretKey);
            return signature;
        };

        const transferTx = await this.sdk.transfer({
            sender: this.keypair.publicKey.toBase58(),
            recipient: recipientAddress,
            amount: amountInSol,
            token: 'SOL',
            type: 'internal',
            wallet: { signMessage }
        });

        console.log('Internal transfer completed');
        console.log('Transaction signature:', transferTx.tx_signature);
        console.log('Amount hidden:', transferTx.amount_hidden);

        return transferTx.tx_signature;
    }

    /**
     * External transfer (sender anonymous, amount visible) to any Solana wallet
     */
    async transferExternal(recipientAddress: string, amountInSol: number): Promise<string> {
        if (!this.keypair) throw new Error('Keypair not set');

        const signMessage = async (message: Uint8Array): Promise<Uint8Array> => {
            console.log('signMessage called');
            const signature = nacl.sign.detached(message, this.keypair!.secretKey);
            return signature;
        };

        const transferTx = await this.sdk.transfer({
            sender: this.keypair.publicKey.toBase58(),
            recipient: recipientAddress,
            amount: amountInSol,
            token: 'SOL',
            type: 'external',
            wallet: { signMessage }
        });

        console.log('External transfer completed');
        console.log('Transaction signature:', transferTx.tx_signature);

        return transferTx.tx_signature;
    }

    /**
     * Withdraw SOL from ShadowWire pool back to wallet
     */
    async withdraw(amountInSol: number): Promise<string> {
        if (!this.keypair) throw new Error('Keypair not set');

        const withdrawTx = await this.sdk.withdraw({
            wallet: this.keypair.publicKey.toBase58(),
            amount: TokenUtils.toSmallestUnit(amountInSol, 'SOL'),
        });

        console.log('Withdraw transaction created');

        // Deserialize and sign the transaction
        const txBuffer = Buffer.from(withdrawTx.unsigned_tx_base64, 'base64');
        const tx = VersionedTransaction.deserialize(txBuffer);

        const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();
        tx.message.recentBlockhash = blockhash;
        tx.sign([this.keypair]);

        // Send and confirm
        const signature = await this.connection.sendRawTransaction(tx.serialize());
        console.log('Withdraw transaction sent:', signature);

        await this.connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight });
        console.log('Withdraw confirmed!');

        return signature;
    }

    /**
     * Get the full balance in ShadowWire pool
     */
    async getBalance(): Promise<{ available: number; availableLamports: number; poolAddress: string }> {
        if (!this.keypair) throw new Error('Keypair not set');

        const balance = await this.sdk.getBalance(this.keypair.publicKey.toBase58(), 'SOL');

        return {
            available: TokenUtils.fromSmallestUnit(balance.available, 'SOL'),
            availableLamports: balance.available,
            poolAddress: balance.pool_address
        };
    }

    /**
     * Get balance for a specific wallet address
     */
    async getBalanceForAddress(walletAddress: string): Promise<{ available: number; availableLamports: number; poolAddress: string }> {
        const balance = await this.sdk.getBalance(walletAddress, 'SOL');

        return {
            available: TokenUtils.fromSmallestUnit(balance.available, 'SOL'),
            availableLamports: balance.available,
            poolAddress: balance.pool_address
        };
    }

    /**
     * Withdraw full balance from ShadowWire pool
     */
    async withdrawAll(): Promise<string> {
        const balance = await this.getBalance();
        
        if (balance.available <= 0) {
            throw new Error('No balance to withdraw');
        }

        return this.withdraw(balance.available);
    }
}

export { TokenUtils };
