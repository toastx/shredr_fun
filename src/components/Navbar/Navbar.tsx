import { WalletButton } from '../WalletButton';
import './Navbar.css';

interface NavbarProps {
    brandName?: string;
}

function Navbar({ brandName = "ProxyAddress" }: NavbarProps) {
    return (
        <nav className="navbar">
            <div className="navbar-left">
                <div className="navbar-brand">{brandName}</div>
            </div>
            <div className="navbar-center">
                <ul className="navbar-links">
                    <li><a href="#generate" className="active">Generate</a></li>
                    <li><a href="#about">About</a></li>
                    <li><a href="#docs">Docs</a></li>
                </ul>
            </div>
            <div className="navbar-right">
                <WalletButton />
            </div>
        </nav>
    );
}

export default Navbar;
