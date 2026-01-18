import './AddressDisplay.css';

interface AddressDisplayProps {
    label: string;
    value: string;
    placeholder?: string;
    isCopied: boolean;
    hasValue: boolean;
    onCopy: () => void;
}

function AddressDisplay({ 
    label, 
    value, 
    placeholder = "Click below to generate", 
    isCopied, 
    hasValue, 
    onCopy 
}: AddressDisplayProps) {
    return (
        <div className="address-container">
            <div className="address-label">{label}</div>
            <div 
                className={`address-display ${hasValue ? 'has-address' : ''} ${isCopied ? 'copied' : ''}`}
                onClick={onCopy}
                title={hasValue ? "Click to copy" : ""}
            >
                <div className="address-wrapper">
                    <span className="address-text">
                        {value || placeholder}
                    </span>
                    {hasValue && (
                        <span className={`copy-hint ${isCopied ? 'copied' : ''}`}>
                            {isCopied ? '✓ Copied!' : 'Click to copy'}
                        </span>
                    )}
                </div>
            </div>
        </div>
    );
}

export default AddressDisplay;
