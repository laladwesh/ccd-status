import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The app is served under /ccd-status/ both on the host nginx and behind the IITG proxy,
// so the same build works in both places.
export default defineConfig({
  base: '/ccd-status/',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/ccd-status/api': { target: 'http://127.0.0.1:4000', rewrite: (p) => p.replace('/ccd-status', '') },
    },
  },
  build: { outDir: 'dist', chunkSizeWarningLimit: 1500 },
});
