import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import { createApp } from '../../apps/server/app.js';
import { initializeOwner } from '../../apps/server/auth.js';
import { testPassword } from './credentials.js';
const root = await mkdtemp(join(tmpdir(), 'dooknow-setup-browser-'));
const knowledgeRoot = join(root, 'libraries/personal');
await mkdir(join(knowledgeRoot, '00-Inbox'), { recursive: true });
const config = { dataRoot: join(root, 'data'), secret: 'setup-e2e-fixture-secret-at-least-thirty-two-characters',
  origin: 'http://127.0.0.1:4178', allowedKnowledgeBases: [join(root, 'libraries')],
  indexing: { enabled: false, watch: false }, pluginCatalog: [] };
await initializeOwner(config, 'owner', testPassword);
const app = await createApp(config); await app.listen({ host: '127.0.0.1', port: 4181 });
await mkdir('.local', { recursive: true });
await writeFile('.local/setup-e2e.json', JSON.stringify({ knowledgeRoot, dataRoot: config.dataRoot }));
const vite = await createServer({ configFile: 'vite.config.ts', server: { host: '127.0.0.1', port: 4178,
  proxy: { '/api/': 'http://127.0.0.1:4181', '/plugins/': 'http://127.0.0.1:4181' } } });
await vite.listen();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  await vite.close(); await app.close(); await rm(root, { recursive: true, force: true }); process.exit(0);
});
