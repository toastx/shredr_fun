import { useState } from 'react'
import './App.css'

// Word lists for generating secret phrases
const adjectives = [
    'swift', 'silent', 'crimson', 'dark', 'hidden', 'ancient', 'mystic', 'shadow',
    'fierce', 'noble', 'cosmic', 'stellar', 'blazing', 'phantom', 'eternal', 'frozen'
];

const nouns = [
    'phoenix', 'dragon', 'falcon', 'cipher', 'nexus', 'vortex', 'ember', 'raven',
    'oracle', 'sentinel', 'titan', 'specter', 'forge', 'vault', 'realm', 'storm'
];

function generateRandomAddress(length: number = 40): string {
    const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let result = "0x";
    for (let i = 0; i < length; i++) {
        result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result;
}

function generateSecretWord(): string {
    const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const noun = nouns[Math.floor(Math.random() * nouns.length)];
    const num = Math.floor(Math.random() * 999);
    return `${adj}-${noun}-${num}`;
}

function App() {
    const [address, setAddress] = useState<string>("");
    const [secretWord, setSecretWord] = useState<string>("");
    const [showSecret, setShowSecret] = useState<boolean>(false);
    const [hasGenerated, setHasGenerated] = useState<boolean>(false);
    const [addressCopied, setAddressCopied] = useState<boolean>(false);
    const [secretCopied, setSecretCopied] = useState<boolean>(false);

    const handleGenerateClick = () => {
        const newAddress = generateRandomAddress();
        const newSecret = generateSecretWord();
        setAddress(newAddress);
        setSecretWord(newSecret);
        setHasGenerated(true);
        setAddressCopied(false);
        setSecretCopied(false);
    };

    const copyToClipboard = async (text: string, type: 'address' | 'secret') => {
        if (!text) return;
        
        try {
            await navigator.clipboard.writeText(text);
            if (type === 'address') {
                setAddressCopied(true);
                setTimeout(() => setAddressCopied(false), 2000);
            } else {
                setSecretCopied(true);
                setTimeout(() => setSecretCopied(false), 2000);
            }
        } catch (err) {
            console.error('Failed to copy:', err);
        }
    };

    return (
        <>
            {/* Navbar */}
            <nav className="navbar">
                <div className="navbar-brand">ProxyAddress</div>
                <ul className="navbar-links">
                    <li><a href="#generate" className="active">Generate</a></li>
                    <li><a href="#about">About</a></li>
                    <li><a href="#docs">Docs</a></li>
                </ul>
            </nav>

            {/* Main Content */}
            <main className="main-content">
                <div className="generator-card">
                    <div className="card-header">
                        <h1 className="card-title">Generate Address</h1>
                        <p className="card-subtitle">Create a random proxy address instantly</p>
                    </div>

                    {/* Address Display - Click to Copy */}
                    <div className="address-container">
                        <div 
                            className={`address-display ${hasGenerated ? 'has-address' : ''} ${addressCopied ? 'copied' : ''}`}
                            onClick={() => copyToClipboard(address, 'address')}
                            title={hasGenerated ? "Click to copy" : ""}
                        >
                            <div className="address-wrapper">
                                <span className="address-text">
                                    {address || "Click below to generate an address"}
                                </span>
                                {hasGenerated && (
                                    <span className={`copy-hint ${addressCopied ? 'copied' : ''}`}>
                                        {addressCopied ? '✓ Copied!' : 'Click to copy'}
                                    </span>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* Secret Word Section */}
                    <div className="secret-section">
                        <label className="secret-toggle">
                            <input
                                type="checkbox"
                                checked={showSecret}
                                onChange={(e) => setShowSecret(e.target.checked)}
                            />
                            <span className="toggle-switch"></span>
                            <span className="toggle-label">Show Secret Word</span>
                        </label>

                        {showSecret && hasGenerated && (
                            <div 
                                className={`secret-display ${secretCopied ? 'copied' : ''}`}
                                onClick={() => copyToClipboard(secretWord, 'secret')}
                                title="Click to copy"
                            >
                                <div className="secret-label">
                                    {secretCopied ? '✓ Copied!' : 'Your Secret'}
                                </div>
                                <div className="secret-word">{secretWord}</div>
                                <div className={`secret-copy-hint ${secretCopied ? 'copied' : ''}`}>
                                    {secretCopied ? '✓ Copied!' : 'Click to copy'}
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Generate Button */}
                    <button className="generate-btn" onClick={handleGenerateClick}>
                        Generate Address
                    </button>
                </div>
            </main>

            {/* Footer */}
            <footer className="footer">
                <p className="footer-text">built by <span>toastx</span></p>
            </footer>
        </>
    )
}

export default App
