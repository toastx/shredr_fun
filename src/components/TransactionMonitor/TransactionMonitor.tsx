import { useState, useEffect } from 'react';
import { webSocketClient } from '../../lib';
import type { WebSocketMessage, WebSocketTransactionMessage } from '../../lib';
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
    const [lastActivity, setLastActivity] = useState<Date | null>(null);

    useEffect(() => {
        // Handle connection state changes
        const handleConnectionChange = (connected: boolean) => {
            setIsConnected(connected);
        };

        // Handle incoming messages
        const handleMessage = (message: WebSocketMessage) => {
            if (message.type === 'transaction') {
                const txMessage = message as WebSocketTransactionMessage;
                // TODO: Parse transaction data to extract relevant info for burner address
                // For now, just log and update activity
                console.log('Transaction received:', txMessage.data);
                setLastActivity(new Date());

                // Placeholder: Add transaction to list (would need proper parsing)
                // This is a simplified example - in reality, you'd check if the transaction
                // involves the burnerAddress and extract amount/type
                const mockTx: TransactionInfo = {
                    signature: txMessage.data.signature || 'unknown',
                    amount: Math.random() * 10, // Mock amount
                    type: Math.random() > 0.5 ? 'received' : 'sent',
                    timestamp: txMessage.timestamp
                };
                setTransactions(prev => [mockTx, ...prev.slice(0, 9)]); // Keep last 10
            }
        };

        // Subscribe to events
        webSocketClient.onConnectionChange(handleConnectionChange);
        webSocketClient.onMessage(handleMessage);

        // Cleanup
        return () => {
            webSocketClient.offConnectionChange(handleConnectionChange);
            webSocketClient.offMessage(handleMessage);
        };
    }, [burnerAddress]);

    return (
        <div className="transaction-monitor">
            <div className="monitor-header">
                <span className={`monitor-icon ${isConnected ? 'connected' : 'disconnected'}`}></span>
                <span className="monitor-title">
                    {isConnected ? 'monitoring transactions...' : 'connecting...'}
                </span>
            </div>
            <div className="monitor-address">
                watching: {burnerAddress.slice(0, 8)}...{burnerAddress.slice(-8)}
            </div>

            {transactions.length > 0 && (
                <div className="transaction-list">
                    <div className="transaction-header">Recent Activity</div>
                    {transactions.slice(0, 3).map((tx, index) => (
                        <div key={index} className="transaction-item">
                            <span className={`transaction-type ${tx.type}`}>
                                {tx.type === 'received' ? '↓' : '↑'}
                            </span>
                            <span className="transaction-amount">
                                {tx.amount?.toFixed(4)} SOL
                            </span>
                            <span className="transaction-sig">
                                {tx.signature.slice(0, 8)}...
                            </span>
                        </div>
                    ))}
                </div>
            )}

            {lastActivity && (
                <div className="last-activity">
                    Last activity: {lastActivity.toLocaleTimeString()}
                </div>
            )}
        </div>
    );
}

export { TransactionMonitor };
