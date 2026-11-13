import { test, expect, type Page } from '@playwright/test';
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { testPassword } from '../support/credentials.js';

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('用户名', { exact: true }).fill('owner');
  await page.getByLabel('密码', { exact: true }).fill(testPassword);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '准备你的知识库', exact: true })).toBeVisible();
}
async function create(page: Page, name: string) {
  await page.getByLabel('知识库名称', { exact: true }).fill(name);
  await page.getByRole('button', { name: '确认并继续', exact: true }).click();
  await expect(page.getByRole('heading', { name: '选择需要的功能', exact: true })).toBeVisible();
}
test.beforeEach(async ({ request }) => {
  expect((await request.post('/__test/setup/reset')).ok()).toBe(true);
});

test('new library handles invalid names, conflicts and timezone correction without creating twice', async ({
  page,
}) => {
  await login(page);
  await page.getByLabel('知识库名称', { exact: true }).fill('../invalid');
  await page.getByRole('button', { name: '确认并继续', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('知识库名称');
  await page.getByLabel('知识库名称', { exact: true }).fill('personal');
  await page.getByRole('button', { name: '确认并继续', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('已经存在');
  await page.getByLabel('知识库名称', { exact: true }).fill('时区重试');
  await page.getByText('高级设置', { exact: true }).click();
  await page.getByLabel('时区', { exact: true }).fill('Invalid/Zone');
  let creates = 0;
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === '/api/platform/setup/create' && r.method() === 'POST')
      creates++;
  });
  await page.getByRole('button', { name: '确认并继续', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('时区无法使用');
  await page.getByLabel('时区', { exact: true }).fill('Asia/Shanghai');
  await page.getByRole('button', { name: '确认并继续', exact: true }).click();
  await expect(page.getByRole('heading', { name: '选择需要的功能', exact: true })).toBeVisible();
  expect(creates).toBe(1);
  const f = JSON.parse(await readFile('.local/setup-e2e.json', 'utf8'));
  expect(
    (await readdir(join(dirname(f.knowledgeRoot), '时区重试'))).filter(
      (name) => name !== '_doo-data',
    ),
  ).toEqual([]);
  await page.getByRole('button', { name: '暂时跳过', exact: true }).click();
  await page.getByRole('button', { name: '上一步', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('heading', { name: '选择需要的功能', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await page.getByRole('button', { name: '进入工作区', exact: true }).click();
  await expect(page.locator('.sidebar .brand')).toContainText('DooKnow');
  await page.reload();
  await expect(page.locator('.sidebar .brand')).toContainText('DooKnow');
});

test('existing library rejects forbidden paths, browses folders and preserves original notes', async ({
  page,
}) => {
  const f = JSON.parse(await readFile('.local/setup-e2e.json', 'utf8'));
  await login(page);
  await page.getByRole('button', { name: '使用已有资料', exact: true }).click();
  await page.getByText('高级设置', { exact: true }).click();
  await page.getByLabel('服务器上的知识库目录', { exact: true }).fill(f.dataRoot);
  await page.getByRole('button', { name: '确认并继续', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('换一个保存位置');
  await page.getByRole('button', { name: '打开文件夹 personal', exact: true }).click();
  await page.getByRole('button', { name: '使用这个文件夹', exact: true }).click();
  await page.getByRole('button', { name: '确认并继续', exact: true }).click();
  await expect(page.getByRole('heading', { name: '选择需要的功能', exact: true })).toBeVisible();
  expect(await readFile(join(f.knowledgeRoot, '00-Inbox/已有笔记.md'), 'utf8')).toBe(
    '# 已有笔记\n\n保留原文。\n',
  );
  await page.getByRole('button', { name: '暂时跳过', exact: true }).click();
  await page.getByRole('button', { name: '进入工作区', exact: true }).click();
  await page
    .locator('.tree-scroll')
    .getByRole('button', { name: '展开 00-Inbox', exact: true })
    .click();
  await expect(page.locator('.tree-scroll')).toContainText('已有笔记');
});

test('a lost setup response can be retried without duplicating or stranding the library', async ({
  page,
}) => {
  await login(page);
  let lost = false;
  await page.route('**/api/platform/setup/complete', async (route) => {
    if (!lost) {
      lost = true;
      const r = await route.fetch();
      expect(r.ok()).toBe(true);
      await route.abort('failed');
    } else await route.continue();
  });
  await page.getByLabel('知识库名称', { exact: true }).fill('断网恢复');
  await page.getByRole('button', { name: '确认并继续', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByRole('button', { name: '确认并继续', exact: true }).click();
  await expect(page.getByRole('heading', { name: '选择需要的功能', exact: true })).toBeVisible();
  const f = JSON.parse(await readFile('.local/setup-e2e.json', 'utf8'));
  expect(
    (await readdir(dirname(f.knowledgeRoot))).filter((n: string) => n.startsWith('断网恢复')),
  ).toEqual(['断网恢复']);
});

test('Markdown import rejects oversize and malformed UTF-8 and retries a lost save without overwriting', async ({
  page,
}) => {
  await login(page);
  await create(page, '文件导入');
  await page.getByRole('button', { name: '暂时跳过', exact: true }).click();
  await page.getByText('导入已有资料', { exact: true }).click();
  const file = page.getByLabel('选择 Markdown 文件', { exact: true });
  const upload = page.getByRole('button', { name: '确认导入', exact: true });
  await file.setInputFiles({
    name: 'too-large.md',
    mimeType: 'text/markdown',
    buffer: Buffer.alloc(256 * 1024 + 1, 65),
  });
  await upload.click();
  await expect(page.getByRole('alert')).toContainText('256 KiB');
  await file.setInputFiles({
    name: 'encoding.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from([0xff, 0xfe, 0x80]),
  });
  await upload.click();
  await expect(page.getByRole('alert')).toContainText('UTF-8');
  let lost = false;
  await page.route('**/api/notes', async (route) => {
    if (route.request().method() === 'POST' && !lost) {
      lost = true;
      const r = await route.fetch();
      expect(r.ok()).toBe(true);
      await route.abort('failed');
    } else await route.continue();
  });
  await file.setInputFiles({
    name: '网络重试.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# 同一份原文\n'),
  });
  await upload.click();
  await expect(page.getByRole('alert')).toContainText('暂时没能导入');
  await upload.click();
  await expect(page.getByRole('status')).toContainText('网络重试.md 已导入');
  const f = JSON.parse(await readFile('.local/setup-e2e.json', 'utf8'));
  const library = join(dirname(f.knowledgeRoot), '文件导入');
  expect(await readdir(join(library, '40-Resources'))).toEqual(['网络重试.md']);
  expect(await readFile(join(library, '40-Resources/网络重试.md'), 'utf8')).toBe('# 同一份原文\n');
});
