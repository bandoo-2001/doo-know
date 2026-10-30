import type { BrowserContext, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configurePlugin } from '../support/settings-navigation';
import { clickNoteAction, selectGitHistoryVersion } from '../support/note-actions';
import { test, expect } from '../support/browser-test';

test.use({ actionTimeout: 10000 });

async function setupGit(page: Page, context: BrowserContext) {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.goto('/');
  await configurePlugin(page, 'Git 版本管理');
  await page.getByLabel('提交作者', { exact: true }).fill('Diff Browser Fixture');
  await page.getByLabel('作者邮箱', { exact: true }).fill('diff-browser@example.invalid');
  await page.getByRole('button', { name: '保存插件配置', exact: true }).click();
  const enable = page
    .locator('.plugin-settings')
    .getByRole('button', { name: '启用插件', exact: true });
  if (await enable.isVisible()) await enable.click();
  await expect(
    page.locator('.plugin-settings').getByRole('button', { name: '停用插件', exact: true }),
  ).toBeEnabled();
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const headers = { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token };
  const call = async (id: string, input: unknown = {}) => {
    const response = await page.request.post('/api/plugins/git/call', {
      headers,
      data: { kind: id === 'git.initialize' ? 'command' : 'provider', id, input },
    });
    expect(response.status()).toBe(200);
    return response.json();
  };
  if ((await call('git.status')).repository === 'missing')
    await call('git.initialize', { requestId: crypto.randomUUID() });
  const fixture = JSON.parse(await readFile('.local/e2e-config.json', 'utf8'));
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-C',
        fixture.knowledgeRoot,
        '-c',
        'user.name=Diff Browser Fixture',
        '-c',
        'user.email=diff-browser@example.invalid',
        ...args,
      ],
      { encoding: 'utf8' },
    ).trim();
  const create = async (content: string) => {
    const response = await page.request.post('/api/notes', {
      headers,
      data: {
        folderPath: '00-Inbox',
        fileName: `中文差异-${crypto.randomUUID()}.md`,
        content,
        requestId: crypto.randomUUID(),
      },
    });
    expect(response.status()).toBe(201);
    return response.json();
  };
  const commit = (path: string, message: string) => {
    git('add', '--', path);
    git('commit', '-m', message, '--', path);
    return git('rev-parse', 'HEAD');
  };
  return { fixture, call, create, commit };
}

test('只读差异安全显示中文、长行及行号，布局自适应且恢复仍须确认所选提交', async ({
  page,
  context,
}, info) => {
  const { fixture, create, commit } = await setupGit(page, context);
  const original = '第一行保留\n删除这一行\n末尾保留\n';
  const longLine = '中文<&>'.repeat(500);
  const changed = `第一行保留\n<img src=x onerror="window.diffExecuted=true">\n${longLine}\n末尾保留\n`;
  const note = await create(original);
  const first = commit(note.relativePath, 'Diff original');
  const file = join(fixture.knowledgeRoot, note.relativePath);
  await writeFile(file, changed);
  commit(note.relativePath, 'Diff Chinese and HTML');
  let restores = 0;
  let restoredCommit: string | undefined;
  page.on('request', (request) => {
    if (request.method() !== 'POST' || !request.url().endsWith('/api/plugins/git/call')) return;
    const data = request.postDataJSON();
    if (data.id === 'git.restore') {
      restores++;
      restoredCommit = data.input.commit;
    }
  });
  await page.goto('/?note=' + note.id);
  await clickNoteAction(page, '历史版本');
  const history = page.locator('.note-history-dialog');
  await history.getByRole('tab', { name: 'Git 提交', exact: true }).click();
  const view = page.locator('.git-diff-view');
  await expect(view.locator('[data-line-type="delete"][data-old-line="2"]')).toContainText(
    '删除这一行',
  );
  await expect(view.locator('tr[data-line-type="insert"][data-new-line="2"]')).toContainText(
    '<img src=x onerror="window.diffExecuted=true">',
  );
  await expect(
    view.locator('tr[data-line-type="insert"][data-new-line="3"] .git-diff-code'),
  ).toHaveText('+' + longLine);
  await expect(view.getByLabel('旧行 2', { exact: true })).toBeVisible();
  await expect(view.getByLabel('新行 2', { exact: true })).toBeVisible();
  await expect(view.locator('img,script,iframe')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).diffExecuted)).toBeUndefined();
  expect(await readFile(file, 'utf8')).toBe(changed);
  expect(restores).toBe(0);

  const layout = view.locator('[data-diff-layout]');
  if (info.project.name === 'desktop') {
    await view.getByRole('button', { name: '左右对照', exact: true }).click();
    await expect(layout).toHaveAttribute('data-diff-layout', 'side-by-side');
    const size = page.viewportSize()!;
    await page.setViewportSize({ width: 500, height: 700 });
    await expect(layout).toHaveAttribute('data-diff-layout', 'line-by-line');
    await expect(view.getByRole('button', { name: '左右对照', exact: true })).toBeDisabled();
    await page.setViewportSize(size);
    await expect(layout).toHaveAttribute('data-diff-layout', 'side-by-side');
    await view.getByRole('button', { name: '逐行', exact: true }).click();
  } else {
    await expect(layout).toHaveAttribute('data-diff-layout', 'line-by-line');
    await expect(view.getByRole('button', { name: '左右对照', exact: true })).toBeDisabled();
  }
  await view.getByText('原始差异', { exact: true }).click();
  await expect(view.locator('pre')).toContainText('删除这一行');
  await expect(view.locator('pre')).toBeVisible();
  await selectGitHistoryVersion(page, 1);
  await expect(history.locator('.note-history-git-commit')).toContainText(first.slice(0, 12));
  await expect(view.locator('[data-diff-layout]')).toBeVisible();
  await page.getByRole('button', { name: '恢复此版本', exact: true }).click();
  expect(restores).toBe(0);
  expect(await readFile(file, 'utf8')).toBe(changed);
  await page.getByRole('button', { name: '确认恢复笔记', exact: true }).click();
  await expect.poll(() => readFile(file, 'utf8')).toBe(original);
  expect(restores).toBe(1);
  expect(restoredCommit).toBe(first);
  await history.getByRole('button', { name: '关闭', exact: true }).click();
});

