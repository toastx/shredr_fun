import { Routes, Route } from 'react-router-dom';
import { Navbar, Footer, GeneratorCard } from './components';
import { ClaimPage } from './pages';
import './App.css';

function App() {
    return (
        <>
            {/* Navbar */}
            <Navbar brandName="shredr.fun" />

            {/* Main Content */}
            <Routes>
                <Route 
                    path="/" 
                    element={
                        <main className="main-content">
                            <GeneratorCard />
                        </main>
                    } 
                />
                <Route 
                    path="/claim" 
                    element={<ClaimPage />} 
                />
            </Routes>

            {/* Footer */}
            <Footer author="toastx" />
        </>
    );
}

export default App;
