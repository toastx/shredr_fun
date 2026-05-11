import { useState, useCallback, useEffect, useRef } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { shredrClient, webSocketClient } from "../../lib";
import { MASTER_MESSAGE, HELIUS_RPC_URL } from "../../lib/constants";
import type { WebSocketMessage } from "../../lib/types";
import AddressDisplay from "../../components/AddressDisplay";
import { TransactionMonitor } from "../../components/TransactionMonitor";
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

    // Core state — `stealthPdaAddress` is the *PDA* shared with senders
    // (derived from the current one-time burner). It is NOT the burner pubkey.
    const [pageState, setPageState] = useState<PageState>("disconnected");
    const [stealthPdaAddress, setStealthPdaAddress] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [pdaBalance, setPdaBalance] = useState<number>(0);
    const [copied, setCopied] = useState(false);

    // Refs
    const copiedTimeout = useRef<NodeJS.Timeout | null>(null);
    const stealthPdaRef = useRef<string | null>(null);
    const wsMessageHandlerRef = useRef<((data: WebSocketMessage) => void) | null>(null);

    // Sync ref with state
    useEffect(() => {
        stealthPdaRef.current = stealthPdaAddress;
    }, [stealthPdaAddress]);

    // ============ BALANCE ============

    const refreshBalance = useCallback(async (address: string) => {
        try {
            const connection = new Connection(HELIUS_RPC_URL);
            const pubkey = new PublicKey(address);
            const accountInfo = await connection.getAccountInfo(pubkey);
            const lamports = accountInfo?.lamports || 0;
            setPdaBalance(lamports / LAMPORTS_PER_SOL);
            return lamports;
        } catch (err) {
            console.error("Failed to fetch balance:", err);
            return 0;
        }
    }, []);

    // ============ WALLET EFFECTS ============

    useEffect(() => {
        if (!connected) {
            setPageState("disconnected");
            setStealthPdaAddress(null);
            setCopied(false);
            setError(null);
            // IMPORTANT: Disconnect WebSocket BEFORE destroying client
            // to prevent any callbacks from firing during cleanup
            webSocketClient.disconnect();
            shredrClient.destroy();
        } else if (connected && pageState === "disconnected") {
            setPageState("connected");
        }
    }, [connected, pageState]);

    // Cleanup effect for unmount - prevents memory leaks
    useEffect(() => {
        return () => {
            // Clear any pending timeout
            if (copiedTimeout.current) {
                clearTimeout(copiedTimeout.current);
                copiedTimeout.current = null;
            }
            // Remove WebSocket message handler
            if (wsMessageHandlerRef.current) {
                webSocketClient.offMessage(wsMessageHandlerRef.current);
                wsMessageHandlerRef.current = null;
            }
            // Disconnect WebSocket on unmount
            webSocketClient.disconnect();
        };
    }, []);

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

            // The stealth PDA (not the burner pubkey) is what the user shares
            // with senders. It is a program-owned account derived deterministically
            // from the current one-time burner + fixed salt.
            const pda = shredrClient.stealthAddress;
            if (pda) {
                setStealthPdaAddress(pda);
                setPageState("ready");

                // Subscribe to account updates on the stealth PDA
                webSocketClient.subscribeToAccount(pda);

                // Fetch initial balance of the stealth PDA
                await refreshBalance(pda);

                // Listen for account updates
                // Store handler ref for cleanup
                const messageHandler = async (data: WebSocketMessage) => {
                    // SECURITY: Validate message structure before processing
                    if (!data || typeof data !== "object") {
                        console.warn("Invalid WebSocket message: not an object");
                        return;
                    }

                    if (data.type !== "accountUpdate") {
                        return; // Skip non-account-update messages
                    }

                    // Validate lamports value with strict type checking
                    const lamportsFromWs = (data as { lamports?: unknown }).lamports;

                    // SECURITY: Validate lamports is a safe positive integer
                    if (
                        typeof lamportsFromWs !== "number" ||
                        !Number.isFinite(lamportsFromWs) ||
                        !Number.isSafeInteger(lamportsFromWs) ||
                        lamportsFromWs < 0
                    ) {
                        console.warn("Invalid lamports value from WebSocket:", lamportsFromWs);
                        return;
                    }

                    if (lamportsFromWs > 0) {
                        console.log(`WebSocket balance update: ${lamportsFromWs} lamports`);
                        // Update UI balance
                        setPdaBalance(lamportsFromWs / LAMPORTS_PER_SOL);
                    }
                };

                // Store ref for cleanup and register handler
                wsMessageHandlerRef.current = messageHandler;
                webSocketClient.onMessage(messageHandler);
            } else {
                throw new Error("Failed to derive stealth PDA address");
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
    }, [publicKey, signMessage, refreshBalance]);

    const handleCopy = useCallback(async () => {
        if (!stealthPdaAddress) return;
        try {
            await navigator.clipboard.writeText(stealthPdaAddress);
            setCopied(true);
            setPageState("monitoring");
            if (copiedTimeout.current) clearTimeout(copiedTimeout.current);
            copiedTimeout.current = setTimeout(() => setCopied(false), 2000);
        } catch (err) {
            console.error("Failed to copy:", err);
        }
    }, [stealthPdaAddress]);

    const handleRetry = useCallback(() => {
        setError(null);
        setPageState("connected");
    }, []);

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
                            <span className="results-title">stealth address</span>
                        </div>

                        <AddressDisplay
                            label=""
                            value={stealthPdaAddress || ""}
                            placeholder=""
                            isCopied={copied}
                            hasValue={!!stealthPdaAddress}
                            onCopy={handleCopy}
                        />

                        <div className="balance-display">
                            <span className="balance-label">pda balance</span>
                            <span className="balance-amount">
                                {pdaBalance.toFixed(2)} SOL
                            </span>
                        </div>

                        {pageState === "monitoring" && stealthPdaAddress && (
                            <TransactionMonitor burnerAddress={stealthPdaAddress} />
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
            </div>
        </div>
    );
}

export { GeneratorPage };
