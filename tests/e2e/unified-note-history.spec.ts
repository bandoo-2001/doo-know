import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { configurePlugin } from '../support/settings-navigation';
import { clickNoteAction, selectGitHistoryVersion } from '../support/note-actions';
import { test, expect } from '../support/browser-test';

test.use({ sourceEditorPreference: true, actionTimeout: 15000 });

async function setupHistory(page: Page, context: BrowserContext) {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.goto('/');
  await configurePlugin(page, 'Git 版本管理');
  await page.getByLabel('提交作者', { exact: true }).fill('History Fixture');
  await page.getByLabel('作者邮箱', { exact: true }).fill('history@example.invalid');
  await page.getByRole('button', { name: '保存插件配置', exact: true }).click();
  const enable = page
    .locator('.plugin-settings')
    .getByRole('button', { name: '启用插件', exact: true });
  if (await enable.isVisible()) await enable.click();
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const headers = { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token };
  const gitCall = async (kind: 'provider' | 'command', id: string, input = {}) => {
    const response = await page.request.post('/api/plugins/git/call', {
      headers,
      data: { kind, id, input },
    });
    expect(response.status()).toBe(200);
    return response.json();
  };
  if ((await gitCall('provider', 'git.status')).repository === 'missing')
    await gitCall('command', 'git.initialize', { requestId: crypto.randomUUID() });
  const original = '# 统一历史\n最初提交的正文\n';
  const committed = '# 统一历史\n最近提交的正文\n';
  const current = '# 统一历史\n当前未提交的正文\n';
  const created = await page.request.post('/api/notes', {
    headers,
    data: {
      folderPath: '00-Inbox',
      fileName: `统一历史-${crypto.randomUUID()}.md`,
      content: original,
      requestId: crypto.randomUUID(),
    },
  });
  expect(created.status()).toBe(201);
  let note = await created.json();
  const fixture = JSON.parse(await readFile('.local/e2e-config.json', 'utf8'));
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-C',
        fixture.knowledgeRoot,
        '-c',
        'user.name=History Fixture',
        '-c',
        'user.email=history@example.invalid',
        ...args,
      ],
      { encoding: 'utf8' },
    ).trim();
  const commit = (message: string) => {
    git('add', '--', note.relativePath);
    git('commit', '-m', message, '--', note.relativePath);
    return git('rev-parse', 'HEAD');
  };
  const first = commit('最初的里程碑');
  const save = async (content: string) => {
    const response = await page.request.put(`/api/notes/${note.id}`, {
      headers,
      data: { content, expectedModifiedAt: note.modifiedAt, requestId: crypto.randomUUID() },
    });
    expect(response.status()).toBe(200);
    note = await response.json();
  };
  await save(committed);
  const latest = commit('补全每周回顾');
  await save(current);
  await page.goto('/?note=' + note.id);
  await expect(page.locator('.cm-content')).toBeVisible({ timeout: 15000 });
  return {
    note,
    original,
    committed,
    current,
    first,
    latest,
    file: join(fixture.knowledgeRoot, note.relativePath),
  };
}

