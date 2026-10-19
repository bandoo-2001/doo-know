import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { loadConfig } from '../apps/server/config.js';
import { createApp } from '../apps/server/app.js';
// @ts-expect-error build tool is plain ESM
import { buildPlugins } from './build-plugins.mjs';
const config = loadConfig();
config.staticRoot = undefined;
if (!process.env.APP_ORIGIN)
  config.origin = 'http://127.0.0.1:' + (process.env.VITE_PORT || '5173');
const pluginCatalog = await buildPlugins({ output: resolve('.local/dev-plugin-artifacts') });
const app = await createApp({ ...config, pluginCatalog });
await app.listen({ host: '127.0.0.1', port: config.port });
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit' });
async function stop() {
  vite.kill('SIGTERM');
  await app.close();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
vite.on('exit', stop);
