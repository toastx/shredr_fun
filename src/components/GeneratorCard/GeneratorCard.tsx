/**
 * GeneratorCard — small reusable card UI that surfaces the user's current
 * burner address (the address to share with senders). This is a presentational
 * variant of GeneratorPage that can be embedded inside other pages.
 */

import { useState, useCallback, useEffect, useRef } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { shredrClient, webSocketClient } from "../../lib";
import { MASTER_MESSAGE, HELIUS_RPC_URL } from "../../lib/constants";
import type { WebSocketMessage, SigningMode } from "../../lib";
import AddressDisplay from "../AddressDisplay";
import { TransactionMonitor } from "../TransactionMonitor";
import "./GeneratorCard.css";

// ============ STATE TYPES ============

type CardState =
  | "disconnected"
  | "connected"
  | "signing"
  | "initializing"
  | "ready"
  | "monitoring"
  | "error";

// ============ COMPONENT ============

function GeneratorCard() {
  const { publicKey, signMessage, connected } = useWallet();
  const { setVisible } = useWalletModal();

  const [cardState, setCardState] = useState<CardState>("disconnected");
  // The one-time **burner pubkey** shared with senders. Deposits land there and
  // are swept into the burner's stealth PDA when the deposit is shredded.
  const [receiveAddress, setReceiveAddress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pdaBalance, setPdaBalance] = useState<number>(0);
  const [copied, setCopied] = useState(false);

  const copiedTimeout = useRef<NodeJS.Timeout | null>(null);
  const receiveAddressRef = useRef<string | null>(null);
  const shreddingRef = useRef(false);
  const wsMessageHandlerRef = useRef<((data: WebSocketMessage) => void) | null>(
    null,
  );

  useEffect(() => {
    receiveAddressRef.current = receiveAddress;
  }, [receiveAddress]);

  // ============ BALANCE ============

  const refreshBalance = useCallback(async (address: string) => {
    try {
      const connection = new Connection(HELIUS_RPC_URL);
      const pubkey = new PublicKey(address);
      const accountInfo = await connection.getAccountInfo(pubkey);
      const lamports = accountInfo?.lamports ?? 0;
      setPdaBalance(lamports / LAMPORTS_PER_SOL);
      return lamports;
    } catch (err) {
      console.error("Failed to fetch balance:", err);
      return 0;
    }
  }, []);

  // ============ EFFECTS ============

  useEffect(() => {
    if (!connected) {
      setCardState("disconnected");
      setReceiveAddress(null);
      setCopied(false);
      setError(null);
      webSocketClient.disconnect();
      shredrClient.destroy();
    } else if (connected && cardState === "disconnected") {
      setCardState("connected");
    }
  }, [connected, cardState]);

  // ============ ACTIONS ============

  const handleConnect = useCallback(() => {
    setVisible(true);
  }, [setVisible]);

  /** Consume the used burner and surface a fresh receive address. */
  const rotateBurner = useCallback(async () => {
    await shredrClient.consumeAndGenerateNew();
    const next = shredrClient.receiveAddress;
    if (!next) return;

    setReceiveAddress(next);
    setPdaBalance(0);
    webSocketClient.subscribeToAccount(next);
  }, []);

  /**
   * Shred a deposit that landed on the burner: sweep + delegate, private
   * transfer into the main PDA inside the rollup, then commit and undelegate.
   * Manual signing mode leaves it for the claim page instead.
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
      setCardState("signing");
      setError(null);

      const message = `${MASTER_MESSAGE}:${publicKey.toBase58()}`;
      const messageBytes = new TextEncoder().encode(message);
      const signature = await signMessage(messageBytes);

      setCardState("initializing");

      const walletPubkeyBytes = publicKey.toBytes();
      await shredrClient.initFromSignature(signature, walletPubkeyBytes);

      const address = shredrClient.receiveAddress;
      if (!address) throw new Error("Failed to derive burner receive address");

      setReceiveAddress(address);
      setCardState("ready");

      webSocketClient.subscribeToAccount(address);

      // Live updates — registered before any await so a slow RPC call cannot
      // delay them, and offMessage'd first so re-signing does not stack handlers.
      const messageHandler = async (data: WebSocketMessage) => {
        if (data.type !== "accountUpdate") return;
        const lamports = (data as { lamports?: unknown }).lamports;
        if (
          typeof lamports !== "number" ||
          !Number.isFinite(lamports) ||
          lamports < 0
        )
          return;
        if (lamports > 0) {
          setPdaBalance(lamports / LAMPORTS_PER_SOL);
          // A deposit landed on the burner — shred it on-chain.
          void handleDeposit();
        }
      };

      if (wsMessageHandlerRef.current) {
        webSocketClient.offMessage(wsMessageHandlerRef.current);
      }
      wsMessageHandlerRef.current = messageHandler;
      webSocketClient.onMessage(messageHandler);

      const initialLamports = await refreshBalance(address);

      // A deposit may have landed while the app was closed.
      if (initialLamports > 0) {
        void handleDeposit();
      }
    } catch (err) {
      console.error("Failed to initialize:", err);
      if (err instanceof Error && err.message.includes("User rejected")) {
        setCardState("connected");
      } else {
        setError(err instanceof Error ? err.message : "Failed to initialize");
        setCardState("error");
      }
    }
  }, [publicKey, signMessage, refreshBalance, handleDeposit]);

  const handleCopy = useCallback(async () => {
    if (!receiveAddress) return;
    try {
      await navigator.clipboard.writeText(receiveAddress);
      setCopied(true);
      setCardState("monitoring");
      if (copiedTimeout.current) clearTimeout(copiedTimeout.current);
      copiedTimeout.current = setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  }, [receiveAddress]);

  const handleRetry = useCallback(() => {
    setError(null);
    setCardState("connected");
  }, []);

  const handleModeChange = useCallback((mode: SigningMode) => {
    shredrClient.setSigningMode(mode);
  }, []);

  // ============ RENDER ============

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
              label="stealth address"
              value={receiveAddress || ""}
              placeholder=""
              isCopied={copied}
              hasValue={!!receiveAddress}
              onCopy={handleCopy}
            />

            <div className="balance-display">
              <span className="balance-label">pda balance</span>
              <span className="balance-amount">
                {pdaBalance.toFixed(4)} SOL
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

            {cardState === "monitoring" && receiveAddress && (
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

  return <div className="generator-card">{renderContent()}</div>;
}

export default GeneratorCard;
