import { test, expect } from '../support/browser-test';
import { readFile } from 'node:fs/promises';

test.use({ sourceEditorPreference: true });

test.beforeEach(async ({ page, context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.goto('/');
  await expect(page.locator('.sidebar')).toBeVisible();
});

test('shows search progress and a local retry without claiming there are no matches', async ({
  page,
}) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/search/advanced', async (route) => {
    await held;
    await route.fulfill({ status: 503, json: { message: '搜索暂时不可用' } });
  });
  try {
    await page.getByPlaceholder('搜索笔记与目录').fill('回顾');
    await expect(page.locator('.tree-scroll').getByRole('status')).toContainText('正在搜索');
    await expect(page.getByText('没有匹配的笔记', { exact: true })).toBeHidden();
  } finally {
    release();
  }
  await expect(page.locator('.tree-scroll').getByRole('alert')).toBeVisible();
  await expect(page.getByRole('button', { name: '重试搜索', exact: true })).toBeVisible();
  await page.getByPlaceholder('搜索笔记与目录').clear();
  await expect(page.locator('.tree-scroll').getByRole('alert')).toBeHidden();
});

test('keeps a create failure in the dialog and blocks duplicate submissions', async ({ page }) => {
  let release!: () => void,
    requests = 0;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/notes', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    requests++;
    await held;
    await route.fulfill({ status: 503, json: { message: '创建暂时不可用' } });
  });
  await page.locator('.sidebar').getByRole('button', { name: '新建笔记', exact: true }).click();
  const dialog = page.locator('.n-modal').filter({ hasText: '所在目录' });
  await page.getByRole('textbox', { name: '文件名', exact: true }).fill('新想法.md');
  const create = dialog.getByRole('button', { name: '创建', exact: true });
  try {
    await create.click();
    await expect(create).toBeDisabled();
    await dialog.locator('form').dispatchEvent('submit');
  } finally {
    release();
  }
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('textbox', { name: '文件名', exact: true })).toHaveValue('新想法.md');
  expect(requests).toBe(1);
});

async function openFeedbackNote(page: import('@playwright/test').Page) {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const response = await page.request.post('/api/notes', {
    headers: { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token },
    data: {
      folderPath: '00-Inbox',
      fileName: `反馈检查-${Date.now()}.md`,
      content: '# 反馈检查\n\n原文保持。',
      requestId: crypto.randomUUID(),
    },
  });
  expect(response.status()).toBe(201);
  const note = await response.json();
  await page.goto('/?note=' + encodeURIComponent(note.id));
  await expect(page.locator('.cm-content')).toBeVisible();
  return note;
}

test('reports share errors inside the dialog and locks the submitted action', async ({ page }) => {
  const note = await openFeedbackNote(page);
  await page.getByRole('button', { name: '分享', exact: true }).click();
  let release!: () => void,
    requests = 0;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(`**/api/notes/${note.id}/share`, async (route) => {
    requests++;
    await held;
    await route.fulfill({ status: 503, json: { message: '分享暂时不可用' } });
  });
  const create = page.locator('.share-dialog').getByRole('button', { name: /生成分享链接$/ });
  try {
    await create.click();
    await expect(create).toBeDisabled();
  } finally {
    release();
  }
  await expect(page.locator('.share-dialog').getByRole('alert')).toBeVisible();
  await expect(create).toBeEnabled();
  expect(requests).toBe(1);
});

test('keeps a revision read error visible in the history dialog', async ({ page }) => {
  const note = await openFeedbackNote(page);
  await page.route(`**/api/notes/${note.id}/revisions`, (route) =>
    route.fulfill({
      json: { items: [{ id: 'history-feedback', createdAt: new Date().toISOString() }] },
    }),
  );
  await page.route(`**/api/notes/${note.id}/revisions/history-feedback/read`, (route) =>
    route.fulfill({ status: 503, json: { message: '历史片段暂时不可用' } }),
  );
  await page.getByRole('button', { name: '更多操作', exact: true }).click();
  await page.getByRole('button', { name: '历史版本', exact: true }).click();
  const dialog = page.locator('.n-modal').filter({ hasText: '恢复前会保留当前原文' });
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(dialog.getByRole('button', { name: '重试读取', exact: true })).toBeVisible();
});

test('explains a failed save in the leave dialog while preserving the draft', async ({
  page,
}, info) => {
  const note = await openFeedbackNote(page);
  await page.locator('.cm-content').fill('# 尚未保存的想法\n\n草稿仍应保留。');
  await page.route(`**/api/notes/${note.id}`, async (route) => {
    if (route.request().method() === 'PUT')
      await route.fulfill({ status: 503, json: { message: '保存暂时不可用' } });
    else await route.continue();
  });
  if (info.project.name === 'mobile')
    await page.getByRole('button', { name: '打开侧栏', exact: true }).click();
  await page.locator('.tree-scroll').getByRole('button', { name: '00-Inbox', exact: true }).click();
  const dialog = page.locator('.n-modal').filter({ hasText: '离开前，请选择如何处理当前编辑内容' });
  await dialog.getByRole('button', { name: '保存并继续', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(page.locator('.cm-content')).toContainText('草稿仍应保留');
});
