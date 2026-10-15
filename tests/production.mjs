import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { createApp } from '../dist/server/apps/server/app.js';
import { initializeOwner } from '../dist/server/apps/server/auth.js';
const root = await mkdtemp(join(tmpdir(), 'dooknow-production-')),
  knowledgeRoot = join(root, 'knowledge'),
  dataRoot = join(root, 'data'),
  origin = 'http://127.0.0.1:4190',
  password = 'Production-Fixture-Only-0123';
const sentinel = 'PRIVATE_PRODUCTION_SENTINEL_4927';
await mkdir(join(knowledgeRoot, '00-Inbox'), { recursive: true });
await writeFile(join(knowledgeRoot, '00-Inbox/生产验证.md'), '# 生产验证\n\n' + sentinel);
const config = {
  knowledgeRoot,
  dataRoot,
  secret: 'production-fixture-only-at-least-32-characters',
  origin,
  staticRoot: resolve('dist/web'),
};
await initializeOwner(config, 'owner', password);
const app = await createApp(config);
let browser;
try {
  async function scan(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await scan(p);
      else {
        const bytes = await readFile(p);
        assert(!bytes.includes(Buffer.from(sentinel)), 'private note included in frontend');
        assert(!bytes.includes(Buffer.from(config.secret)), 'secret included in frontend');
        assert(!e.name.includes('.sqlite'), 'database included in frontend');
      }
    }
  }
  await scan(config.staticRoot);
  assert.equal((await app.inject({ url: '/' })).statusCode, 200);
  for (const url of [
    '/api/tree',
    '/api/search?q=private',
    '/api/notes',
    '/api/trash',
    '/api/assets/unknown',
    '/api/notes/unknown/revisions',
  ])
    assert.equal((await app.inject({ url })).statusCode, 401);
  for (const url of [
    '/apps/server/auth.ts',
    '/packages/core/db.ts',
    '/tests/support/credentials.ts',
    '/.env',
    '/.local/e2e-cookies.json',
    '/00-Inbox/生产验证.md',
    '/../apps/server/auth.ts',
  ])
    assert.equal((await app.inject({ url })).statusCode, 404);
  await app.listen({ host: '127.0.0.1', port: 4190 });
  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(origin);
  await page.getByLabel('用户名', { exact: true }).fill('owner');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: '生产验证.md', exact: true }).click();
  await page.locator('.cm-content').waitFor();
  assert(
    (await page.locator('.cm-content').innerText()).includes(sentinel),
    'production editor not reading original',
  );
  await page.getByRole('button', { name: '分享', exact: true }).click();
  await page.getByRole('button', { name: '生成分享链接' }).click();
  const input = page.getByRole('textbox', { name: '公开链接' });
  await input.waitFor();
  const url = await input.inputValue();
  const guest = await browser.newContext();
  const reader = await guest.newPage();
  await reader.goto(url);
  await reader.locator('.reader-title').waitFor();
  assert((await reader.locator('.markdown').innerText()).includes(sentinel));
  await writeFile(
    join(knowledgeRoot, '00-Inbox/生产验证.md'),
    '# 原文外部更新\n\nLIVE_PRODUCTION_CONTENT',
  );
  await reader.reload();
  await reader.getByRole('heading', { name: '原文外部更新', exact: true }).waitFor();
  await guest.close();
  console.log(
    '生产验证通过：构建资源无原文/密钥/数据库，匿名边界、生产登录与编辑、实时分享均通过。',
  );
} finally {
  if (browser) await browser.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
