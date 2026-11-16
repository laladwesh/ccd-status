import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The app is served under BASE_PATH (default /ccd-status) both on the host nginx and behind the IITG
// proxy, so the same build works in both places. Docker passes it as a build arg.
const BASE = (process.env.BASE_PATH || '/ccd-status').replace(/\/+$/, '');

export default defineConfig({
  base: `${BASE}/`,
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      [`${BASE}/api`]: { target: 'http://127.0.0.1:4000', rewrite: (p) => p.replace(BASE, '') },
    },
  },
  build: { outDir: 'dist', chunkSizeWarningLimit: 1500 },
});
