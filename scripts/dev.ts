import { spawn } from 'node:child_process';
import { loadConfig } from '../server/config.js';
import { createApp } from '../server/app.js';
const config = loadConfig();
config.staticRoot = undefined;
const app = await createApp(config);
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
