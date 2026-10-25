import { configurePlugin, returnToNotes } from '../support/settings-navigation';
import { expandFolderPath } from '../support/notebook-tree';
import { clickNoteAction } from '../support/note-actions';
import { test, expect } from '../support/browser-test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
test('installs Git interactions, initializes when missing, previews all changes and displays real history', async ({
  page,
  context,
}, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const mobile = info.project.name === 'mobile';
  await page.goto('/');
  await configurePlugin(page, 'Git 版本管理');
  await page.getByLabel('提交作者', { exact: true }).fill('Browser Fixture');
  await page.getByLabel('作者邮箱', { exact: true }).fill('browser@example.invalid');
  await page.getByRole('button', { name: '保存插件配置', exact: true }).click();
  const enable = page
    .locator('.plugin-settings')
    .getByRole('button', { name: '启用插件', exact: true });
  if (await enable.isVisible()) await enable.click();
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const headers = { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token };
  const statusResponse = await page.request.post('/api/plugins/git/call', {
    headers,
    data: { kind: 'provider', id: 'git.status', input: {} },
  });
  expect(statusResponse.status()).toBe(200);
  const status = await statusResponse.json();
  if (status.repository === 'missing') {
    await expect(page.getByText('尚未建立 Git 仓库', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '初始化 Git 仓库（main）', exact: true }).click();
  } else {
    expect(status.repository).toBe('ready');
    expect(status.branch).toBe('main');
  }
  await expect(page.getByText('当前分支：main', { exact: true })).toBeVisible({ timeout: 10000 });
  const created = await page.request.post('/api/notes', {
    headers,
    data: {
      folderPath: '00-Inbox',
      fileName: `Git交互-${info.project.name}-${crypto.randomUUID()}.md`,
      content: '# 搭建自己的知识库\n\n独立 Git 版本验收。\n',
      requestId: crypto.randomUUID(),
    },
  });
  expect(created.status()).toBe(201);
  const note = await created.json();
  await returnToNotes(page);
  if (mobile) await page.getByRole('button', { name: '打开侧栏', exact: true }).click();
  // API seeding while settings is open does not run the browser create/refresh flow.
  await page.getByRole('button', { name: '刷新目录', exact: true }).click();
  await expandFolderPath(page, '00-Inbox');
  await page
    .getByRole('button', { name: note.relativePath.split('/').at(-1), exact: true })
    .click();
  await page.getByRole('button', { name: '更多操作', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Git 版本', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '更多操作', exact: true }).click();
  if (mobile) await page.getByRole('button', { name: '打开侧栏', exact: true }).click();
  await page.getByRole('button', { name: '提交全部变更', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Git 提交说明', exact: true })
    .fill('Browser first commit');
  await page.getByRole('button', { name: '预览全部变更', exact: true }).click();
  await expect(page.getByText('A · ' + note.relativePath, { exact: true })).toBeVisible({
    timeout: 10000,
  });
  const fixture = JSON.parse(await readFile('.local/e2e-config.json', 'utf8')),
    file = join(fixture.knowledgeRoot, note.relativePath);
  await writeFile(file, (await readFile(file, 'utf8')) + '\n\n# External change before confirm\n');
  await page.getByRole('button', { name: '确认提交', exact: true }).click();
  await expect(
    page.getByText('预览后文件或暂存区发生变化，请重新预览', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '预览全部变更', exact: true }).click();
  await expect(page.getByRole('button', { name: '确认提交', exact: true })).toBeVisible({
    timeout: 15000,
  });
  await page.getByRole('button', { name: '确认提交', exact: true }).click();
  await expect(page.getByText(/提交 [a-f0-9]{40} 已完成/)).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: '关闭插件面板', exact: true }).click();
  if (mobile) await page.getByRole('button', { name: '关闭侧栏', exact: true }).click();
  await clickNoteAction(page, 'Git 版本');
  await expect(page.getByText(/Browser Fixture · Browser first commit/)).toBeVisible({
    timeout: 10000,
  });
  await page.getByRole('button', { name: '查看差异', exact: true }).click();
  await expect(page.locator('.dooknow-git-history pre')).toContainText('搭建自己的知识库', {
    timeout: 10000,
  });
  await page.getByRole('button', { name: '关闭插件面板', exact: true }).click();
});

test('a large note keeps its Git history readable and explains why restore is disabled', async ({
  page,
  context,
}, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.goto('/');
  await configurePlugin(page, 'Git 版本管理');
  await page.getByLabel('提交作者', { exact: true }).fill('Browser Fixture');
  await page.getByLabel('作者邮箱', { exact: true }).fill('browser@example.invalid');
  await page.getByRole('button', { name: '保存插件配置', exact: true }).click();
  const enable = page
    .locator('.plugin-settings')
    .getByRole('button', { name: '启用插件', exact: true });
  if (await enable.isVisible()) await enable.click();
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const headers = { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token };
  const call = async (kind: 'command' | 'provider', id: string, input: unknown = {}) => {
    const response = await page.request.post('/api/plugins/git/call', {
      headers,
      data: { kind, id, input },
    });
    expect(response.status()).toBe(200);
    return response.json();
  };
  if ((await call('provider', 'git.status')).repository === 'missing')
    await call('command', 'git.initialize', { requestId: crypto.randomUUID() });
  const original = '# Version available in Git\n';
  const created = await page.request.post('/api/notes', {
    headers,
    data: {
      folderPath: '00-Inbox',
      fileName: `Git恢复限制-${info.project.name}-${crypto.randomUUID()}.md`,
      content: original,
      requestId: crypto.randomUUID(),
    },
  });
  expect(created.status()).toBe(201);
  const note = await created.json();
  const preview = await call('command', 'git.preview', { message: 'Git restore limit fixture' });
  await call('command', 'git.commit', { token: preview.token, requestId: crypto.randomUUID() });
  const fixture = JSON.parse(await readFile('.local/e2e-config.json', 'utf8'));
  const file = join(fixture.knowledgeRoot, note.relativePath);
  const large = ('x'.repeat(4095) + '\n').repeat(257);
  let restoreRequests = 0;
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      request.url().endsWith('/api/plugins/git/call') &&
      request.postDataJSON()?.id === 'git.restore'
    )
      restoreRequests++;
  });
  try {
    await writeFile(file, large);
    await page.goto('/?note=' + note.id);
    await clickNoteAction(page, 'Git 版本');
    await expect(page.getByRole('button', { name: '查看差异', exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: '查看差异', exact: true }).first().click();
    await expect(page.getByText(/当前笔记不支持 Git 恢复：仅支持不超过 1 MiB/)).toBeVisible();
    await expect(page.getByRole('button', { name: '恢复此版本', exact: true })).toBeDisabled();
    await expect(page.locator('.dooknow-git-history pre')).toContainText(
      'Version available in Git',
    );
    expect(restoreRequests).toBe(0);
    expect(await readFile(file, 'utf8')).toBe(large);
  } finally {
    await writeFile(file, original);
  }
});
