import './Footer.css';

interface FooterProps {
    author?: string;
}

function Footer({ author = "toastx" }: FooterProps) {
    return (
        <footer className="footer">
            <p className="footer-text">built by <span>{author}</span></p>
        </footer>
    );
}

export default Footer;
