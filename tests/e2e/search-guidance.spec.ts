import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { test, expect } from '../support/browser-test';
import { showSidebar } from '../support/settings-navigation';

test.use({ sourceEditorPreference: true });

async function selectSearchOption(page: Page, label: string, option: string) {
  const input = page.getByRole('combobox', { name: label, exact: true });
  await input.focus();
  await input.press('ArrowDown');
  await page.locator('.ant-select-dropdown:visible').getByText(option, { exact: true }).click();
}

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

test('候选预算已满时明确提示缩小范围，不误报组件未准备好', async ({ page }) => {
  await page.route('**/api/search/advanced', (route) => route.fulfill({ json: {
    results: [], degraded: true, reasons: ['RECALL_LIMIT'], index: { pending: 0 },
  } }));
  await page.goto('/');
  await showSidebar(page);
  await page.getByRole('textbox', { name: '搜索笔记与目录', exact: true }).fill('候选预算-'+crypto.randomUUID());
  const feedback = page.locator('.tree-scroll').getByRole('status').filter({ hasText: '候选上限' });
  await expect(feedback).toBeVisible();
  await expect(feedback).toContainText('缩小目录范围');
  await expect(feedback).not.toContainText('未准备好');
  await expect(page.getByRole('button', { name: '检查搜索设置', exact: true })).toHaveCount(0);
  await expect(page.getByText('没有匹配的笔记', { exact: true })).toHaveCount(0);
});

test('limited content search explains an empty result and keeps the query when returning from settings', async ({
  page,
}) => {
  let limited = true;
  await page.route('**/api/search/advanced', (route) =>
    route.fulfill({
      json: {
        results: [],
        degraded: limited,
        reasons: limited ? ['TOKENIZER_UNAVAILABLE', 'VECTOR_NOT_CONFIGURED'] : [],
        index: { pending: 0 },
      },
    }),
  );
  await page.route('**/api/platform/search-runtime', (route) =>
    route.fulfill({
      json: {
        externallyManaged: true,
        distributionAvailable: false,
        components: { tokenizerReady: false, vectorReady: false },
      },
    }),
  );
  await page.goto('/');
  await showSidebar(page);
  await expect(
    page.locator('.sidebar-create').getByRole('button', { name: '新建笔记', exact: true }),
  ).toBeEnabled();
  const query = '本次尚未索引的内容-' + crypto.randomUUID();
  await page.getByRole('textbox', { name: '搜索笔记与目录', exact: true }).fill(query);
  await expect(page.locator('.tree-scroll')).toContainText(
    '部分内容搜索或索引尚未准备好，结果可能不完整。',
  );
  await expect(page.getByText('没有匹配的笔记', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '检查搜索设置', exact: true }).click();
  await expect(page.locator('.settings-workspace')).toBeVisible();
  await expect(page.locator('.settings-workspace')).toContainText('依赖未准备');
  await page
    .locator('.settings-workspace')
    .getByRole('button', { name: '返回笔记', exact: true })
    .click();
  await showSidebar(page);
  await expect(page.getByRole('textbox', { name: '搜索笔记与目录', exact: true })).toHaveValue(
    query,
  );
  await expect(page.getByRole('button', { name: '检查搜索设置', exact: true })).toBeVisible();
  await expect(page.getByText('没有匹配的笔记', { exact: true })).toHaveCount(0);
  limited = false;
  await page.getByRole('textbox', { name: '搜索笔记与目录', exact: true }).fill(query + '-新查询');
  await expect(page.getByText('没有匹配的笔记', { exact: true })).toBeVisible();
  await expect(
    page.getByText('部分内容搜索或索引尚未准备好，结果可能不完整。', { exact: false }),
  ).toHaveCount(0);
});

