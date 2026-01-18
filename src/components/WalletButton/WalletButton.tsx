import type { FC } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import './WalletButton.css';

export const WalletButton: FC = () => {
    const { publicKey, connected, disconnect, wallet } = useWallet();
    const { setVisible } = useWalletModal();

    const handleClick = () => {
        if (connected) {
            // Show dropdown or disconnect
        } else {
            setVisible(true);
        }
    };

    const formatAddress = (address: string) => {
        return `${address.slice(0, 4)}...${address.slice(-4)}`;
    };

    return (
        <div className="wallet-button-container">
            {connected && publicKey ? (
                <div className="wallet-connected">
                    <div className="wallet-address-display">
                        <span className="wallet-address">
                            {formatAddress(publicKey.toBase58())}
                        </span>
                    </div>
                    <button className="disconnect-button" onClick={disconnect}>
                        Disconnect
                    </button>
                </div>
            ) : (
                <button className="connect-wallet-button" onClick={() => setVisible(true)}>
                    Connect Wallet
                </button>
            )}
        </div>
    );
};
