import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  base: '/',
  publicDir: '../assets',
  plugins: [react(), tailwindcss()],
  resolve: {
    dedupe: ['react', 'react-dom', '@radix-ui/react-dialog', 'lucide-react'],
  },
  server: {
    fs: {
      allow: ['..'],
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
