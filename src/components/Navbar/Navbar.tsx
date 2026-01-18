import './Navbar.css';

interface NavbarProps {
    brandName?: string;
}

function Navbar({ brandName = "ProxyAddress" }: NavbarProps) {
    return (
        <nav className="navbar">
            <div className="navbar-brand">{brandName}</div>
            <ul className="navbar-links">
                <li><a href="#generate" className="active">Generate</a></li>
                <li><a href="#about">About</a></li>
                <li><a href="#docs">Docs</a></li>
            </ul>
        </nav>
    );
}

export default Navbar;