test('真实超限差异保持 256 KiB 截断提示，不重读大 patch 或禁用原本可恢复的版本', async ({
  page,
  context,
}) => {
  const { fixture, call, create, commit } = await setupGit(page, context);
  const note = await create('超限之前\n');
  commit(note.relativePath, 'Diff limit before');
  const file = join(fixture.knowledgeRoot, note.relativePath);
  const content = 'x'.repeat(300 * 1024) + '\n';
  await writeFile(file, content);
  const selected = commit(note.relativePath, 'Diff limit after');
  const result = await call('git.diff', { noteId: note.id, commit: selected });
  expect(result).toMatchObject({ truncated: true, diff: '', maxBytes: 256 * 1024 });
  let diffRequests = 0;
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      request.url().endsWith('/api/plugins/git/call') &&
      request.postDataJSON()?.id === 'git.diff'
    )
      diffRequests++;
  });
  await page.goto('/?note=' + note.id);
  await clickNoteAction(page, '历史版本');
  const history = page.locator('.note-history-dialog');
  await history.getByRole('tab', { name: 'Git 提交', exact: true }).click();
  await expect(page.locator('.git-diff-view')).toContainText('差异超过 256 KiB');
  await expect(page.locator('.git-diff-view table')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '恢复此版本', exact: true })).toBeEnabled();
  expect(diffRequests).toBe(1);
  expect(await readFile(file, 'utf8')).toBe(content);
  await history.getByRole('button', { name: '关闭', exact: true }).click();
});

test('按需加载解析器失败时仍可阅读原始 patch', async ({ page, context }) => {
  const { fixture, create, commit } = await setupGit(page, context);
  const note = await create('保留的原始差异\n');
  commit(note.relativePath, 'Diff parser fallback');
  let parserRequests = 0;
  await page.route(/\/diff2html(?:-[^/]+)?\.js(?:\?.*)?$/, (route) => {
    parserRequests++;
    return route.abort('failed');
  });
  await page.goto('/?note=' + note.id);
  await clickNoteAction(page, '历史版本');
  expect(parserRequests).toBe(0);
  const history = page.locator('.note-history-dialog');
  await history.getByRole('tab', { name: 'Git 提交', exact: true }).click();
  const view = page.locator('.git-diff-view');
  await expect(view.getByText('差异对照暂不可用，已保留原始差异。', { exact: true })).toBeVisible();
  expect(parserRequests).toBe(1);
  await expect(view.locator('pre')).toBeVisible();
  await expect(view.locator('pre')).toContainText('+保留的原始差异');
  expect(await readFile(join(fixture.knowledgeRoot, note.relativePath), 'utf8')).toBe(
    '保留的原始差异\n',
  );
  await history.getByRole('button', { name: '关闭', exact: true }).click();
});
