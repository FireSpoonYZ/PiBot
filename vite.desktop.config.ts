import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.join(ROOT, 'desktop', 'web'),
  base: './',
  publicDir: path.join(ROOT, 'assets'),
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
  },
  build: {
    outDir: path.join(ROOT, 'desktop', 'build', 'web'),
    emptyOutDir: true,
  },
});
