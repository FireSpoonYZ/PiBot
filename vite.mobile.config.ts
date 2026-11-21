import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BOOT_INSETS_SRC = path.join(ROOT, 'mobile', 'web', 'public', 'boot-insets.js');

function mobileBootInsetsPlugin(): Plugin {
  return {
    name: 'mobile-boot-insets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = req.url?.split('?')[0];
        if (pathname !== '/boot-insets.js') {
          next();
          return;
        }
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        res.end(fs.readFileSync(BOOT_INSETS_SRC, 'utf8'));
      });
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'boot-insets.js',
        source: fs.readFileSync(BOOT_INSETS_SRC, 'utf8'),
      });
    },
  };
}

// Tauri Android UI bundle. Built by host-core/build-mobile.js into mobile/build/web,
// which tauri.conf.json embeds into the :tauri_ui Rust library.
export default defineConfig({
  root: path.join(ROOT, 'mobile', 'web'),
  base: './',
  publicDir: path.join(ROOT, 'assets'),
  plugins: [react(), tailwindcss(), mobileBootInsetsPlugin()],
  build: {
    outDir: path.join(ROOT, 'mobile', 'build', 'web'),
    emptyOutDir: true,
  },
});
