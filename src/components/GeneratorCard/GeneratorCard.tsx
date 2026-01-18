import { useState, useCallback } from 'react';
import { Keypair } from '@solana/web3.js';
import * as bip39 from 'bip39';
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

// TODO: Implement proper Solana public key generation
// Generate a Solana public key only - private key is NEVER stored or exposed
function generateSolanaPublicKey(): string {
    return "fixed-public-key";
}

// TODO: Implement proper nullifier seed generation
// Generate a 12-word mnemonic as nullifier seed
function generateNullifierSeed(): string {
    return "fixed nullifier seed";
}

// TODO: Implement proper digest code creation
// Create a digest code from the mnemonic
function createDigestCode(seed: string): string {
    return "fixed-digest-code";
}



// TODO: Implement proper data generation
// Generate all data at once
function generateAllData(): GeneratedData {
    const publicKey = generateSolanaPublicKey();
    const nullifierSeed = generateNullifierSeed();
    const digestCode = createDigestCode(nullifierSeed);
    const seedHash = 'placeholder-hash-' + nullifierSeed.split(' ').slice(0, 3).join('-');
    
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
