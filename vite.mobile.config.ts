import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// Tauri Android UI bundle. Built by host-core/build-mobile.js into mobile/build/web,
// which tauri.conf.json embeds into the :tauri_ui Rust library.
export default defineConfig({
  root: path.join(ROOT, 'mobile', 'web'),
  base: './',
  publicDir: path.join(ROOT, 'assets'),
  plugins: [react(), tailwindcss()],
  build: {
    outDir: path.join(ROOT, 'mobile', 'build', 'web'),
    emptyOutDir: true,
  },
});
