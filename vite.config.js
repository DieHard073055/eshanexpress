import { defineConfig } from 'vite';

// base is set from the repo name at build time for GitHub Pages project sites.
// Override with BASE_PATH env var; defaults to '/' for local dev.
export default defineConfig({
  base: process.env.BASE_PATH || '/',
  build: { outDir: 'dist', emptyOutDir: true },
});
