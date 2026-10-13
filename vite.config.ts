import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const projectRoot = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig({
  plugins: [vue()],
  root: 'web',
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    fs: {
      allow: ['web', 'node_modules', 'shared'].map((path) => resolve(projectRoot, path)),
      deny: [
        '**/.env',
        '**/.env.*',
        '**/.git/**',
        '**/.local/**',
        '**/tests/**',
        '**/server/**',
        '**/scripts/**',
        '**/*.sqlite*',
        '**/*.key',
        '**/*.pem',
      ],
    },
    proxy: { '/api/': 'http://127.0.0.1:3010' },
  },
});
