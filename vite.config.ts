import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// ต้นและเพชร Tennis Club (Ton & Phet Tennis Club) — Vite config (mobile-first web app)
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8080',
    },
  },
  build: {
    target: 'es2020',
    sourcemap: true,
  },
});
