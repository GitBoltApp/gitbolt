// First: where actions start (the confirm model), seen before the key router or React acts.
import './ui/arm/origin';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './theme/tokens.css';
import { App } from './App';
import { bindDebugLogging, installFrontendErrorLogging } from './debug/frontendLog';
import { bindThemeToSettings } from './theme/bind';
import { installFontZoom } from './diff/fontZoom';
import { installZoom } from './ui/zoom';

// First, before anything else can throw: uncaught errors reach the backend log file (spec §16.2).
installFrontendErrorLogging();
bindDebugLogging();

// Before the first render: the saved zoom applies from the start (spec §12.2), and so does the
// last saved theme (its localStorage mirror, R3) until the settings load and take over.
installZoom();
// Over a file's or a diff's body, the zoom keys and Ctrl+wheel size its text instead.
installFontZoom();
bindThemeToSettings();

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
