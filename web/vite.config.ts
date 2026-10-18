import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:4321',
        changeOrigin: true,
        // changeOrigin rewrites Host to the target, but Origin keeps pointing at
        // :5173, so the server's same-origin check rejects every write with 403.
        // Rewrite Origin alongside Host so the proxied request is consistent.
        headers: { origin: 'http://localhost:4321' },
        // SSE must not be buffered by the dev proxy
        configure: (proxy) => proxy.on('proxyRes', (res) => res.headers['cache-control'] === undefined),
      },
    },
  },
});
