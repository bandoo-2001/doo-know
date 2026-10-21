import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const projectRoot = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig({
  plugins: [vue(), {
    name: 'dooknow-isolated-dev-cache',
    apply: 'serve',
    config(config, environment) {
      if (environment.isPreview || config.cacheDir !== undefined) return;
      return {
        cacheDir: resolve(projectRoot, `node_modules/.vite-dooknow-${config.server?.port ?? 5173}`),
      };
    },
  }, {
    name: 'dooknow-plugin-import-map',
    transformIndexHtml: { order: 'pre', handler: (_html, context) => [{
      tag: 'script', attrs: { type: 'importmap' }, children: JSON.stringify({ imports: context.server
        ? { vue: '/plugin-runtime.ts', '@dooknow/plugin-ui': '/@fs/' + resolve(projectRoot, 'packages/plugin-ui/index.ts') }
        : { vue: '/assets/plugin-runtime.js', '@dooknow/plugin-ui': '/assets/plugin-ui.js' } }), injectTo: 'head-prepend',
    }] },
  }],
  root: 'apps/web',
  // Async views must not depend on a stylesheet preload that cannot be retried.
  build: { manifest: true, cssCodeSplit: false, outDir: resolve(projectRoot, 'dist/web'), emptyOutDir: true, rollupOptions: {
    input: { app: resolve(projectRoot, 'apps/web/index.html'), 'plugin-runtime': resolve(projectRoot, 'apps/web/plugin-runtime.ts'), 'plugin-ui': resolve(projectRoot, 'packages/plugin-ui/index.ts') },
    preserveEntrySignatures: 'strict',
    output: { entryFileNames: 'assets/[name].js' },
  } },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.VITE_PORT || 5173),
    strictPort: true,
    fs: {
      allow: ['apps/web', 'node_modules', 'shared', 'packages/plugin-ui', 'packages/plugin-contracts'].map((path) => resolve(projectRoot, path)),
      deny: [
        '**/.env',
        '**/.env.*',
        '**/.git/**',
        '**/.local/**',
        '**/tests/**',
        '**/server/**',
        '**/packages/core/**',
        '**/scripts/**',
        '**/*.sqlite*',
        '**/*.key',
        '**/*.pem',
      ],
    },
    proxy: {
      '/api/': 'http://127.0.0.1:' + (process.env.PORT || 3010),
      '/plugins/': 'http://127.0.0.1:' + (process.env.PORT || 3010),
    },
  },
});
