import { useState, useCallback, useEffect, useRef } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { shredrClient, webSocketClient } from "../../lib";
import { MASTER_MESSAGE, HELIUS_RPC_URL } from "../../lib/constants";
import type { WebSocketMessage } from "../../lib/types";
import type { PendingTransaction, SigningMode } from "../../lib/ShredrClient";
import AddressDisplay from "../AddressDisplay";
import { TransactionMonitor } from "../TransactionMonitor";
import { TransactionApprovalModal } from "../TransactionApprovalModal";
import "./GeneratorCard.css";

// ============ STATE TYPES ============

type CardState =
  | "disconnected" // Wallet not connected
  | "connected" // Wallet connected, not signed
  | "signing" // Signing in progress
  | "initializing" // Services initializing
  | "ready" // Burner ready to use
  | "monitoring" // Monitoring for transactions
  | "error"; // Error state

// ============ COMPONENT ============

function GeneratorCard() {
  const { publicKey, signMessage, connected } = useWallet();
  const { setVisible } = useWalletModal();

  // Consolidated state
  const [cardState, setCardState] = useState<CardState>("disconnected");
  const [burnerAddress, setBurnerAddress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [burnerBalance, setBurnerBalance] = useState<number>(0);

  const [pendingTransaction, setPendingTransaction] =
    useState<PendingTransaction | null>(null);
  const [isShielding, setIsShielding] = useState(false);

  // Refs for transient state
  const hasTriggeredSweep = useRef<boolean>(false);
  const copiedTimeout = useRef<NodeJS.Timeout | null>(null);
  const burnerAddressRef = useRef<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Sync ref with state
  useEffect(() => {
    burnerAddressRef.current = burnerAddress;
  }, [burnerAddress]);

  // ============ HELPER FUNCTIONS ============

  /**
   * Fetch total balance (Public + Shielded) for the current burner
   */
  const refreshTotalBalance = useCallback(async (address: string) => {
    try {
      const connection = new Connection(HELIUS_RPC_URL);
      const pubkey = new PublicKey(address);

      // 1. Get Public Balance
      const accountInfo = await connection.getAccountInfo(pubkey);
      const publicLamports = accountInfo?.lamports || 0;

      // 2. Get Shielded Balance (if any)
      const shieldedBalance =
        await shredrClient.getCurrentBurnerShieldedBalance();
      const shieldedLamports = shieldedBalance?.availableLamports || 0;

      const totalSol = (publicLamports + shieldedLamports) / LAMPORTS_PER_SOL;
      setBurnerBalance(totalSol);
      console.log(
        `Balance updated: Public=${publicLamports}, Shielded=${shieldedLamports}, Total=${totalSol}`,
      );

      return publicLamports; // Return public lamports for sweep check
    } catch (err) {
      console.error("Failed to fetch balance:", err);
      return 0;
    }
  }, []);



  const updateToNewBurner = useCallback(async () => {
    const newAddress = shredrClient.currentBurnerAddress;
    if (newAddress && newAddress !== burnerAddress) {
      console.log("Rotating to new burner:", newAddress);
      setBurnerAddress(newAddress);

      if (webSocketClient.isConnected()) {
        webSocketClient.subscribeToAccount(newAddress);
      }

      await refreshTotalBalance(newAddress);
    }
  }, [burnerAddress, refreshTotalBalance]);

  // ============ EFFECTS ============

  // Handle wallet connection changes
  useEffect(() => {
    if (!connected) {
      setCardState("disconnected");
      setBurnerAddress(null);
      setCopied(false);
      setError(null);
      setPendingTransaction(null);
      shredrClient.destroy();
      webSocketClient.disconnect();
    } else if (connected && cardState === "disconnected") {
      setCardState("connected");
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
      setError("Wallet not connected or signMessage not available");
      return;
    }

    try {
      setCardState("signing");
      setError(null);

      // 1. Sign the SHREDR message
      const message = `${MASTER_MESSAGE}:${publicKey.toBase58()}`;
      const messageBytes = new TextEncoder().encode(message);
      const signature = await signMessage(messageBytes);

      setCardState("initializing");

      // 2. Initialize ShredrClient
      const walletPubkeyBytes = publicKey.toBytes();
      await shredrClient.initFromSignature(
        signature,
        walletPubkeyBytes,
        // TODO: Pass fetchBlobsFn and createBlobFn for backend sync
      );

      // 3. Get burner address
      const address = shredrClient.currentBurnerAddress;
      if (address) {
        setBurnerAddress(address);
        setCardState("ready");

        // 4. Connect WebSocket for transaction monitoring
        webSocketClient.connect();

        // 5. Subscribe to burner address once connected
        const initMonitoring = async () => {
          webSocketClient.subscribeToAccount(address);

          // Fetch total balance and check for sweep
          const publicLamports = await refreshTotalBalance(address);

          // Check if initial balance needs sweep
          if (publicLamports > 0.1 * LAMPORTS_PER_SOL) {
            handleBalanceUpdate(publicLamports);
          }


        };

        if (webSocketClient.isConnected()) {
          initMonitoring();
        } else {
          const handleConnect = (connected: boolean) => {
            if (connected) {
              initMonitoring();
              webSocketClient.offConnectionChange(handleConnect);
            }
          };
          webSocketClient.onConnectionChange(handleConnect);
        }

        // 6. Add message handler with delay for tx confirmation
        webSocketClient.onMessage(async (data: WebSocketMessage) => {
          console.log("WebSocket message received:", data);

          if (data.type === "accountUpdate") {
            // Wait 2 seconds for tx to be confirmed on chain
            await new Promise((resolve) => setTimeout(resolve, 2000));

            const currentAddress = burnerAddressRef.current;
            if (currentAddress) {
              const publicLamports = await refreshTotalBalance(currentAddress);
              console.log(
                `Confirmed balance update: ${publicLamports} lamports`,
              );
              handleBalanceUpdate(publicLamports);
            }
          }
        });
      } else {
        throw new Error("Failed to derive burner address");
      }
    } catch (err) {
      console.error("Failed to initialize:", err);
      if (err instanceof Error && err.message.includes("User rejected")) {
        // User cancelled signing
        setCardState("connected");
      } else {
        setError(err instanceof Error ? err.message : "Failed to initialize");
        setCardState("error");
      }
    }
  }, [publicKey, signMessage, refreshTotalBalance]);

  /**
   * Copy burner address and start monitoring
   */
  const handleCopy = useCallback(async () => {
    if (!burnerAddress) return;
    try {
      await navigator.clipboard.writeText(burnerAddress);
      setCopied(true);
      setCardState("monitoring");
      if (copiedTimeout.current) clearTimeout(copiedTimeout.current);
      copiedTimeout.current = setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  }, [burnerAddress]);

  /**
   * Retry after error
   */
  const handleRetry = useCallback(() => {
    setError(null);
    setCardState("connected");
  }, []);

  /**
   * Handle balance update - delegates to ShredrClient.incomingTx()
   */
  const handleBalanceUpdate = useCallback(
    async (balanceLamports: number) => {
      if (hasTriggeredSweep.current) return;
      hasTriggeredSweep.current = true;
      setIsShielding(true);

      try {
        const result = await shredrClient.incomingTx(balanceLamports);
        if (result.sweepSignature) {
          await updateToNewBurner();
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
    },
    [updateToNewBurner],
  );

  const handleApproveTransaction = useCallback(async () => {
    if (!pendingTransaction) return;
    try {
      await shredrClient.approveSweep(pendingTransaction);
      await updateToNewBurner();
    } catch (err) {
      console.error("Manual sweep failed:", err);
    }
    setPendingTransaction(null);
    hasTriggeredSweep.current = false;
  }, [pendingTransaction, updateToNewBurner]);

  const handleRejectTransaction = useCallback(() => {
    setPendingTransaction(null);
    hasTriggeredSweep.current = false;
  }, []);

  const handleModeChange = useCallback((mode: SigningMode) => {
    shredrClient.setSigningMode(mode);
  }, []);

  // ============ RENDER HELPERS ============

  const renderContent = () => {
    switch (cardState) {
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
            <AddressDisplay
              label="burner address"
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

            <div className="mode-toggle">
              <span className="mode-label">signing mode:</span>
              <button
                className={`mode-btn ${shredrClient.signingMode === "auto" ? "active" : ""}`}
                onClick={() => handleModeChange("auto")}
              >
                auto
              </button>
              <button
                className={`mode-btn ${shredrClient.signingMode === "manual" ? "active" : ""}`}
                onClick={() => handleModeChange("manual")}
              >
                manual
              </button>
            </div>

            {cardState === "monitoring" && (
              <TransactionMonitor
                burnerAddress={burnerAddress || ""}
              />
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

  // ============ RENDER ============

  return (
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
  );
}

export default GeneratorCard;
