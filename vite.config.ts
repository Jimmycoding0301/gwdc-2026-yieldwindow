import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ envDir: false, plugins: [react()], server: { port: 5176, strictPort: true, host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:8790' } } });
