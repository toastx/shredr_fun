
import { useState, useCallback, useEffect } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { SystemProgram, Transaction, PublicKey, LAMPORTS_PER_SOL, Keypair } from '@solana/web3.js';
import { shredrClient } from '../../lib';
import './ClaimPage.css';

interface ClaimPageProps {
    onBack?: () => void;
}

function ClaimPage({ onBack }: ClaimPageProps) {
    const { connected, publicKey, signMessage } = useWallet();
    
    // State
    const [totalBalance, setTotalBalance] = useState<number>(0);
    const [isWithdrawing, setIsWithdrawing] = useState(false);
    const [withdrawError, setWithdrawError] = useState<string | null>(null);
    const [withdrawSuccess, setWithdrawSuccess] = useState<string | null>(null);
    const [isInitialized, setIsInitialized] = useState<boolean>(false);
    const [isUnlocking, setIsUnlocking] = useState<boolean>(false);
    const [isNewUser, setIsNewUser] = useState<boolean>(false);

    // ============ EFFECTS ============

    useEffect(() => {
        // TODO: Fetch actual pool balance from ShadowWire
        // For now, using placeholder
        if (connected && isInitialized && publicKey) {
            // Simulate fetching balance
            setTotalBalance(100_000_000); // Placeholder balance
        } else {
            setTotalBalance(0);
        }
    }, [connected, isInitialized, publicKey]);

    // ============ ACTIONS ============

    const handleUnlock = useCallback(async () => {
        if (!publicKey || !signMessage) return;
        try {
            setIsUnlocking(true);
            setWithdrawError(null);

            const message = `SHREDR_V1:${publicKey.toBase58()}`;
            const encodedMessage = new TextEncoder().encode(message);
            const signature = await signMessage(encodedMessage);

            const isNew = await shredrClient.checkIfNewUser(signature, publicKey.toBytes());
            setIsNewUser(isNew);

            if (!isNew) {
                await shredrClient.initFromSignature(signature, publicKey.toBytes());
                setIsInitialized(true);
            }

        } catch (err) {
            console.error('Unlock failed:', err);
            setWithdrawError('Failed to verify: ' + (err instanceof Error ? err.message : String(err)));
        } finally {
            setIsUnlocking(false);
        }
    }, [publicKey, signMessage]);

    const handleWithdraw = useCallback(async () => {
        if (!publicKey || !shredrClient.currentBurner) {
            setWithdrawError('Wallet not initialized');
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

            // TODO: Build Withdraw Transaction here
            console.log("Withdraw initiated to", publicKey.toBase58());

            await new Promise(resolve => setTimeout(resolve, 1000));
            setWithdrawSuccess("Withdraw initiated");

        } catch (err) {
            console.error('Withdrawal failed:', err);
            setWithdrawError(err instanceof Error ? err.message : 'Withdrawal failed');
        } finally {
            setIsWithdrawing(false);
        }
    }, [publicKey, totalBalance]);

    // ============ HELPERS ============

    const formatBalance = (lamports: number) => {
        return (lamports / LAMPORTS_PER_SOL).toFixed(4);
    };

    // ============ RENDER ============

    if (!connected) {
        return (
            <div className="claim-page">
                <div className="claim-card">
                    <div className="claim-header claim-header--centered">
                        <h1 className="claim-title">withdraw sol</h1>
                    </div>
                    <div className="claim-message">
                        Please connect wallet to continue
                    </div>
                    {onBack && (
                        <button className="back-btn" onClick={onBack}>
                            ← back
                        </button>
                    )}
                </div>
            </div>
        );
    }

    // Block new users - they need to generate an address first
    if (isNewUser) {
        return (
            <div className="claim-page">
                <div className="claim-card">
                    <div className="claim-header claim-header--centered">
                        <h1 className="claim-title">no funds found</h1>
                    </div>
                    <div className="claim-message">
                        You haven't generated a privacy address yet. Please go to the Generate page first to create your address, then come back here after receiving funds.
                    </div>
                    {onBack && (
                        <button className="back-btn" onClick={onBack}>
                            ← go to generate
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
                    <h1 className="claim-title">withdraw sol</h1>
                    {onBack && (
                        <button className="back-link" onClick={onBack}>
                            ← back
                        </button>
                    )}
                </div>

                {/* Balance Display */}
                <div className="balance-section">
                    <span className="balance-label">available balance</span>
                    <span className="balance-amount">
                        {isInitialized ? `${formatBalance(totalBalance)} SOL` : '---'}
                    </span>
                </div>
                
                {isInitialized && (
                    <div className="burner-address-display">
                        <small>From: {shredrClient.currentBurnerAddress?.slice(0, 6)}...{shredrClient.currentBurnerAddress?.slice(-6)}</small>
                    </div>
                )}
                
                {/* Destination Display (Read Only) */}
                <div className="destination-info">
                   <div className="destination-label">Recieving Address</div>
                   <div className="destination-value">{publicKey?.toBase58()}</div>
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
                    onClick={isInitialized ? handleWithdraw : handleUnlock}
                    disabled={isWithdrawing || isUnlocking || (isInitialized && totalBalance <= 0)}
                >
                    {isUnlocking ? 'verifying...' : 
                     !isInitialized ? 'scan for funds' :
                     isWithdrawing ? 'withdrawing...' : 'withdraw all'}
                </button>

                {/* Info Note */}
                <div className="claim-note">
                    {!isInitialized 
                        ? "Sign to recover your privacy keys and scan for funds." 
                        : "Withdraw all funds to your connected wallet."}
                </div>
            </div>
        </div>
    );
}

export { ClaimPage };
