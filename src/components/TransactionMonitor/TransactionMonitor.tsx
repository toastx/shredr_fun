import { useState, useEffect } from 'react';
import { webSocketClient } from '../../lib';
import type { WebSocketMessage } from '../../lib';
import './TransactionMonitor.css';

interface TransactionMonitorProps {
    burnerAddress: string;
    externalTransactions?: TransactionInfo[];
}

interface TransactionInfo {
    signature: string;
    amount?: number;
    type: 'received' | 'sent';
    timestamp: string;
}

function TransactionMonitor({ burnerAddress, externalTransactions = [] }: TransactionMonitorProps) {
    const [isConnected, setIsConnected] = useState(false);
    const [transactions, setTransactions] = useState<TransactionInfo[]>([]);

    useEffect(() => {
        const handleConnectionChange = (connected: boolean) => {
            setIsConnected(connected);
        };
        webSocketClient.onConnectionChange(handleConnectionChange);
        return () => webSocketClient.offConnectionChange(handleConnectionChange);
    }, []);

    // Use external transactions directly
    useEffect(() => {
        if (externalTransactions.length > 0) {
            setTransactions(externalTransactions.slice(0, 10));
        }
    }, [externalTransactions]);

    const getTxLink = (sig: string) => `https://orbmarkets.io/tx/${sig}`;

    return (
        <div className="transaction-monitor">
            <div className="monitor-header">
                <span className={`monitor-icon ${isConnected ? 'connected' : 'disconnected'}`}></span>
                <span className="monitor-title">
                    {isConnected ? 'monitoring...' : 'connecting...'}
                </span>
            </div>

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

            {transactions.length === 0 && (
                <div className="no-transactions">no transactions yet</div>
            )}
        </div>
    );
}

export { TransactionMonitor };
