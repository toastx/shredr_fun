import { Routes, Route } from 'react-router-dom';
import { Navbar, Footer } from './components';
import { ClaimPage, GeneratorPage } from './pages';
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
                    element={<GeneratorPage />} 
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
