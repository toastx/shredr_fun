import { Link, useLocation } from 'react-router-dom';
import { WalletButton } from '../WalletButton';
import { DOCS_URL } from '../../lib/constants';
import './Navbar.css';

interface NavbarProps {
    brandName?: string;
}

function Navbar({ brandName = "ProxyAddress" }: NavbarProps) {
    const location = useLocation();

    return (
        <nav className="navbar">
            <div className="navbar-left">
                <Link to="/" className="navbar-brand">{brandName}</Link>
            </div>
            <div className="navbar-center">
                <ul className="navbar-links">
                    <li>
                        <Link 
                            to="/" 
                            className={location.pathname === '/' ? 'active' : ''}
                        >
                            Generate
                        </Link>
                    </li>
                    <li>
                        <Link 
                            to="/claim" 
                            className={location.pathname === '/claim' ? 'active' : ''}
                        >
                            Claim
                        </Link>
                    </li>
                    <li>
                        <a
                            href={DOCS_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                        >
                            Docs
                        </a>
                    </li>
                </ul>
            </div>
            <div className="navbar-right">
                <WalletButton />
            </div>
        </nav>
    );
}

export default Navbar;
