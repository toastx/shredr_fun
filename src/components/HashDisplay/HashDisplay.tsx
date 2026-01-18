import './HashDisplay.css';

interface HashDisplayProps {
    hash: string;
    isCopied: boolean;
    onCopy: () => void;
}

function HashDisplay({ hash, isCopied, onCopy }: HashDisplayProps) {
    return (
        <div className="hash-section">
            <div className="hash-label">rescue prime hash</div>
            <div 
                className={`hash-display ${isCopied ? 'copied' : ''}`}
                onClick={onCopy}
                title="Click to copy"
            >
                {hash}
                <div className={`hash-copy-hint ${isCopied ? 'copied' : ''}`}>
                    {isCopied ? '✓ Copied!' : 'Click to copy'}
                </div>
            </div>
        </div>
    );
}

export default HashDisplay;
