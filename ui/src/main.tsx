import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './theme/tokens.css';
import { App } from './App';
import { installZoom } from './ui/zoom';

// Before the first render: the saved zoom applies from the start (spec §12.2).
installZoom();

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
