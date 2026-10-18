import { test, expect } from '@playwright/test';
import { readFile, readdir, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { testPassword } from '../support/credentials.js';
test('first login binds an empty knowledge base and creates its first root note, category and nested note', async ({
  page,
}, info) => {
  const config = JSON.parse(await readFile('.local/setup-e2e.json', 'utf8'));
  config.knowledgeRoot = join(config.knowledgeRoot, '..', '我的知识库');

  await page.goto('/');
  await page.getByLabel('用户名', { exact: true }).fill('owner');
  await page.getByLabel('密码', { exact: true }).fill(testPassword);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '准备你的知识库' })).toBeVisible();
  await expect(page.getByLabel('知识库名称', { exact: true })).toHaveValue('我的知识库');
  await page.screenshot({
    path: `.local/onboarding-${info.project.name}-start.png`,
    fullPage: true,
  });
  await expect(page.getByLabel('服务器上的知识库目录', { exact: true })).toBeHidden();
  await page.getByRole('button', { name: '使用已有资料', exact: true }).click();
  await page.getByRole('button', { name: '打开文件夹 personal', exact: true }).click();
  await expect(
    page.getByText('已有文件会保留，不会清空这个文件夹。', { exact: true }),
  ).toBeVisible();
  await page.getByText('高级设置', { exact: true }).click();
  await page.getByLabel('服务器上的知识库目录', { exact: true }).fill(config.dataRoot);
  await page.getByRole('button', { name: '确认并继续', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('换一个保存位置');
  await page.getByRole('button', { name: '创建新知识库', exact: true }).click();
  await page.getByRole('button', { name: '确认并继续', exact: true }).click();
  await expect(page.getByRole('heading', { name: '选择需要的功能' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '让 ChatGPT 使用你的资料' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '记录文件版本' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '搜索资料内容' })).toBeVisible();
  await page.route('**/api/platform/plugins', (route) =>
    route.fulfill({
      json: {
        catalog: [
          { id: 'mcp', title: 'ChatGPT 连接', version: '1.0.0' },
          { id: 'git', title: '文件版本', version: '1.0.0' },
        ],
        installed: [
          {
            id: 'mcp',
            installedVersion: '1.0.0',
            state: 'disabled',
            configVersion: 3,
            config: { allowedPrefixes: ['00-Inbox'] },
            configuredSecrets: [],
            manifest: {
              title: 'ChatGPT 连接',
              configSchema: {
                properties: {
                  allowedPrefixes: { type: 'array', title: '允许的目录', default: [] },
                },
              },
            },
          },
        ],
        contributions: [],
      },
    }),
  );
  await page.route('**/api/platform/plugins/mcp/install', (route) => route.fulfill({ json: {} }));
  await page.getByRole('button', { name: '添加连接设置', exact: true }).click();
  const prefixes = page.getByRole('textbox', { name: '允许的目录', exact: true });
  await expect(prefixes).toHaveValue('[\n  "00-Inbox"\n]');
  await page.route('**/api/platform/plugins/git/install', (route) =>
    route.fulfill({ status: 503, json: { error: 'fixture unavailable' } }),
  );
  await page.getByRole('button', { name: '添加版本记录', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('可以先跳过');
  await page.route('**/api/platform/search-runtime', (route) =>
    route.fulfill({
      json: {
        externallyManaged: true,
        distributionAvailable: false,
        components: { tokenizerReady: false, vectorReady: false },
      },
    }),
  );
  await page.getByRole('button', { name: '设置内容搜索', exact: true }).click();
  await expect(page.getByText('内容搜索尚未就绪，可以稍后再设置。', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '设置内容搜索', exact: true }).click();
  await page.unroute('**/api/platform/plugins');
  await page.screenshot({
    path: `.local/onboarding-${info.project.name}-features.png`,
    fullPage: true,
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: '选择需要的功能' })).toBeVisible();
  await page.getByRole('button', { name: '暂时跳过', exact: true }).click();
  await expect(page.getByRole('heading', { name: '知识库准备好了' })).toBeVisible();
  await page.getByText('导入已有资料', { exact: true }).click();
  await page.getByLabel('选择 Markdown 文件', { exact: true }).setInputFiles({ name: '不支持.txt', mimeType: 'text/plain', buffer: Buffer.from('fixture') });
  await page.getByRole('button', { name: '确认导入', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('请选择 Markdown 文件');

  await page
    .getByLabel('选择 Markdown 文件', { exact: true })
    .setInputFiles({
      name: '已有资料.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# 我的已有资料\n\n原文会保留。\n'),
    });
  await page.getByRole('button', { name: '确认导入', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已有资料.md 已导入');
  expect(await readFile(join(config.knowledgeRoot, '40-Resources', '已有资料.md'), 'utf8')).toBe(
    '# 我的已有资料\n\n原文会保留。\n',
  );
  await page.screenshot({
    path: `.local/onboarding-${info.project.name}-complete.png`,
    fullPage: true,
  });
  await page.getByLabel('选择 Markdown 文件', { exact: true }).setInputFiles({ name: '已有资料.md', mimeType: 'text/markdown', buffer: Buffer.from('# 不应覆盖原文') });
  await page.getByRole('button', { name: '确认导入', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('已有同名文件');
  expect(await readFile(join(config.knowledgeRoot, '40-Resources', '已有资料.md'), 'utf8')).toBe('# 我的已有资料\n\n原文会保留。\n');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '创建第一篇笔记', exact: true }).click();
  const firstDialog = page.locator('.n-modal');
  await expect(firstDialog.getByRole('textbox', { name: '文件名', exact: true })).toHaveValue(
    'README.md',
  );
  await firstDialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.locator('.sidebar .brand')).toContainText('DooKnow');
  await page.reload();
  await expect(page.locator('.sidebar .brand')).toContainText('DooKnow');
  await expect(page.getByPlaceholder('/home/your-name/knowledge-base')).toHaveCount(0);

  await page.locator('.sidebar').getByRole('button', { name: '新建笔记', exact: true }).click();
  const dialog = page.locator('.n-modal');
  await expect(dialog.getByRole('textbox', { name: '文件名', exact: true })).toHaveValue(
    'README.md',
  );
  await expect(dialog.locator('.n-base-selection-label')).toContainText('知识库根目录');
  await expect(dialog).toContainText('根目录仅支持 README.md');
  await dialog.getByRole('button', { name: '创建', exact: true }).click();
  await expect(page.locator('.note-header h1')).toHaveText('README');
  expect(await readFile(join(config.knowledgeRoot, 'README.md'), 'utf8')).toBe('# README\n\n');

  if (info.project.name === 'mobile') await page.getByRole('button', { name: '打开侧栏' }).click();
  await page.getByRole('button', { name: '全部笔记', exact: true }).click();
  await page
    .locator('.folder-view')
    .getByRole('button', { name: '新建文件夹', exact: true })
    .click();
  await dialog.locator('.n-base-selection').click();
  await page.locator('.n-base-select-option').getByText('知识库根目录', { exact: true }).click();
  await dialog.getByRole('textbox', { name: '文件夹名', exact: true }).fill('00-Inbox');
  await dialog.getByRole('button', { name: '创建', exact: true }).click();
  await expect(page.getByText('文件夹已创建', { exact: true })).toBeVisible();
  expect((await readdir(config.knowledgeRoot)).sort()).toEqual([
    '00-Inbox',
    '40-Resources',
    'README.md',
  ]);

  await page.locator('.folder-view').getByRole('button', { name: '00-Inbox', exact: true }).click();
  await page.locator('.folder-view').getByRole('button', { name: '新建笔记', exact: true }).click();
  await expect(dialog.locator('.n-base-selection-label')).toContainText('00-Inbox');
  await dialog.getByRole('textbox', { name: '文件名', exact: true }).fill('第一篇笔记');
  await dialog.getByRole('button', { name: '创建', exact: true }).click();
  await expect(page.locator('.note-header h1')).toHaveText('第一篇笔记');
  expect(await readFile(join(config.knowledgeRoot, '00-Inbox/第一篇笔记.md'), 'utf8')).toBe(
    '# 第一篇笔记\n\n',
  );
});
