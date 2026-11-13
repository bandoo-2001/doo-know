import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import { createApp } from '../../apps/server/app.js';
import { initializeOwner } from '../../apps/server/auth.js';
import { testPassword } from './credentials.js';
import { createSetupGitFixture } from './setup-git-fixture.js';
// @ts-expect-error build utility is plain ESM
import { buildPlugins } from '../../scripts/build-plugins.mjs';

const root = await mkdtemp(join(tmpdir(), 'dooknow-setup-browser-'));
const pluginCatalog = await buildPlugins({
  output: join(root, 'official-plugins'),
  ids: ['mcp', 'git'],
});
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let generation = 0;
async function reset() {
  await app?.close();
  const fixtureRoot = join(root, String(++generation));
  const knowledgeRoot = join(fixtureRoot, 'libraries/personal');
  await mkdir(join(knowledgeRoot, '00-Inbox'), { recursive: true });
  await writeFile(join(knowledgeRoot, '00-Inbox/已有笔记.md'), '# 已有笔记\n\n保留原文。\n');
  const git = await createSetupGitFixture(fixtureRoot);
  const config = {
    dataRoot: join(fixtureRoot, 'data'),
    secret: 'setup-e2e-fixture-secret-at-least-thirty-two-characters',
    origin: 'http://127.0.0.1:4178',
    allowedOrigins: ['http://setup.audit.test:4178'],
    allowedKnowledgeBases: [join(fixtureRoot, 'libraries')],
    indexing: { enabled: false, watch: false },
    pluginCatalog,
  };
  await initializeOwner(config, 'owner', testPassword);
  app = await createApp(config, { gitExec: git.gitExec });
  await app.listen({ host: '127.0.0.1', port: 4181 });
  await mkdir('.local', { recursive: true });
  await writeFile(
    '.local/setup-e2e.json',
    JSON.stringify({
      knowledgeRoot,
      dataRoot: config.dataRoot,
      fixtureRoot,
      remoteUrl: git.remoteUrl,
      giteeRemoteUrl: git.giteeRemoteUrl,
    }),
  );
  return {
    knowledgeRoot,
    dataRoot: config.dataRoot,
    remoteUrl: git.remoteUrl,
    giteeRemoteUrl: git.giteeRemoteUrl,
  };
}
await reset();
const vite = await createServer({
  configFile: 'vite.config.ts',
  cacheDir: join(root, 'vite-cache'),
  plugins: [
    {
      name: 'isolated-setup-fixture',
      configureServer(server) {
        // Test server is bound to loopback only. This endpoint is never in a release.
        server.middlewares.use('/__test/setup/reset', async (req, res) => {
          if (req.method !== 'POST') {
            res.statusCode = 405;
            res.end();
            return;
          }
          try {
            const fixture = await reset();
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(fixture));
          } catch {
            res.statusCode = 500;
            res.end('fixture reset failed');
          }
        });
      },
    },
  ],
  server: {
    host: '127.0.0.1',
    port: 4178,
    strictPort: true,
    allowedHosts: ['setup.audit.test'],
    proxy: { '/api/': 'http://127.0.0.1:4181', '/plugins/': 'http://127.0.0.1:4181' },
  },
});
await vite.listen();
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, async () => {
    await vite.close();
    await app?.close();
    await rm(root, { recursive: true, force: true });
    process.exit(0);
  });
