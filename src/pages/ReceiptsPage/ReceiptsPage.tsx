import { useState, useCallback, useEffect, useRef } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { shredrClient } from '../../lib';
import type { ReceiptView, VerificationResult } from '../../lib';
import { MASTER_MESSAGE } from '../../lib/constants';
import './ReceiptsPage.css';

type PageState =
    | 'idle'      // waiting for the wallet signature
    | 'unlocking'
    | 'loading'
    | 'ready'
    | 'newUser'
    | 'error';

type Tab = 'mine' | 'verify';

/** Why a disclosure failed, in the auditor's words rather than the code's. */
const FAILURE_REASON: Record<NonNullable<VerificationResult['failed']>, string> = {
    decrypt: 'wrong key, or the receipt was altered',
    pda: 'the signing key does not control the account it claims',
    signature: 'the signature does not match the claim',
    commitment: 'the chain does not record this receipt',
};

function short(address: string): string {
    return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

function when(unixSeconds: bigint): string {
    return new Date(Number(unixSeconds) * 1000).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
    });
}

function ReceiptsPage() {
    const { connected, publicKey, signMessage } = useWallet();

    const [pageState, setPageState] = useState<PageState>('idle');
    const [tab, setTab] = useState<Tab>('mine');
    const [receipts, setReceipts] = useState<ReceiptView[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [openIndex, setOpenIndex] = useState<number | null>(null);
    const [copied, setCopied] = useState<string | null>(null);

    // Verify tab
    const [token, setToken] = useState('');
    const [key, setKey] = useState('');
    const [verifying, setVerifying] = useState(false);
    const [result, setResult] = useState<VerificationResult | null>(null);
    const [verifyError, setVerifyError] = useState<string | null>(null);

    const isMountedRef = useRef(true);
    useEffect(() => {
        isMountedRef.current = true;
        return () => {
            isMountedRef.current = false;
        };
    }, []);

    // Drop decrypted receipts when the wallet disconnects. Adjusted during
    // render rather than in an effect: an effect cascades an extra render, and
    // this is the pattern React documents for reacting to a changed input.
    const [wasConnected, setWasConnected] = useState(connected);
    if (wasConnected !== connected) {
        setWasConnected(connected);
        if (!connected) {
            setPageState('idle');
            setReceipts([]);
            setOpenIndex(null);
        }
    }

    const load = useCallback(async () => {
        try {
            setPageState('loading');
            const found = await shredrClient.listReceipts();
            if (!isMountedRef.current) return;
            setReceipts(found);
            setPageState('ready');
        } catch (err) {
            if (!isMountedRef.current) return;
            setError(err instanceof Error ? err.message : String(err));
            setPageState('error');
        }
    }, []);

    const handleUnlock = useCallback(async () => {
        if (!publicKey || !signMessage) return;
        try {
            setPageState('unlocking');
            setError(null);

            // Same message as the other pages: one signature is the root of
            // every key, including the audit branch.
            const message = `${MASTER_MESSAGE}:${publicKey.toBase58()}`;
            const signature = await signMessage(new TextEncoder().encode(message));

            if (await shredrClient.checkIfNewUser(signature, publicKey.toBytes())) {
                setPageState('newUser');
                return;
            }

            await shredrClient.initFromSignature(signature, publicKey.toBytes());
            await load();
        } catch (err) {
            if (!isMountedRef.current) return;
            setError('Failed to unlock: ' + (err instanceof Error ? err.message : String(err)));
            setPageState('error');
        }
    }, [publicKey, signMessage, load]);

    const copy = useCallback(async (label: string, value: string) => {
        try {
            await navigator.clipboard.writeText(value);
            setCopied(label);
            setTimeout(() => isMountedRef.current && setCopied(null), 1500);
        } catch {
            setCopied(null);
        }
    }, []);

    const handleVerify = useCallback(async () => {
        setVerifying(true);
        setResult(null);
        setVerifyError(null);
        try {
            const outcome = await shredrClient.verifyDisclosureToken(token, key);
            if (!isMountedRef.current) return;
            setResult(outcome);
        } catch (err) {
            if (!isMountedRef.current) return;
            setVerifyError(err instanceof Error ? err.message : String(err));
        } finally {
            if (isMountedRef.current) setVerifying(false);
        }
    }, [token, key]);

    // ============ RENDER ============

    const renderReceipt = (receipt: ReceiptView, i: number) => {
        const expanded = openIndex === i;
        const { attestation: a } = receipt;

        return (
            <li className="receipt" key={`${receipt.depositIndex}-${receipt.exitIndex}`}>
                <button
                    className="receipt-summary"
                    onClick={() => setOpenIndex(expanded ? null : i)}
                    aria-expanded={expanded}
                >
                    <span className="receipt-amount">
                        {(Number(a.amount) / LAMPORTS_PER_SOL).toFixed(4)} sol
                    </span>
                    <span className="receipt-meta">
                        from {short(a.sender)} · {when(a.depositTs)}
                    </span>
                    <span className="receipt-chevron">{expanded ? '−' : '+'}</span>
                </button>

                {expanded && (
                    <div className="receipt-detail">
                        <dl className="receipt-fields">
                            <div><dt>sender</dt><dd>{a.sender}</dd></div>
                            <div><dt>destination</dt><dd>{a.destination}</dd></div>
                            <div><dt>deposit account</dt><dd>{a.depositPda}</dd></div>
                            <div><dt>exit account</dt><dd>{a.exitPda}</dd></div>
                        </dl>

                        <p className="receipt-warning">
                            Handing over this key is permanent and cannot be undone. It
                            opens this one payment, and whoever holds it can prove that
                            payment to anyone else.
                        </p>

                        {receipt.destinationShared && (
                            <p className="receipt-warning receipt-warning--strong">
                                Another receipt withdrew to this same destination.
                                Disclosing this one lets that auditor find the others by
                                watching the address — including payments you have not
                                disclosed.
                            </p>
                        )}

                        <div className="receipt-share">
                            <label>receipt</label>
                            <textarea readOnly value={receipt.token} rows={3} />
                            <button
                                className="ghost-btn"
                                onClick={() => copy(`token-${i}`, receipt.token)}
                            >
                                {copied === `token-${i}` ? 'copied' : 'copy receipt'}
                            </button>
                        </div>

                        <div className="receipt-share">
                            <label>viewing key</label>
                            <textarea readOnly value={receipt.viewingKey} rows={2} />
                            <button
                                className="ghost-btn"
                                onClick={() => copy(`key-${i}`, receipt.viewingKey)}
                            >
                                {copied === `key-${i}` ? 'copied' : 'copy key'}
                            </button>
                        </div>

                        <p className="receipt-note">
                            Send these separately. Neither half is worth anything alone.
                        </p>
                    </div>
                )}
            </li>
        );
    };

    return (
        <div className="receipts-page">
            <div className="receipts-card">
                <div className="receipts-header">
                    <h1 className="receipts-title">audit keys</h1>
                </div>

                <div className="receipts-tabs" role="tablist">
                    <button
                        role="tab"
                        aria-selected={tab === 'mine'}
                        className={tab === 'mine' ? 'active' : ''}
                        onClick={() => setTab('mine')}
                    >
                        my receipts
                    </button>
                    <button
                        role="tab"
                        aria-selected={tab === 'verify'}
                        className={tab === 'verify' ? 'active' : ''}
                        onClick={() => setTab('verify')}
                    >
                        verify one
                    </button>
                </div>

                {tab === 'mine' && (
                    <>
                        {!connected && (
                            <p className="receipts-message">
                                Connect a wallet to see your receipts.
                            </p>
                        )}

                        {connected && pageState === 'idle' && (
                            <>
                                <p className="receipts-message">
                                    A receipt proves one payment reached you, without
                                    revealing any of the others.
                                </p>
                                <button className="primary-btn" onClick={handleUnlock}>
                                    unlock receipts
                                </button>
                            </>
                        )}

                        {(pageState === 'unlocking' || pageState === 'loading') && (
                            <p className="receipts-message">
                                {pageState === 'unlocking' ? 'waiting for signature…' : 'opening receipts…'}
                            </p>
                        )}

                        {pageState === 'newUser' && (
                            <p className="receipts-message">
                                No shredr account yet. Receive a payment first.
                            </p>
                        )}

                        {pageState === 'error' && (
                            <>
                                <p className="receipts-error">{error}</p>
                                <button className="ghost-btn" onClick={handleUnlock}>
                                    try again
                                </button>
                            </>
                        )}

                        {pageState === 'ready' && receipts.length === 0 && (
                            <p className="receipts-message">
                                No receipts yet. One is written every time you withdraw.
                            </p>
                        )}

                        {pageState === 'ready' && receipts.length > 0 && (
                            <ul className="receipts-list">
                                {receipts.map(renderReceipt)}
                            </ul>
                        )}
                    </>
                )}

                {tab === 'verify' && (
                    <>
                        <p className="receipts-message receipts-message--left">
                            Paste a receipt and its key. Verification checks the
                            signatures and the on-chain commitment — no wallet needed.
                        </p>

                        <label className="field-label">receipt</label>
                        <textarea
                            className="field-input"
                            rows={4}
                            value={token}
                            onChange={(e) => setToken(e.target.value)}
                            placeholder="paste the receipt"
                        />

                        <label className="field-label">viewing key</label>
                        <textarea
                            className="field-input"
                            rows={2}
                            value={key}
                            onChange={(e) => setKey(e.target.value)}
                            placeholder="paste the key"
                        />

                        <button
                            className="primary-btn"
                            onClick={handleVerify}
                            disabled={verifying || !token.trim() || !key.trim()}
                        >
                            {verifying ? 'checking…' : 'verify'}
                        </button>

                        {verifyError && <p className="receipts-error">{verifyError}</p>}

                        {result?.ok && result.attestation && (
                            <div className="verify-result verify-result--ok">
                                <strong>verified</strong>
                                <dl className="receipt-fields">
                                    <div>
                                        <dt>amount</dt>
                                        <dd>
                                            {(Number(result.attestation.amount) / LAMPORTS_PER_SOL).toFixed(4)} sol
                                        </dd>
                                    </div>
                                    <div><dt>sender</dt><dd>{result.attestation.sender}</dd></div>
                                    <div><dt>destination</dt><dd>{result.attestation.destination}</dd></div>
                                    <div><dt>paid</dt><dd>{when(result.attestation.depositTs)}</dd></div>
                                </dl>
                            </div>
                        )}

                        {result && !result.ok && (
                            <div className="verify-result verify-result--bad">
                                <strong>not verified</strong>
                                <p>{result.failed ? FAILURE_REASON[result.failed] : 'unknown failure'}</p>
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}

export { ReceiptsPage };
