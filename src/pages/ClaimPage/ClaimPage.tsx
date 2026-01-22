
import { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { shredrClient } from '../../lib';
import './ClaimPage.css';

interface ClaimPageProps {
    onBack?: () => void;
}

function ClaimPage({ onBack }: ClaimPageProps) {
    const navigate = useNavigate();
    const { connected, publicKey, signMessage } = useWallet();
    const { connection } = useConnection();
    
    // State
    const [totalBalance, setTotalBalance] = useState<number>(0);
    const [isLoadingBalance, setIsLoadingBalance] = useState(false);
    const [isWithdrawing, setIsWithdrawing] = useState(false);
    const [withdrawError, setWithdrawError] = useState<string | null>(null);
    const [withdrawSuccess, setWithdrawSuccess] = useState<string | null>(null);
    const [isInitialized, setIsInitialized] = useState<boolean>(false);
    const [isUnlocking, setIsUnlocking] = useState<boolean>(false);
    const [isNewUser, setIsNewUser] = useState<boolean>(false);

    // ============ FETCH BALANCE ============

    const fetchShadowireBalance = useCallback(async () => {
        if (!shredrClient.initialized || !shredrClient.shadowireAddress) return;
        
        setIsLoadingBalance(true);
        try {
            // Get the RPC URL from the connection
            const rpcUrl = connection.rpcEndpoint;
            const balance = await shredrClient.getShadowireBalance(rpcUrl);
            setTotalBalance(balance.availableLamports);
        } catch (err) {
            console.error('Failed to fetch balance:', err);
            // Set to 0 if balance fetch fails (likely no account)
            setTotalBalance(0);
        } finally {
            setIsLoadingBalance(false);
        }
    }, [connection.rpcEndpoint]);

    // Fetch balance when initialized
    useEffect(() => {
        if (connected && isInitialized && publicKey) {
            fetchShadowireBalance();
        } else {
            setTotalBalance(0);
        }
    }, [connected, isInitialized, publicKey, fetchShadowireBalance]);

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
        if (!publicKey) {
            setWithdrawError('Wallet not connected');
            return;
        }
        
        if (!isInitialized || !shredrClient.shadowireBurner) {
            setWithdrawError('Shadowire address not initialized');
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

            // Get the RPC URL from the connection
            const rpcUrl = connection.rpcEndpoint;

            // Withdraw via external transfer from Shadowire Address (burner[0]) to connected wallet
            const result = await shredrClient.withdrawToWallet(
                publicKey.toBase58(),
                'all',  // Withdraw full balance
                rpcUrl
            );

            console.log("Withdrawal successful:", result.signature);
            setWithdrawSuccess(`Withdrawn ${result.amount.toFixed(4)} SOL! Tx: ${result.signature.slice(0, 8)}...`);
            
            // Refresh balance after successful withdrawal
            await fetchShadowireBalance();

        } catch (err) {
            console.error('Withdrawal failed:', err);
            setWithdrawError(err instanceof Error ? err.message : 'Withdrawal failed');
        } finally {
            setIsWithdrawing(false);
        }
    }, [publicKey, isInitialized, connection.rpcEndpoint, fetchShadowireBalance]);

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
                    <button className="back-btn" onClick={() => navigate('/')}>
                        ← back
                    </button>
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
                    <button className="back-btn" onClick={() => navigate('/')}>
                        ← go to generate
                    </button>
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
                    <span className="balance-label">shadowire balance</span>
                    <span className="balance-amount">
                        {isLoadingBalance ? 'loading...' :
                         isInitialized ? `${formatBalance(totalBalance)} SOL` : '---'}
                    </span>
                </div>
                
                {/* Shadowire Address Display */}
                {isInitialized && shredrClient.shadowireAddress && (
                    <div className="burner-address-display">
                        <small>From: {shredrClient.shadowireAddress.slice(0, 6)}...{shredrClient.shadowireAddress.slice(-6)}</small>
                    </div>
                )}
                
                {/* Destination Display (Read Only) */}
                <div className="destination-info">
                   <div className="destination-label">Receiving Address</div>
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
                    disabled={isWithdrawing || isUnlocking || isLoadingBalance || (isInitialized && totalBalance <= 0)}
                >
                    {isUnlocking ? 'verifying...' : 
                     !isInitialized ? 'scan for funds' :
                     isLoadingBalance ? 'loading...' :
                     isWithdrawing ? 'withdrawing...' : 'withdraw all'}
                </button>

                {/* Info Note */}
                <div className="claim-note">
                    {!isInitialized 
                        ? "Sign to recover your privacy keys and scan for funds." 
                        : "Withdraw all funds from your Shadowire Address to your connected wallet."}
                </div>
            </div>
        </div>
    );
}

export { ClaimPage };