test('a missing search component can be prepared and the original filtered search resumed', async ({
  page,
}) => {
  let prepared = false;
  const tree = await (await page.request.get('/api/tree')).json();
  const entries = (items: any[]): any[] =>
    items.flatMap((item) => [item, ...entries(item.children || [])]);
  const note = entries(tree).find(
    (item) => item.path === '30-Knowledge/个人知识管理/方法/入门指南.md',
  );
  expect(note?.id).toBeTruthy();
  await page.route('**/api/tree', (route) =>
    route.fulfill({
      json: [
        {
          type: 'folder',
          name: '30-Knowledge',
          path: '30-Knowledge',
          children: [
            {
              type: 'folder',
              name: '个人知识管理',
              path: '30-Knowledge/个人知识管理',
              children: [
                {
                  type: 'folder',
                  name: '方法',
                  path: '30-Knowledge/个人知识管理/方法',
                  children: [note],
                },
              ],
            },
          ],
        },
      ],
    }),
  );
  await page.route('**/api/platform/search-runtime', (route) =>
    route.fulfill({
      json: {
        externallyManaged: false,
        distributionAvailable: true,
        components: { tokenizerReady: prepared, vectorReady: prepared },
      },
    }),
  );
  await page.route('**/api/platform/search-runtime/prepare', (route) => {
    prepared = true;
    return route.fulfill({ json: {} });
  });
  await page.route('**/api/search/advanced', (route) =>
    prepared
      ? route.fulfill({
          json: {
            results: [
              {
                noteId: note.id,
                title: '内容命中结果',
                relativePath: note.path,
                matches: [{ snippet: '准备完成后找到的内容', startLine: 1 }],
              },
            ],
            degraded: false,
            index: { pending: 0 },
          },
        })
      : route.fulfill({
          status: 503,
          json: { code: 'TOKENIZER_UNAVAILABLE', error: '本地分词进程不可用' },
        }),
  );
  await page.goto('/');
  await showSidebar(page);
  await expect(
    page.locator('.sidebar-create').getByRole('button', { name: '新建笔记', exact: true }),
  ).toBeEnabled();
  const query = '入门指南';
  await page.getByRole('textbox', { name: '搜索笔记与目录', exact: true }).fill(query);
  await selectSearchOption(page, '搜索模式', '文本检索');
  const directory = page.getByRole('combobox', { name: '搜索目录', exact: true });
  await directory.focus();
  await directory.press('ArrowDown');
  await directory.fill('30-Knowledge/个人知识管理/方法');
  await page.locator('.directory-tree-popup:visible').getByTitle('方法', { exact: true }).click();
  const result = page.locator('.search-result').filter({ hasText: note.path });
  await expect(result).toBeVisible();
  await expect(page.locator('.tree-scroll').getByRole('alert')).toContainText(
    '内容搜索组件还未准备好，文件名搜索仍可使用。',
  );
  await page.getByRole('button', { name: '检查搜索设置', exact: true }).click();
  await expect(page.locator('.settings-workspace')).toBeVisible();
  await page.getByRole('button', { name: '准备本地检索', exact: true }).click();
  await expect(page.locator('.runtime-components .component-status').first()).toHaveText('可用');
  await page
    .locator('.settings-workspace')
    .getByRole('button', { name: '返回笔记', exact: true })
    .click();
  await showSidebar(page);
  await expect(page.getByRole('textbox', { name: '搜索笔记与目录', exact: true })).toHaveValue(
    query,
  );
  await expect(page.locator('.search-options .ant-select-selection-item')).toHaveText([
    '文本检索',
    '30-Knowledge/个人知识管理/方法',
  ]);
  await expect(result).toBeVisible();
  const retry = page.waitForRequest(
    (request) => new URL(request.url()).pathname === '/api/search/advanced',
  );
  await page.getByRole('button', { name: '重试搜索', exact: true }).click();
  expect((await retry).postDataJSON()).toMatchObject({
    query,
    mode: 'text',
    filters: { directory: '30-Knowledge/个人知识管理/方法' },
  });
  await expect(result).toContainText('准备完成后找到的内容');
  await result.click();
  await expect(page).toHaveURL(new RegExp('note=' + note.id));
  await expect(page.locator('.cm-content')).toBeVisible();
});

test('unprepared semantic search offers settings and a preserved query without reporting no matches', async ({
  page,
}) => {
  await page.route('**/api/search/advanced', (route) =>
    route.fulfill({ status: 503, json: { code: 'VECTOR_NOT_CONFIGURED' } }),
  );
  await page.route('**/api/platform/search-runtime', (route) =>
    route.fulfill({
      json: {
        externallyManaged: true,
        distributionAvailable: false,
        components: { tokenizerReady: true, vectorReady: false },
      },
    }),
  );
  await page.goto('/');
  await showSidebar(page);
  await expect(
    page.locator('.sidebar-create').getByRole('button', { name: '新建笔记', exact: true }),
  ).toBeEnabled();
  const query = '按意思寻找旧笔记';
  await page.getByRole('textbox', { name: '搜索笔记与目录', exact: true }).fill(query);
  await selectSearchOption(page, '搜索模式', '语义检索（需准备）');
  await expect(page.locator('.tree-scroll').getByRole('alert')).toContainText(
    '按意思搜索还未准备好，文件名搜索仍可使用。',
  );
  await expect(page.getByText('没有匹配的笔记', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '检查搜索设置', exact: true }).click();
  await expect(page.locator('.settings-workspace')).toBeVisible();
  await page
    .locator('.settings-workspace')
    .getByRole('button', { name: '返回笔记', exact: true })
    .click();
  await showSidebar(page);
  await expect(page.getByRole('textbox', { name: '搜索笔记与目录', exact: true })).toHaveValue(
    query,
  );
  await expect(page.locator('.search-options .ant-select-selection-item').first()).toHaveText(
    '语义检索（需准备）',
  );
});
