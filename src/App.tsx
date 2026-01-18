import { Navbar, Footer, GeneratorCard } from './components';
import './App.css';

function App() {
    return (
        <>
            {/* Navbar */}
            <Navbar brandName="shredr.fun" />

            {/* Main Content */}
            <main className="main-content">
                <GeneratorCard />
            </main>

            {/* Footer */}
            <Footer author="toastx" />
        </>
    );
}

export default App;
