import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
    plugins: [react()],
    base: './',
    build: {
        outDir: '../extension/out/webview',
        emptyOutDir: true,
        sourcemap: true,
        cssCodeSplit: false,
    },
    server: {
        port: 3000,
        strictPort: false,
    },
});
