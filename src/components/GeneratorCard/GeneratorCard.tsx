import { useState, useCallback, useEffect } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { Connection, PublicKey } from '@solana/web3.js';
import { shredrClient, webSocketClient } from '../../lib';
import { MASTER_MESSAGE, HELIUS_RPC_URL } from '../../lib/constants';
import type { WebSocketMessage, WebSocketAccountUpdateMessage } from '../../lib/types';
import AddressDisplay from '../AddressDisplay';
import { TransactionMonitor } from '../TransactionMonitor';
import './GeneratorCard.css';

// ============ STATE TYPES ============

type CardState = 
    | 'disconnected'    // Wallet not connected
    | 'connected'       // Wallet connected, not signed
    | 'signing'         // Signing in progress
    | 'initializing'    // Services initializing
    | 'ready'           // Burner ready to use
    | 'monitoring'      // Monitoring for transactions
    | 'error';          // Error state

// ============ COMPONENT ============

function GeneratorCard() {
    const { publicKey, signMessage, connected } = useWallet();
    const { setVisible } = useWalletModal();
    
    // State
    const [cardState, setCardState] = useState<CardState>('disconnected');
    const [burnerAddress, setBurnerAddress] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [isMonitoring, setIsMonitoring] = useState(false);
    const [burnerBalance, setBurnerBalance] = useState<number>(0); // in SOL
    const [externalTransactions, setExternalTransactions] = useState<any[]>([]);

    // ============ HELPER FUNCTIONS ============

    /**
     * Fetch the current balance for the burner address
     */
    const fetchInitialBalance = useCallback(async (address: string) => {
        try {
            const connection = new Connection(HELIUS_RPC_URL);
            const publicKey = new PublicKey(address);
            const accountInfo = await connection.getAccountInfo(publicKey);
            if (accountInfo) {
                const balanceSol = accountInfo.lamports / 1e9;
                setBurnerBalance(balanceSol);
                console.log(`Initial balance: ${balanceSol} SOL`);
            } else {
                setBurnerBalance(0);
            }
        } catch (err) {
            console.error('Failed to fetch initial balance:', err);
            setBurnerBalance(0);
        }
    }, []);

    /**
     * Fetch the last significant transaction for the burner address
     */
    const fetchLastSignificantTransaction = useCallback(async (address: string) => {
        try {
            const connection = new Connection(HELIUS_RPC_URL);
            const publicKey = new PublicKey(address);

            // Get recent signatures
            const signatures = await connection.getSignaturesForAddress(publicKey, { limit: 10 });

            for (const sigInfo of signatures) {
                const tx = await connection.getTransaction(sigInfo.signature, {
                    commitment: 'confirmed',
                    maxSupportedTransactionVersion: 0
                });

                if (tx && tx.meta) {
                    // Check if it's a SOL transfer with significant amount
                    const preBalances = tx.meta.preBalances || [];
                    const postBalances = tx.meta.postBalances || [];
                    const accountKeys = tx.transaction.message.getAccountKeys().staticAccountKeys;

                    // Find the burner account index
                    const burnerIndex = accountKeys.findIndex((key: PublicKey) => key.equals(publicKey));
                    if (burnerIndex !== -1) {
                        const preBalance = preBalances[burnerIndex] || 0;
                        const postBalance = postBalances[burnerIndex] || 0;
                        const diff = postBalance - preBalance;

                        // If received SOL and amount > 0.01 SOL (10^7 lamports)
                        if (diff > 10000000) { // 0.01 SOL
                            const amountSol = diff / 1e9;
                            const txInfo = {
                                signature: sigInfo.signature,
                                amount: amountSol,
                                type: 'received' as const,
                                timestamp: sigInfo.blockTime ? new Date(sigInfo.blockTime * 1000).toISOString() : new Date().toISOString()
                            };
                            setExternalTransactions(prev => [txInfo, ...prev.slice(0, 9)]);
                            break; // Only take the first (most recent) significant one
                        }
                    }
                }
            }
        } catch (err) {
            console.error('Failed to fetch last transaction:', err);
        }
    }, []);

    // ============ EFFECTS ============

    // Handle wallet connection changes
    useEffect(() => {
        if (!connected) {
            setCardState('disconnected');
            setBurnerAddress(null);
            setCopied(false);
            setIsMonitoring(false);
            setError(null);
            shredrClient.destroy();
            webSocketClient.disconnect();
        } else if (connected && cardState === 'disconnected') {
            setCardState('connected');
        }
    }, [connected, cardState]);

    // ============ ACTIONS ============

    /**
     * Open wallet modal
     */
    const handleConnect = useCallback(() => {
        setVisible(true);
    }, [setVisible]);

    /**
     * Sign SHREDR message and initialize services
     */
    const handleSign = useCallback(async () => {
        if (!publicKey || !signMessage) {
            setError('Wallet not connected or signMessage not available');
            return;
        }

        try {
            setCardState('signing');
            setError(null);

            // 1. Sign the SHREDR message
            const message = `${MASTER_MESSAGE}:${publicKey.toBase58()}`;
            const messageBytes = new TextEncoder().encode(message);
            const signature = await signMessage(messageBytes);

            setCardState('initializing');

            // 2. Initialize ShredrClient
            const walletPubkeyBytes = publicKey.toBytes();
            await shredrClient.initFromSignature(
                signature,
                walletPubkeyBytes
                // TODO: Pass fetchBlobsFn and createBlobFn for backend sync
            );

            // 3. Get burner address
            const address = shredrClient.currentBurnerAddress;
            if (address) {
                setBurnerAddress(address);
                setCardState('ready');

                // 4. Connect WebSocket for transaction monitoring
                webSocketClient.connect();

                // 5. Subscribe to burner address once connected
                if (webSocketClient.isConnected()) {
                    webSocketClient.subscribeToAccount(address);
                    fetchInitialBalance(address);
                    fetchLastSignificantTransaction(address);
                } else {
                    const handleConnect = (connected: boolean) => {
                        if (connected) {
                            webSocketClient.subscribeToAccount(address);
                            fetchInitialBalance(address);
                            fetchLastSignificantTransaction(address);
                            webSocketClient.offConnectionChange(handleConnect);
                        }
                    };
                    webSocketClient.onConnectionChange(handleConnect);
                }

                // 6. Add message handler
                webSocketClient.onMessage((data: WebSocketMessage) => {
                    console.log('WebSocket message received:', data);

                    if (data.type === 'accountUpdate') {
                        // Update balance
                        const balanceSol = data.lamports / 1e9;
                        setBurnerBalance(balanceSol);
                        console.log(`Updated balance: ${balanceSol} SOL`);

                        // Fetch last significant transaction
                        if (address) {
                            fetchLastSignificantTransaction(address);
                        }
                    }
                });
              
            } else {
                throw new Error('Failed to derive burner address');
            }

        } catch (err) {
            console.error('Failed to initialize:', err);
            if (err instanceof Error && err.message.includes('User rejected')) {
                // User cancelled signing
                setCardState('connected');
            } else {
                setError(err instanceof Error ? err.message : 'Failed to initialize');
                setCardState('error');
            }
        }
    }, [publicKey, signMessage]);

    /**
     * Copy burner address and start monitoring
     */
    const handleCopy = useCallback(async () => {
        if (!burnerAddress) return;

        try {
            await navigator.clipboard.writeText(burnerAddress);
            setCopied(true);
            setIsMonitoring(true);
            setCardState('monitoring');

            // Reset copied state after 2 seconds
            setTimeout(() => setCopied(false), 2000);
        } catch (err) {
            console.error('Failed to copy:', err);
        }
    }, [burnerAddress]);

    /**
     * Retry after error
     */
    const handleRetry = useCallback(() => {
        setError(null);
        setCardState('connected');
    }, []);

    // ============ RENDER HELPERS ============

    const renderContent = () => {
        switch (cardState) {
            case 'disconnected':
                return (
                    <button className="generate-btn" onClick={handleConnect}>
                        connect wallet
                    </button>
                );

            case 'connected':
                return (
                    <button className="generate-btn" onClick={handleSign}>
                        sign to unlock
                    </button>
                );

            case 'signing':
                return (
                    <button className="generate-btn" disabled>
                        <span className="loading-dots">signing</span>
                    </button>
                );

            case 'initializing':
                return (
                    <button className="generate-btn" disabled>
                        <span className="loading-dots">initializing</span>
                    </button>
                );

            case 'ready':
            case 'monitoring':
                return (
                    <div className="results-section">
                        <AddressDisplay
                            label="burner address"
                            value={burnerAddress || ''}
                            placeholder=""
                            isCopied={copied}
                            hasValue={!!burnerAddress}
                            onCopy={handleCopy}
                        />

                        <div className="balance-display">
                            <span className="balance-label">burner balance</span>
                            <span className="balance-amount">{burnerBalance.toFixed(4)} SOL</span>
                        </div>

                        {isMonitoring && (
                            <TransactionMonitor
                                burnerAddress={burnerAddress || ''}
                                externalTransactions={externalTransactions}
                            />
                        )}
                    </div>
                );

            case 'error':
                return (
                    <div className="error-section">
                        <div className="error-message">{error}</div>
                        <button className="generate-btn secondary" onClick={handleRetry}>
                            retry
                        </button>
                    </div>
                );

            default:
                return null;
        }
    };

    // ============ RENDER ============

    return (
        <div className="generator-card">
            {renderContent()}
        </div>
    );
}

export default GeneratorCard;
