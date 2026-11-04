import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// Dev: /api is proxied to the API. Host header is preserved so the API's same-origin check passes.
export default defineConfig({ plugins: [react()], server: { port: 5173, proxy: { '/api': 'http://localhost:3000' } } });
