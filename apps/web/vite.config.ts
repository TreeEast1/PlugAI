import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');

export default defineConfig({
  // GitHub Pages serves a project site at /<repo>/, so the base is injected at build time.
  // Local `npm run dev` keeps base "/".
  base: process.env.PLUGAI_BASE || '/',
  plugins: [react()],
  resolve: {
    alias: {
      '@plugai/shared': resolve(root, 'packages/shared/src/index.ts'),
    },
  },
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false },
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
    },
  },
  build: { outDir: 'dist', chunkSizeWarningLimit: 2000 },
});
