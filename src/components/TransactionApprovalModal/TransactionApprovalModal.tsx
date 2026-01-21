import type { PendingTransaction } from '../../lib/index.ts';
import './TransactionApprovalModal.css';

interface TransactionApprovalModalProps {
    transaction: PendingTransaction;
    burnerAddress: string;
    onApprove: () => void;
    onReject: () => void;
    isProcessing?: boolean;
}

function TransactionApprovalModal({
    transaction,
    burnerAddress,
    onApprove,
    onReject,
    isProcessing = false
}: TransactionApprovalModalProps) {
    const formatAmount = (lamports: number) => {
        return (lamports / 1_000_000_000).toFixed(4);
    };

    const formatAddress = (address: string) => {
        return `${address.slice(0, 4)}...${address.slice(-4)}`;
    };

    return (
        <div className="modal-overlay">
            <div className="modal-container">
                <div className="modal-header">
                    <span className="modal-icon">🔐</span>
                    <h2 className="modal-title">confirm transaction</h2>
                </div>

                <div className="modal-content">
                    <div className="tx-detail">
                        <span className="tx-label">incoming</span>
                        <span className="tx-value highlight">{formatAmount(transaction.amount)} SOL</span>
                    </div>

                    <div className="tx-detail">
                        <span className="tx-label">from burner</span>
                        <span className="tx-value mono">{formatAddress(burnerAddress)}</span>
                    </div>

                    <div className="tx-detail">
                        <span className="tx-label">to</span>
                        <span className="tx-value">ShadowWire Pool</span>
                    </div>

                    <div className="tx-note">
                        signing with derived burner key
                    </div>
                </div>

                <div className="modal-actions">
                    <button 
                        className="modal-btn cancel" 
                        onClick={onReject}
                        disabled={isProcessing}
                    >
                        cancel
                    </button>
                    <button 
                        className="modal-btn approve" 
                        onClick={onApprove}
                        disabled={isProcessing}
                    >
                        {isProcessing ? 'processing...' : '✓ approve'}
                    </button>
                </div>
            </div>
        </div>
    );
}

export { TransactionApprovalModal };
