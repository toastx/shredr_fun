import { useState, useCallback, useEffect } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { shredrClient } from '../../lib';
import './ClaimPage.css';

interface ClaimPageProps {
    onBack?: () => void;
}

function ClaimPage({ onBack }: ClaimPageProps) {
    const { connected } = useWallet();
    
    // State
    const [totalBalance, setTotalBalance] = useState<number>(0);
    const [destinationAddress, setDestinationAddress] = useState('');
    const [isWithdrawing, setIsWithdrawing] = useState(false);
    const [withdrawError, setWithdrawError] = useState<string | null>(null);
    const [withdrawSuccess, setWithdrawSuccess] = useState<string | null>(null);

    // ============ EFFECTS ============

    useEffect(() => {
        // TODO: Fetch actual pool balance from ShadowWire
        // For now, using placeholder
        if (connected && shredrClient.initialized) {
            // Simulate fetching balance
            setTotalBalance(0);
        }
    }, [connected]);

    // ============ ACTIONS ============

    const handleWithdraw = useCallback(async () => {
        if (!destinationAddress) {
            setWithdrawError('Please enter a destination address');
            return;
        }

        if (totalBalance <= 0) {
            setWithdrawError('No balance to withdraw');
            return;
        }

        try {
            setIsWithdrawing(true);
            setWithdrawError(null);
            setWithdrawSuccess(null);

            // TODO: Implement actual withdrawal via ShadowWire
            // await shadowWireClient.withdraw(destinationAddress, totalBalance);

            // Simulate withdrawal
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            setWithdrawSuccess(`Successfully initiated private transfer of ${formatBalance(totalBalance)} SOL`);
            setTotalBalance(0);
            setDestinationAddress('');

        } catch (err) {
            console.error('Withdrawal failed:', err);
            setWithdrawError(err instanceof Error ? err.message : 'Withdrawal failed');
        } finally {
            setIsWithdrawing(false);
        }
    }, [destinationAddress, totalBalance]);

    // ============ HELPERS ============

    const formatBalance = (lamports: number) => {
        return (lamports / 1_000_000_000).toFixed(4);
    };

    // ============ RENDER ============

    if (!connected || !shredrClient.initialized) {
        return (
            <div className="claim-page">
                <div className="claim-card">
                    <div className="claim-header">
                        <h1 className="claim-title">claim sol</h1>
                    </div>
                    <div className="claim-message">
                        Please connect wallet and unlock to view your balance
                    </div>
                    {onBack && (
                        <button className="back-btn" onClick={onBack}>
                            ← back to generator
                        </button>
                    )}
                </div>
            </div>
        );
    }

    return (
        <div className="claim-page">
            <div className="claim-card">
                <div className="claim-header">
                    <h1 className="claim-title">claim sol</h1>
                    {onBack && (
                        <button className="back-link" onClick={onBack}>
                            ← back
                        </button>
                    )}
                </div>

                {/* Balance Display */}
                <div className="balance-section">
                    <span className="balance-label">total balance</span>
                    <span className="balance-amount">{formatBalance(totalBalance)} SOL</span>
                </div>

                {/* Destination Input */}
                <div className="destination-section">
                    <label className="destination-label">destination address</label>
                    <input
                        type="text"
                        className="destination-input"
                        placeholder="Enter Solana address..."
                        value={destinationAddress}
                        onChange={(e) => setDestinationAddress(e.target.value)}
                        disabled={isWithdrawing}
                    />
                </div>

                {/* Error Message */}
                {withdrawError && (
                    <div className="claim-error">{withdrawError}</div>
                )}

                {/* Success Message */}
                {withdrawSuccess && (
                    <div className="claim-success">{withdrawSuccess}</div>
                )}

                {/* Withdraw Button */}
                <button 
                    className="withdraw-btn"
                    onClick={handleWithdraw}
                    disabled={isWithdrawing || totalBalance <= 0}
                >
                    {isWithdrawing ? 'processing...' : 'withdraw'}
                </button>

                {/* Info Note */}
                <div className="claim-note">
                    Funds will be transferred privately via ShadowWire pool
                </div>
            </div>
        </div>
    );
}

export { ClaimPage };
