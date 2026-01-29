import { useState, useEffect, useCallback } from 'react';
import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { webSocketClient } from '../../lib';
import { HELIUS_RPC_URL } from '../../lib/constants';
import type { WebSocketMessage } from '../../lib';
import './TransactionMonitor.css';

interface TransactionMonitorProps {
    burnerAddress: string;
}

interface TransactionInfo {
    signature: string;
    amount?: number;
    type: 'received' | 'sent';
    timestamp: string;
}

function TransactionMonitor({ burnerAddress }: TransactionMonitorProps) {
    const [isConnected, setIsConnected] = useState(false);
    const [transactions, setTransactions] = useState<TransactionInfo[]>([]);
    const [isLoading, setIsLoading] = useState(true);

    /**
     * Fetch transaction history for the burner address
     */
    const fetchTransactionHistory = useCallback(async () => {
        if (!burnerAddress) return;
        
        setIsLoading(true);
        try {
            const connection = new Connection(HELIUS_RPC_URL);
            const pubkey = new PublicKey(burnerAddress);

            // Get recent signatures
            const signatures = await connection.getSignaturesForAddress(pubkey, {
                limit: 10,
            });

            const txs: TransactionInfo[] = [];

            for (let i = 0; i < signatures.length; i++) {
                const sigInfo = signatures[i];
                if (sigInfo.err) continue;

                const tx = await connection.getTransaction(sigInfo.signature, {
                    commitment: "confirmed",
                    maxSupportedTransactionVersion: 0,
                });

                if (tx && tx.meta) {
                    const preBalances = tx.meta.preBalances || [];
                    const postBalances = tx.meta.postBalances || [];
                    const accountKeys =
                        tx.transaction.message.getAccountKeys().staticAccountKeys;

                    const burnerIndex = accountKeys.findIndex((key: PublicKey) =>
                        key.equals(pubkey),
                    );
                    if (burnerIndex !== -1) {
                        const preBalance = preBalances[burnerIndex] || 0;
                        const postBalance = postBalances[burnerIndex] || 0;
                        const diff = postBalance - preBalance;
                        const amountSol = Math.abs(diff) / LAMPORTS_PER_SOL;

                        txs.push({
                            signature: sigInfo.signature,
                            timestamp: sigInfo.blockTime
                                ? new Date(sigInfo.blockTime * 1000).toISOString()
                                : new Date().toISOString(),
                            type: diff >= 0 ? 'received' : 'sent',
                            amount: amountSol,
                        });
                    }
                }
            }
            setTransactions(txs);
        } catch (err) {
            console.error("Failed to fetch transaction history:", err);
        } finally {
            setIsLoading(false);
        }
    }, [burnerAddress]);

    // Fetch history on mount and when address changes
    useEffect(() => {
        fetchTransactionHistory();
    }, [fetchTransactionHistory]);

    // Listen for WebSocket connection changes
    useEffect(() => {
        const handleConnectionChange = (connected: boolean) => {
            setIsConnected(connected);
        };
        webSocketClient.onConnectionChange(handleConnectionChange);
        setIsConnected(webSocketClient.isConnected());
        
        return () => webSocketClient.offConnectionChange(handleConnectionChange);
    }, []);

    // Listen for account updates and refresh history
    useEffect(() => {
        if (!burnerAddress) return;

        const handleMessage = async (data: WebSocketMessage) => {
            if (data.type === 'accountUpdate') {
                // Wait for transaction to finalize, then refresh
                await new Promise(resolve => setTimeout(resolve, 2000));
                fetchTransactionHistory();
            }
        };

        webSocketClient.onMessage(handleMessage);
        return () => webSocketClient.offMessage(handleMessage);
    }, [burnerAddress, fetchTransactionHistory]);

    const getTxLink = (sig: string) => `https://orbmarkets.io/tx/${sig}`;

    return (
        <div className="transaction-monitor">
            <div className="monitor-header">
                <span className={`monitor-icon ${isConnected ? 'connected' : 'disconnected'}`}></span>
                <span className="monitor-title">
                    {isConnected ? 'monitoring...' : 'connecting...'}
                </span>
            </div>

            {isLoading && transactions.length === 0 && (
                <div className="no-transactions">loading transactions...</div>
            )}

            {transactions.length > 0 && (
                <div className="transaction-list">
                    {transactions.map((tx, index) => (
                        <div key={index} className={`tx-row ${tx.type}`}>
                            <span className="tx-text">
                                {tx.type === 'received' ? 'YOU received' : 'YOU sent'}{' '}
                                <strong>{tx.amount?.toFixed(4)} SOL</strong>
                            </span>
                            <a 
                                href={getTxLink(tx.signature)} 
                                target="_blank" 
                                rel="noopener noreferrer"
                                className="tx-link"
                            >
                                ↗
                            </a>
                        </div>
                    ))}
                </div>
            )}

            {!isLoading && transactions.length === 0 && (
                <div className="no-transactions">no transactions yet</div>
            )}
        </div>
    );
}

export { TransactionMonitor };
