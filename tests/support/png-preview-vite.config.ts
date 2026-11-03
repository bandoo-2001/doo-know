import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  cacheDir: fileURLToPath(new URL('../../node_modules/.vite-png-preview', import.meta.url)),
  root: fileURLToPath(new URL('../fixtures/png-preview-privacy', import.meta.url)),
  server: { fs: { allow: [fileURLToPath(new URL('../..', import.meta.url))] } },
});
