import { useState, useCallback, useEffect, useRef } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { shredrClient, webSocketClient } from "../../lib";
import { MASTER_MESSAGE, HELIUS_RPC_URL, SWEEP_THRESHOLD_LAMPORTS } from "../../lib/constants";
import type { WebSocketMessage } from "../../lib/types";
import type { PendingTransaction, SigningMode } from "../../lib/ShredrClient";
import AddressDisplay from "../../components/AddressDisplay";
import { TransactionMonitor } from "../../components/TransactionMonitor";
import { TransactionApprovalModal } from "../../components/TransactionApprovalModal";
import "./GeneratorPage.css";

// ============ STATE TYPES ============

type PageState =
    | "disconnected" // Wallet not connected
    | "connected"    // Wallet connected, not signed
    | "signing"      // Signing in progress
    | "initializing" // Services initializing
    | "ready"        // Burner ready to use
    | "monitoring"   // Monitoring for transactions
    | "error";       // Error state

// ============ PAGE COMPONENT ============

function GeneratorPage() {
    const { publicKey, signMessage, connected } = useWallet();
    const { setVisible } = useWalletModal();

    // Core state
    const [pageState, setPageState] = useState<PageState>("disconnected");
    const [burnerAddress, setBurnerAddress] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [burnerBalance, setBurnerBalance] = useState<number>(0);
    const [pendingTransaction, setPendingTransaction] = useState<PendingTransaction | null>(null);
    const [isShielding, setIsShielding] = useState(false);
    const [copied, setCopied] = useState(false);
    const [isAutoMode, setIsAutoMode] = useState(true);

    // Refs
    const hasTriggeredSweep = useRef<boolean>(false);
    const copiedTimeout = useRef<NodeJS.Timeout | null>(null);
    const burnerAddressRef = useRef<string | null>(null);

    // Sync ref with state
    useEffect(() => {
        burnerAddressRef.current = burnerAddress;
    }, [burnerAddress]);

    // ============ BALANCE ============

    const refreshBalance = useCallback(async (address: string) => {
        try {
            const connection = new Connection(HELIUS_RPC_URL);
            const pubkey = new PublicKey(address);
            const accountInfo = await connection.getAccountInfo(pubkey);
            const lamports = accountInfo?.lamports || 0;
            setBurnerBalance(lamports / LAMPORTS_PER_SOL);
            return lamports;
        } catch (err) {
            console.error("Failed to fetch balance:", err);
            return 0;
        }
    }, []);

    // ============ SWEEP HANDLER ============

    const handleBalanceUpdate = useCallback(async (balanceLamports: number) => {
        // Only sweep if balance exceeds threshold
        if (balanceLamports < SWEEP_THRESHOLD_LAMPORTS) {
            console.log(`Balance ${balanceLamports} below threshold, skipping sweep`);
            return;
        }

        if (hasTriggeredSweep.current) return;
        hasTriggeredSweep.current = true;
        setIsShielding(true);

        try {
            const result = await shredrClient.incomingTx(balanceLamports);
            if (result.sweepSignature) {
                // Rotate to new burner
                const newAddress = shredrClient.currentBurnerAddress;
                if (newAddress && newAddress !== burnerAddressRef.current) {
                    setBurnerAddress(newAddress);
                    webSocketClient.subscribeToAccount(newAddress);
                    await refreshBalance(newAddress);
                }
            } else if (result.needsApproval && result.pendingTx) {
                setPendingTransaction(result.pendingTx);
                setIsShielding(false);
                return;
            }
        } catch (err) {
            console.error("Sweep failed:", err);
        }
        setIsShielding(false);
        hasTriggeredSweep.current = false;
    }, [refreshBalance]);

    // ============ WALLET EFFECTS ============

    useEffect(() => {
        if (!connected) {
            setPageState("disconnected");
            setBurnerAddress(null);
            setCopied(false);
            setError(null);
            setPendingTransaction(null);
            shredrClient.destroy();
            webSocketClient.disconnect();
        } else if (connected && pageState === "disconnected") {
            setPageState("connected");
        }
    }, [connected, pageState]);

    // ============ ACTIONS ============

    const handleConnect = useCallback(() => {
        setVisible(true);
    }, [setVisible]);

    const handleSign = useCallback(async () => {
        if (!publicKey || !signMessage) {
            setError("Wallet not connected or signMessage not available");
            return;
        }

        try {
            setPageState("signing");
            setError(null);

            // Sign the SHREDR message
            const message = `${MASTER_MESSAGE}:${publicKey.toBase58()}`;
            const messageBytes = new TextEncoder().encode(message);
            const signature = await signMessage(messageBytes);

            setPageState("initializing");

            // Initialize ShredrClient
            const walletPubkeyBytes = publicKey.toBytes();
            await shredrClient.initFromSignature(signature, walletPubkeyBytes);

            // Get burner address
            const address = shredrClient.currentBurnerAddress;
            if (address) {
                setBurnerAddress(address);
                setPageState("ready");

                // Subscribe to account updates (auto-connects WebSocket)
                webSocketClient.subscribeToAccount(address);

                // Fetch initial balance and check for sweep
                const lamports = await refreshBalance(address);
                if (lamports >= SWEEP_THRESHOLD_LAMPORTS) {
                    handleBalanceUpdate(lamports);
                }

                // Listen for account updates
                webSocketClient.onMessage(async (data: WebSocketMessage) => {
                    if (data.type === "accountUpdate") {
                        await new Promise(resolve => setTimeout(resolve, 2000));
                        const currentAddress = burnerAddressRef.current;
                        if (currentAddress) {
                            const newLamports = await refreshBalance(currentAddress);
                            handleBalanceUpdate(newLamports);
                        }
                    }
                });
            } else {
                throw new Error("Failed to derive burner address");
            }
        } catch (err) {
            console.error("Failed to initialize:", err);
            if (err instanceof Error && err.message.includes("User rejected")) {
                setPageState("connected");
            } else {
                setError(err instanceof Error ? err.message : "Failed to initialize");
                setPageState("error");
            }
        }
    }, [publicKey, signMessage, refreshBalance, handleBalanceUpdate]);

    const handleCopy = useCallback(async () => {
        if (!burnerAddress) return;
        try {
            await navigator.clipboard.writeText(burnerAddress);
            setCopied(true);
            setPageState("monitoring");
            if (copiedTimeout.current) clearTimeout(copiedTimeout.current);
            copiedTimeout.current = setTimeout(() => setCopied(false), 2000);
        } catch (err) {
            console.error("Failed to copy:", err);
        }
    }, [burnerAddress]);

    const handleRetry = useCallback(() => {
        setError(null);
        setPageState("connected");
    }, []);

    const handleApproveTransaction = useCallback(async () => {
        if (!pendingTransaction) return;
        try {
            await shredrClient.approveSweep(pendingTransaction);
            const newAddress = shredrClient.currentBurnerAddress;
            if (newAddress) {
                setBurnerAddress(newAddress);
                webSocketClient.subscribeToAccount(newAddress);
                await refreshBalance(newAddress);
            }
        } catch (err) {
            console.error("Manual sweep failed:", err);
        }
        setPendingTransaction(null);
        hasTriggeredSweep.current = false;
    }, [pendingTransaction, refreshBalance]);

    const handleRejectTransaction = useCallback(() => {
        setPendingTransaction(null);
        hasTriggeredSweep.current = false;
    }, []);

    const handleModeToggle = useCallback(() => {
        const newMode: SigningMode = isAutoMode ? "manual" : "auto";
        setIsAutoMode(!isAutoMode);
        shredrClient.setSigningMode(newMode);
    }, [isAutoMode]);

    // ============ RENDER ============

    const renderContent = () => {
        switch (pageState) {
            case "disconnected":
                return (
                    <button className="generate-btn" onClick={handleConnect}>
                        connect wallet
                    </button>
                );

            case "connected":
                return (
                    <button className="generate-btn" onClick={handleSign}>
                        sign to unlock
                    </button>
                );

            case "signing":
                return (
                    <button className="generate-btn" disabled>
                        <span className="loading-dots">signing</span>
                    </button>
                );

            case "initializing":
                return (
                    <button className="generate-btn" disabled>
                        <span className="loading-dots">initializing</span>
                    </button>
                );

            case "ready":
            case "monitoring":
                return (
                    <div className="results-section">
                        <div className="results-header">
                            <span className="results-title">burner address</span>
                            <label className="mode-toggle">
                                <input
                                    type="checkbox"
                                    checked={isAutoMode}
                                    onChange={handleModeToggle}
                                />
                                <span className="toggle-slider"></span>
                                <span className="toggle-label">{isAutoMode ? "auto" : "manual"}</span>
                            </label>
                        </div>

                        <AddressDisplay
                            label=""
                            value={burnerAddress || ""}
                            placeholder=""
                            isCopied={copied}
                            hasValue={!!burnerAddress}
                            onCopy={handleCopy}
                        />

                        <div className="balance-display">
                            <span className="balance-label">burner balance</span>
                            <span className="balance-amount">
                                {burnerBalance.toFixed(4)} SOL
                            </span>
                        </div>

                        {pageState === "monitoring" && burnerAddress && (
                            <TransactionMonitor burnerAddress={burnerAddress} />
                        )}
                    </div>
                );

            case "error":
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

    return (
        <div className="generator-page">
            <div className="generator-card">
                {renderContent()}

                {isShielding && (
                    <div className="shielding-dialog">
                        <div className="shielding-content">
                            <span className="shielding-icon">🛡️</span>
                            <span className="shielding-text">shielding funds...</span>
                        </div>
                    </div>
                )}

                {pendingTransaction && burnerAddress && (
                    <TransactionApprovalModal
                        transaction={pendingTransaction}
                        burnerAddress={burnerAddress}
                        onApprove={handleApproveTransaction}
                        onReject={handleRejectTransaction}
                    />
                )}
            </div>
        </div>
    );
}

export { GeneratorPage };
