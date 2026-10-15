import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import { createApp } from '../../server/app.js';
import { initializeOwner } from '../../server/auth.js';
import { testPassword } from './credentials.js';
import { pluginFixture } from './plugin-fixture.js';
const root = await mkdtemp(join(tmpdir(), 'dooknow-browser-'));
const knowledgeRoot = join(root, 'knowledge'),
  dataRoot = join(root, 'data');
await mkdir(join(knowledgeRoot, '30-Knowledge/个人知识管理/方法'), { recursive: true });
await mkdir(join(knowledgeRoot, '00-Inbox'), { recursive: true });
await writeFile(
  join(knowledgeRoot, '30-Knowledge/个人知识管理/方法/入门指南.md'),
  '# 搭建自己的知识库\n\n## 整理方法\n\n- 收集值得保留的想法\n- 按主题整理笔记\n\n> 让知识慢慢积累。\n\n| 步骤 | 内容 |\n| --- | --- |\n| 收集 | 记录想法 |',
);
await mkdir('.local', { recursive: true });
await writeFile('.local/e2e-config.json', JSON.stringify({ knowledgeRoot, dataRoot }));
const config = {
  knowledgeRoot,
  dataRoot,
  secret: 'e2e-only-at-least-thirty-two-character-secret',
  origin: 'http://127.0.0.1:4179',
  pluginCatalog: [await pluginFixture(root)],
  ...(process.env.DOOKNOW_E2E_PRODUCTION === '1' ? { staticRoot: resolve('dist/web') } : {}),
};
await initializeOwner(config, 'owner', testPassword);
const app = await createApp(config);
await app.listen({ host: '127.0.0.1', port: process.env.DOOKNOW_E2E_PRODUCTION === '1' ? 4179 : 4180 });
const login = await app.inject({
  method: 'POST',
  url: '/api/auth/sign-in/username',
  headers: { origin: config.origin },
  payload: { username: 'owner', password: testPassword },
});
if (login.statusCode !== 200) throw new Error('e2e session initialization failed');
await writeFile(
  '.local/e2e-cookies.json',
  JSON.stringify(
    login.cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
    })),
  ),
  { mode: 0o600 },
);
const vite = process.env.DOOKNOW_E2E_PRODUCTION === '1' ? undefined : await createServer({
  configFile: 'vite.config.ts',
  server: { port: 4179, host: '127.0.0.1', proxy: { '/api/': 'http://127.0.0.1:4180', '/plugins/': 'http://127.0.0.1:4180' } },
});
await vite?.listen();
for (const s of ['SIGINT', 'SIGTERM'])
  process.on(s, async () => {
    await vite?.close();
    await app.close();
    await rm(root, { recursive: true, force: true });
    process.exit(0);
  });
