import './TransactionMonitor.css';

interface TransactionMonitorProps {
    burnerAddress: string;
}

function TransactionMonitor({ burnerAddress }: TransactionMonitorProps) {
    // TODO: Implement actual transaction monitoring via WebSocket or polling
    // For now, show a visual waiting state

    return (
        <div className="transaction-monitor">
            <div className="monitor-header">
                <span className="monitor-icon pulse"></span>
                <span className="monitor-title">looking for transactions...</span>
            </div>
            <div className="monitor-address">
                watching: {burnerAddress.slice(0, 8)}...{burnerAddress.slice(-8)}
            </div>
        </div>
    );
}

export { TransactionMonitor };
