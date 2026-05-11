/**
 * GeneratorCard — small reusable card UI that surfaces the user's current
 * stealth PDA (the address to share with senders). This is a presentational
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
  const [stealthPdaAddress, setStealthPdaAddress] = useState<string | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [pdaBalance, setPdaBalance] = useState<number>(0);
  const [copied, setCopied] = useState(false);

  const copiedTimeout = useRef<NodeJS.Timeout | null>(null);
  const stealthPdaRef = useRef<string | null>(null);

  useEffect(() => {
    stealthPdaRef.current = stealthPdaAddress;
  }, [stealthPdaAddress]);

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
      setStealthPdaAddress(null);
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

      const pda = shredrClient.stealthAddress;
      if (!pda) throw new Error("Failed to derive stealth PDA");

      setStealthPdaAddress(pda);
      setCardState("ready");

      // Subscribe + initial balance
      webSocketClient.subscribeToAccount(pda);
      await refreshBalance(pda);

      // Live updates
      webSocketClient.onMessage(async (data: WebSocketMessage) => {
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
        }
      });
    } catch (err) {
      console.error("Failed to initialize:", err);
      if (err instanceof Error && err.message.includes("User rejected")) {
        setCardState("connected");
      } else {
        setError(err instanceof Error ? err.message : "Failed to initialize");
        setCardState("error");
      }
    }
  }, [publicKey, signMessage, refreshBalance]);

  const handleCopy = useCallback(async () => {
    if (!stealthPdaAddress) return;
    try {
      await navigator.clipboard.writeText(stealthPdaAddress);
      setCopied(true);
      setCardState("monitoring");
      if (copiedTimeout.current) clearTimeout(copiedTimeout.current);
      copiedTimeout.current = setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  }, [stealthPdaAddress]);

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
              value={stealthPdaAddress || ""}
              placeholder=""
              isCopied={copied}
              hasValue={!!stealthPdaAddress}
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

            {cardState === "monitoring" && stealthPdaAddress && (
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

  return <div className="generator-card">{renderContent()}</div>;
}

export default GeneratorCard;
