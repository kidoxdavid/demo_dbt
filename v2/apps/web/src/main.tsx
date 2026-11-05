import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './styles/fonts.css'; import './styles/tokens.css'; import './styles/base.css'; import './styles/components.css';
import App from './App';
// Development and tests only: ?look=noir|sage|blush|sky|atelier previews a look. In production the look comes from the platform setting.
if (import.meta.env.DEV) { const l = new URLSearchParams(location.search).get('look'); if (l) document.documentElement.dataset.theme = l; const sc = new URLSearchParams(location.search).get('scheme'); if (sc) document.documentElement.dataset.scheme = sc; }
createRoot(document.getElementById('root')!).render(<StrictMode><BrowserRouter><App /></BrowserRouter></StrictMode>);
