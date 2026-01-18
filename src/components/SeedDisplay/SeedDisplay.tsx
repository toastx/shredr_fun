import './SeedDisplay.css';

interface SeedDisplayProps {
    words: string[];
    isCopied: boolean;
    onCopy: () => void;
}

function SeedDisplay({ words, isCopied, onCopy }: SeedDisplayProps) {
    return (
        <div className="seed-section">
            <div className="seed-label">Nullifier Seed ({words.length} Words)</div>
            <div 
                className={`seed-display ${isCopied ? 'copied' : ''}`}
                onClick={onCopy}
                title="Click to copy"
            >
                <div className="seed-words">
                    {words.map((word, index) => (
                        <div key={index} className="seed-word">
                            <span>{index + 1}.</span> {word}
                        </div>
                    ))}
                </div>
                <div className={`seed-copy-hint ${isCopied ? 'copied' : ''}`}>
                    {isCopied ? '✓ Copied!' : 'Click to copy'}
                </div>
            </div>
        </div>
    );
}

export default SeedDisplay;