test('一个历史入口区分保存记录和 Git 提交，明确对比基准并恢复选中提交', async ({
  page,
  context,
}, info) => {
  const fixture = await setupHistory(page, context);
  await page.getByRole('button', { name: '更多操作', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Git 版本', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '历史版本', exact: true }).click();
  const dialog = page.locator('.note-history-dialog');
  await expect(dialog.getByRole('tab', { name: '保存记录', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(dialog.locator('.git-diff-insert')).toContainText(['当前未提交的正文']);
  await dialog.getByRole('tab', { name: 'Git 提交', exact: true }).click();
  await expect(dialog.locator('.note-history-git-version')).toHaveCount(2);
  await expect(dialog).toContainText('History Fixture');
  await expect(dialog).toContainText('补全每周回顾');
  await expect(dialog).toContainText('本次提交变更');
  await expect(dialog.locator('.note-history-git-commit')).toContainText(
    fixture.latest.slice(0, 12),
  );
  await expect(dialog.locator('.git-diff-insert')).toContainText(['最近提交的正文']);
  await expect(dialog.locator('.git-diff-view')).not.toContainText('当前未提交的正文');
  await dialog.screenshot({ path: `.local/unified-note-history-${info.project.name}.png` });
  await selectGitHistoryVersion(page, -1);
  await expect(dialog.locator('.note-history-git-commit')).toContainText(
    fixture.first.slice(0, 12),
  );
  await dialog.getByRole('button', { name: '恢复此版本', exact: true }).click();
  expect(await readFile(fixture.file, 'utf8')).toBe(fixture.current);
  await dialog.getByRole('button', { name: '确认恢复笔记', exact: true }).click();
  await expect
    .poll(() => readFile(fixture.file, 'utf8'), { timeout: 15000 })
    .toBe(fixture.original);
  await expect(dialog.getByRole('button', { name: '确认恢复笔记', exact: true })).toBeHidden();
  await dialog.getByRole('tab', { name: '保存记录', exact: true }).click();
  await expect(dialog.locator('.note-history-version')).toHaveCount(3);
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
});

test('未知 Git 恢复结果锁定来源与目标，核对复用原请求并保留未保存草稿', async ({
  page,
  context,
}) => {
  const fixture = await setupHistory(page, context);
  await page.locator('.cm-content').fill('# 本地草稿\n不要丢失的输入\n');
  await clickNoteAction(page, '历史版本');
  const dialog = page.locator('.note-history-dialog');
  await dialog.getByRole('tab', { name: 'Git 提交', exact: true }).click();
  await expect(dialog.locator('.git-diff-insert')).toContainText(['最近提交的正文']);
  await selectGitHistoryVersion(page, -1);
  await expect(dialog.locator('.note-history-git-commit')).toContainText(
    fixture.first.slice(0, 12),
  );
  const requests: any[] = [];
  let loseReply = true;
  await page.route('**/api/plugins/git/call', async (route) => {
    const data = route.request().postDataJSON();
    if (data.id !== 'git.restore') return route.continue();
    requests.push(data.input);
    if (loseReply) {
      loseReply = false;
      await route.fetch();
      return route.abort('failed');
    }
    return route.continue();
  });
  await dialog.getByRole('button', { name: '恢复此版本', exact: true }).click();
  await dialog.getByRole('button', { name: '确认恢复笔记', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '核对恢复结果', exact: true })).toBeVisible();
  await expect(dialog.getByRole('tab', { name: '保存记录', exact: true })).toBeDisabled();
  await expect(dialog.locator('.note-history-git-version').first()).toBeDisabled();
  await dialog.getByRole('button', { name: '核对恢复结果', exact: true }).click();
  await expect
    .poll(() => readFile(fixture.file, 'utf8'), { timeout: 15000 })
    .toBe(fixture.original);
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toEqual(requests[0]);
  await expect(page.locator('.cm-content')).toContainText('不要丢失的输入');
  await dialog.getByRole('tab', { name: '保存记录', exact: true }).click();
  await expect(dialog.locator('.note-history-version')).toHaveCount(3);
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
});

test('停用 Git 后保存记录仍可使用，且不会调用 Git 历史接口', async ({ page, context }) => {
  const fixture = await setupHistory(page, context);
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const disabled = await page.request.post('/api/platform/plugins/git/disable', {
    headers: { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token },
  });
  expect(disabled.status()).toBe(200);
  let gitReads = 0;
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      request.url().endsWith('/api/plugins/git/call') &&
      ['git.history', 'git.diff'].includes(request.postDataJSON()?.id)
    )
      gitReads++;
  });
  await page.reload();
  await expect(page.locator('.cm-content')).toBeVisible({ timeout: 15000 });
  await clickNoteAction(page, '历史版本');
  const dialog = page.locator('.note-history-dialog');
  await expect(dialog.getByRole('tab', { name: '保存记录', exact: true })).toBeVisible();
  await expect(dialog.getByRole('tab', { name: 'Git 提交', exact: true })).toHaveCount(0);
  await expect(dialog.locator('.git-diff-insert')).toContainText(['当前未提交的正文']);
  expect(gitReads).toBe(0);
  expect(await readFile(fixture.file, 'utf8')).toBe(fixture.current);
});
