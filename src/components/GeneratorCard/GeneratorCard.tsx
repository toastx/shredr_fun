import { useState, useCallback } from 'react';
import { Keypair } from '@solana/web3.js';
import * as bip39 from 'bip39';
import { RescuePrimeHash } from '@arcium-hq/client';
import AddressDisplay from '../AddressDisplay';
import HashDisplay from '../HashDisplay';
import './GeneratorCard.css';

// Types
interface GeneratedData {
    publicKey: string;
    nullifierSeed: string;
    digestCode: string;
    seedHash: string;
}

// Generate a Solana public key only - private key is NEVER stored or exposed
function generateSolanaPublicKey(): string {
    const keypair = Keypair.generate();
    const publicKey = keypair.publicKey.toBase58();
    return publicKey;
}

// Generate a 12-word mnemonic as nullifier seed
function generateNullifierSeed(): string {
    return bip39.generateMnemonic(128);
}

// Create a digest code from the mnemonic
function createDigestCode(seed: string): string {
    const encoder = new TextEncoder();
    const seedBytes = encoder.encode(seed);
    
    let hash = 0;
    for (let i = 0; i < seedBytes.length; i++) {
        hash = ((hash << 5) - hash) + seedBytes[i];
        hash = hash & hash;
    }
    
    const part1 = Math.abs(hash).toString(16).padStart(8, '0');
    const part2 = seedBytes.slice(0, 8).reduce((acc, b) => acc + b.toString(16).padStart(2, '0'), '');
    const part3 = seedBytes.slice(-8).reduce((acc, b) => acc + b.toString(16).padStart(2, '0'), '');
    
    return `${part1}-${part2}-${part3}`.toUpperCase();
}

// Hash the nullifier seed using Rescue Prime Hash
function hashSeedWithRescue(seed: string): string {
    const hasher = new RescuePrimeHash();
    const encoder = new TextEncoder();
    const seedBytes = encoder.encode(seed);
    
    const message: bigint[] = [];
    for (let i = 0; i < seedBytes.length; i += 4) {
        let value = 0n;
        for (let j = 0; j < 4 && i + j < seedBytes.length; j++) {
            value |= BigInt(seedBytes[i + j]) << BigInt(j * 8);
        }
        message.push(value);
    }
    
    const hashResult = hasher.digest(message);
    return hashResult.map(n => n.toString(16).padStart(64, '0')).join('');
}

// Generate all data at once
function generateAllData(): GeneratedData {
    const publicKey = generateSolanaPublicKey();
    const nullifierSeed = generateNullifierSeed();
    const digestCode = createDigestCode(nullifierSeed);
    const seedHash = hashSeedWithRescue(nullifierSeed);
    
    return { publicKey, nullifierSeed, digestCode, seedHash };
}

function GeneratorCard() {
    const [data, setData] = useState<GeneratedData | null>(null);
    const [showHash, setShowHash] = useState(false);
    const [copied, setCopied] = useState<string | null>(null);

    const handleGenerate = useCallback(() => {
        setData(generateAllData());
        setShowHash(false);
        setCopied(null);
    }, []);

    const copyToClipboard = useCallback(async (text: string, type: string) => {
        try {
            await navigator.clipboard.writeText(text);
            setCopied(type);
            setTimeout(() => setCopied(null), 2000);
        } catch (err) {
            console.error('Failed to copy:', err);
        }
    }, []);

    return (
        <div className="generator-card">
            <button className="generate-btn" onClick={handleGenerate}>
                {data ? 'regenerate' : 'generate address'}
            </button>

            {data && (
                <div className="results-section">
                    <AddressDisplay
                        label="proxy address"
                        value={data.publicKey}
                        placeholder=""
                        isCopied={copied === 'address'}
                        hasValue={true}
                        onCopy={() => copyToClipboard(data.publicKey, 'address')}
                    />

                    <AddressDisplay
                        label="nullifier code"
                        value={data.digestCode}
                        placeholder=""
                        isCopied={copied === 'digest'}
                        hasValue={true}
                        onCopy={() => copyToClipboard(data.nullifierSeed, 'digest')}
                    />

                    <div className="secret-section">
                        <label className="secret-toggle">
                            <input
                                type="checkbox"
                                checked={showHash}
                                onChange={(e) => setShowHash(e.target.checked)}
                            />
                            <span className="toggle-switch"></span>
                            <span className="toggle-label">show commitment hash</span>
                        </label>
                    </div>

                    {showHash && (
                        <HashDisplay
                            hash={data.seedHash}
                            isCopied={copied === 'hash'}
                            onCopy={() => copyToClipboard(data.seedHash, 'hash')}
                        />
                    )}
                </div>
            )}
        </div>
    );
}

export default GeneratorCard;
