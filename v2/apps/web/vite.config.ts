import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
const proxy = { '/api': { target: process.env.API_URL ?? 'http://127.0.0.1:3100', changeOrigin: false } };
export default defineConfig({ plugins: [react()], server: { port: 5180, host: '127.0.0.1', proxy }, preview: { port: 5180, proxy } });
