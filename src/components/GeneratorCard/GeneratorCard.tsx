import { useState, useCallback, useEffect } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { shredrClient } from '../../lib';
import { MASTER_MESSAGE } from '../../lib/constants';
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

                        {isMonitoring && (
                            <TransactionMonitor 
                                burnerAddress={burnerAddress || ''} 
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
