
import { useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWallet } from '@solana/wallet-adapter-react';
import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { shredrClient } from '../../lib';
import { MASTER_MESSAGE } from '../../lib/constants';
import './ClaimPage.css';

interface ClaimPageProps {
    onBack?: () => void;
}

// State machine for page state (cleaner than multiple booleans)
type PageState = 
    | 'idle'           // Initial state, waiting for user action
    | 'unlocking'      // Signing and verifying
    | 'loadingBalance' // Fetching balance
    | 'ready'          // Balance loaded, ready to withdraw
    | 'withdrawing'    // Withdrawal in progress
    | 'newUser'        // No existing account found
    | 'error';         // Error state

function ClaimPage({ onBack }: ClaimPageProps) {
    const navigate = useNavigate();
    const { connected, publicKey, signMessage } = useWallet();
    
    // State machine approach - single source of truth for page state
    const [pageState, setPageState] = useState<PageState>('idle');
    const [totalBalance, setTotalBalance] = useState<number>(0);
    const [withdrawError, setWithdrawError] = useState<string | null>(null);
    const [withdrawSuccess, setWithdrawSuccess] = useState<string | null>(null);
    
    // Refs for cleanup and debouncing
    const isMountedRef = useRef<boolean>(true);
    const balanceFetchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const lastBalanceFetchRef = useRef<number>(0);
    const BALANCE_FETCH_DEBOUNCE_MS = 1000; // Debounce balance fetches

    // Cleanup on unmount
    useEffect(() => {
        isMountedRef.current = true;
        return () => {
            isMountedRef.current = false;
            if (balanceFetchTimeoutRef.current) {
                clearTimeout(balanceFetchTimeoutRef.current);
                balanceFetchTimeoutRef.current = null;
            }
        };
    }, []);

    // ============ FETCH BALANCE (with debouncing) ============

    const fetchShadowireBalance = useCallback(async (force: boolean = false) => {
        // Debounce: skip if called too recently (unless forced)
        const now = Date.now();
        if (!force && now - lastBalanceFetchRef.current < BALANCE_FETCH_DEBOUNCE_MS) {
            console.log('fetchShadowireBalance: Debounced - too soon since last fetch');
            return;
        }
        lastBalanceFetchRef.current = now;

        console.log('fetchShadowireBalance: Starting...');
        console.log('fetchShadowireBalance: initialized =', shredrClient.initialized);
        console.log('fetchShadowireBalance: shadowireAddress =', shredrClient.shadowireAddress);
        
        if (!shredrClient.initialized || !shredrClient.shadowireAddress) {
            console.log('fetchShadowireBalance: Skipping - not initialized or no address');
            return;
        }
        
        // Only update state if mounted
        if (!isMountedRef.current) return;
        setPageState('loadingBalance');
        
        try {
            console.log('fetchShadowireBalance: Calling getShadowireBalance()...');
            const balance = await shredrClient.getShadowireBalance();
            
            if (!isMountedRef.current) return;
            
            console.log('fetchShadowireBalance: Got balance:', {
                available: balance.available,
                availableLamports: balance.availableLamports,
                poolAddress: balance.poolAddress
            });
            setTotalBalance(balance.availableLamports);
            setPageState('ready');
        } catch (err) {
            console.error('fetchShadowireBalance: Failed to fetch balance:', err);
            if (!isMountedRef.current) return;
            setTotalBalance(0);
            setPageState('ready');
        }
    }, []);

    // Fetch balance when in loadingBalance state (centralized balance fetching)
    useEffect(() => {
        if (connected && pageState === 'loadingBalance' && publicKey) {
            // Trigger balance fetch - force=true bypasses debounce for initial load
            fetchShadowireBalance(true);
        } else if (!connected) {
            setTotalBalance(0);
            setPageState('idle');
        }
    }, [connected, pageState, publicKey, fetchShadowireBalance]);

    // ============ ACTIONS ============

    const handleUnlock = useCallback(async () => {
        if (!publicKey || !signMessage) return;
        try {
            setPageState('unlocking');
            setWithdrawError(null);

            // SECURITY: Use the same message format as GeneratorPage for consistency
            // The signature is used for deterministic key derivation, not authentication
            // The wallet adapter verifies the user owns the private key by signing
            const message = `${MASTER_MESSAGE}:${publicKey.toBase58()}`;
            const encodedMessage = new TextEncoder().encode(message);
            const signature = await signMessage(encodedMessage);

            const isNew = await shredrClient.checkIfNewUser(signature, publicKey.toBytes());

            if (isNew) {
                setPageState('newUser');
            } else {
                await shredrClient.initFromSignature(signature, publicKey.toBytes());
                // Set to loadingBalance - the useEffect will handle fetching
                // This centralizes balance fetching logic in one place
                setPageState('loadingBalance');
            }

        } catch (err) {
            console.error('Unlock failed:', err);
            setWithdrawError('Failed to verify: ' + (err instanceof Error ? err.message : String(err)));
            setPageState('error');
        }
    }, [publicKey, signMessage]);

    const handleWithdraw = useCallback(async () => {
        if (!publicKey) {
            setWithdrawError('Wallet not connected');
            return;
        }
        
        if (pageState !== 'ready' || !shredrClient.shadowireBurner) {
            setWithdrawError('Shadowire address not initialized');
            return;
        }

        // SECURITY: Validate destination address
        const destinationAddress = publicKey.toBase58();
        try {
            // Verify it's a valid Solana public key
            new PublicKey(destinationAddress);
        } catch {
            setWithdrawError('Invalid destination address');
            return;
        }

        try {
            setPageState('withdrawing');
            setWithdrawError(null);
            setWithdrawSuccess(null);

            console.log('ClaimPage: Starting withdrawal to', destinationAddress);

            // Withdraw via external transfer from Shadowire Address (burner[0]) to connected wallet
            const result = await shredrClient.withdrawToWallet(
                destinationAddress,
                'all'  // Withdraw full balance
            );

            if (!isMountedRef.current) return;

            console.log("Withdrawal successful:", result.signature);
            setWithdrawSuccess(`Withdrawn ${result.amount.toFixed(4)} SOL! Tx: ${result.signature.slice(0, 8)}...`);
            
            // Force refresh balance after successful withdrawal
            await fetchShadowireBalance(true);

        } catch (err) {
            console.error('Withdrawal failed:', err);
            if (!isMountedRef.current) return;
            setWithdrawError(err instanceof Error ? err.message : 'Withdrawal failed');
            setPageState('ready');
        }
    }, [publicKey, pageState, fetchShadowireBalance]);

    // ============ HELPERS ============

    const formatBalance = (lamports: number): string => {
        // Handle edge cases: NaN, negative, non-finite
        if (!Number.isFinite(lamports) || lamports < 0) {
            return '0.0000';
        }
        return (lamports / LAMPORTS_PER_SOL).toFixed(4);
    };

    // Derived state helpers for cleaner render logic
    const isInitialized = pageState === 'ready' || pageState === 'withdrawing' || pageState === 'loadingBalance';
    const isLoading = pageState === 'unlocking' || pageState === 'loadingBalance' || pageState === 'withdrawing';

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
    if (pageState === 'newUser') {
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
                        {pageState === 'loadingBalance' ? 'loading...' :
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
                    disabled={isLoading}
                >
                    {pageState === 'unlocking' ? 'verifying...' : 
                     pageState === 'idle' || pageState === 'error' ? 'scan for funds' :
                     pageState === 'loadingBalance' ? 'loading...' :
                     pageState === 'withdrawing' ? 'withdrawing...' : 'withdraw all'}
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
