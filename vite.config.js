import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  root: 'public',
  publicDir: false,
  build: {
    outDir: '../dist', emptyOutDir: true, sourcemap: false,
    rolldownOptions: { input: ['index.html', 'privacy.html', 'terms.html'].map(page => fileURLToPath(new URL(`./public/${page}`, import.meta.url))) },
  },
});
