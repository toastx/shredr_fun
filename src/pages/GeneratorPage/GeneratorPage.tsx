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

    // Core state — `receiveAddress` is the one-time **burner pubkey** shared
    // with senders. Deposits land there and are swept into the burner's stealth
    // PDA by InitializeAndDelegate, which requires the PDA to still be empty.
    const [pageState, setPageState] = useState<PageState>("disconnected");
    const [receiveAddress, setReceiveAddress] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [pdaBalance, setPdaBalance] = useState<number>(0);
    const [copied, setCopied] = useState(false);

    // Refs
    const copiedTimeout = useRef<NodeJS.Timeout | null>(null);
    const receiveAddressRef = useRef<string | null>(null);
    const shreddingRef = useRef(false);
    const wsMessageHandlerRef = useRef<((data: WebSocketMessage) => void) | null>(null);

    // Sync ref with state — the WebSocket handler is registered once and needs
    // the address that is current when a deposit lands, not when it was built.
    useEffect(() => {
        receiveAddressRef.current = receiveAddress;
    }, [receiveAddress]);

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
            setReceiveAddress(null);
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

    /**
     * Consume the used burner and surface a fresh receive address, so the next
     * sender never reuses an address that has already been shredded.
     */
    const rotateBurner = useCallback(async () => {
        await shredrClient.consumeAndGenerateNew();
        const next = shredrClient.receiveAddress;
        if (!next) return;

        setReceiveAddress(next);
        setPdaBalance(0);
        webSocketClient.subscribeToAccount(next);
    }, []);

    /**
     * Run the on-chain shred for a deposit that just landed on the burner:
     * sweep + delegate, private-transfer into the main PDA inside the rollup,
     * then commit and undelegate the drained stealth PDA.
     *
     * Only runs in "auto" signing mode; in manual mode the deposit stays on the
     * burner until the claim page shreds it. Failures are logged rather than
     * surfaced: the funds stay on the burner and the claim page picks them up
     * on its next scan.
     */
    const handleDeposit = useCallback(async () => {
        if (shreddingRef.current) return;
        if (shredrClient.signingMode !== "auto") return;

        const address = receiveAddressRef.current;
        if (!address) return;

        // Subscriptions to rotated burners are never torn down, so confirm the
        // balance on-chain instead of trusting the notification.
        const lamports = await refreshBalance(address);
        if (lamports <= 0) return;

        shreddingRef.current = true;
        try {
            const result = await shredrClient.shredBurner();
            console.log("Shredded deposit:", result.signatures);
            await rotateBurner();
        } catch (err) {
            console.error("Failed to shred deposit:", err);
        } finally {
            shreddingRef.current = false;
        }
    }, [refreshBalance, rotateBurner]);

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

            // The burner pubkey is what the user shares with senders: the
            // program sweeps that balance into the stealth PDA when shredding.
            const address = shredrClient.receiveAddress;
            if (address) {
                setReceiveAddress(address);
                setPageState("ready");

                // Subscribe to account updates on the burner
                webSocketClient.subscribeToAccount(address);

                // Fetch initial balance of the burner
                const initialLamports = await refreshBalance(address);

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
                        // A deposit landed on the burner — shred it on-chain.
                        void handleDeposit();
                    }
                };

                // Store ref for cleanup and register handler
                wsMessageHandlerRef.current = messageHandler;
                webSocketClient.onMessage(messageHandler);

                // A deposit may have landed while the app was closed.
                if (initialLamports > 0) {
                    void handleDeposit();
                }
            } else {
                throw new Error("Failed to derive burner receive address");
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
    }, [publicKey, signMessage, refreshBalance, handleDeposit]);

    const handleCopy = useCallback(async () => {
        if (!receiveAddress) return;
        try {
            await navigator.clipboard.writeText(receiveAddress);
            setCopied(true);
            setPageState("monitoring");
            if (copiedTimeout.current) clearTimeout(copiedTimeout.current);
            copiedTimeout.current = setTimeout(() => setCopied(false), 2000);
        } catch (err) {
            console.error("Failed to copy:", err);
        }
    }, [receiveAddress]);

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
                            value={receiveAddress || ""}
                            placeholder=""
                            isCopied={copied}
                            hasValue={!!receiveAddress}
                            onCopy={handleCopy}
                        />

                        <div className="balance-display">
                            <span className="balance-label">pda balance</span>
                            <span className="balance-amount">
                                {pdaBalance.toFixed(2)} SOL
                            </span>
                        </div>

                        {pageState === "monitoring" && receiveAddress && (
                            <TransactionMonitor burnerAddress={receiveAddress} />
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
