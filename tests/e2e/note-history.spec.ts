import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { test, expect } from '../support/browser-test';
import { clickNoteAction, selectHistoryVersion } from '../support/note-actions';

test.use({ sourceEditorPreference: true, actionTimeout: 10000 });

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

async function historyNote(page: Page, versions: string[]) {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const headers = { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token };
  const response = await page.request.post('/api/notes', {
    headers,
    data: {
      folderPath: '00-Inbox',
      fileName: `历史对比-${crypto.randomUUID()}.md`,
      content: versions[0],
      requestId: crypto.randomUUID(),
    },
  });
  expect(response.status()).toBe(201);
  let note = await response.json();
  for (const content of versions.slice(1)) {
    const saved = await page.request.put('/api/notes/' + note.id, {
      headers,
      data: { content, expectedModifiedAt: note.modifiedAt, requestId: crypto.randomUUID() },
    });
    expect(saved.status()).toBe(200);
    note = await saved.json();
  }
  await page.goto('/?note=' + note.id);
  // The first visit also compiles the dev server's lazy workspace modules.
  await expect(page.locator('.cm-content')).toBeVisible({ timeout: 15000 });
  return note;
}

test('普通历史无需 Git 即可自动比较完整正文、切换版本与布局', async ({ page }, info) => {
  const original = '# 每周回顾\n\n本周学到了什么？\n\n- 最初的内容\n- 值得继续探索的问题\n';
  const middle = original.replace('最初的内容', '阶段内容');
  const current = original.replace('最初的内容', '最新的内容') + '\n## 下周计划\n- 整理读书笔记\n';
  const note = await historyNote(page, [original, middle, current]);
  await clickNoteAction(page, '历史版本');
  const dialog = page.locator('.note-history-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.git-diff-delete')).toContainText(['阶段内容']);
  await expect(dialog.locator('.git-diff-insert')).toContainText(['最新的内容']);
  await expect(dialog).toContainText('当前已保存版本');
  const versions = dialog.locator('.note-history-version');
  await expect(versions).toHaveCount(2);
  await selectHistoryVersion(page, -1);
  await expect(dialog.locator('.git-diff-delete')).toContainText(['最初的内容']);
  await dialog.getByRole('tab', { name: '历史原文', exact: true }).click();
  await expect(dialog.locator('.note-history-source')).toHaveText(original);
  await dialog.getByRole('tab', { name: '差异对比', exact: true }).click();
  const side = dialog.getByRole('button', { name: '左右对照', exact: true });
  if (info.project.name === 'desktop') {
    await side.click();
    await expect(dialog.locator('[data-diff-layout]')).toHaveAttribute(
      'data-diff-layout',
      'side-by-side',
    );
  } else {
    await expect(side).toBeDisabled();
    await expect(dialog.locator('[data-diff-layout]')).toHaveAttribute(
      'data-diff-layout',
      'line-by-line',
    );
  }
  const bounds = await dialog.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  await expect(dialog.getByRole('button', { name: '恢复此版本', exact: true })).toBeInViewport();
  expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).toBe(current);
  await dialog.screenshot({ path: `.local/note-history-polished-${info.project.name}.png` });
});

test('对比不包含草稿，恢复确认与原有草稿保护都生效并保全恢复前正文', async ({ page }) => {
  const original = '# 旧版本\n恢复这段内容\n';
  const current = '# 当前版本\n恢复前要保留\n';
  const note = await historyNote(page, [original, current]);
  await page.locator('.cm-content').fill('# 尚未保存\n草稿独有内容\n');
  await clickNoteAction(page, '历史版本');
  const dialog = page.locator('.note-history-dialog');
  await expect(dialog.locator('.git-diff-insert')).toContainText(['恢复前要保留']);
  await expect(dialog.locator('.git-diff-view')).not.toContainText('草稿独有内容');
  await expect(dialog).toContainText('未保存的草稿不参与对比');
  await dialog.getByRole('button', { name: '恢复此版本', exact: true }).click();
  expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).toBe(current);
  await dialog.getByRole('button', { name: '确认恢复', exact: true }).click();
  const leave = page.locator('.n-modal').filter({ hasText: '离开前，请选择如何处理当前编辑内容' });
  await expect(leave).toBeVisible();
  await leave.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('草稿独有内容');
  await dialog.getByRole('button', { name: '恢复此版本', exact: true }).click();
  await dialog.getByRole('button', { name: '确认恢复', exact: true }).click();
  await leave.getByRole('button', { name: '放弃修改', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.cm-content')).toContainText('恢复这段内容');
  const revisions = await (await page.request.get(`/api/notes/${note.id}/revisions`)).json();
  expect(revisions.items).toHaveLength(2);
});

test('自动读取跨页原文后才对比，最后一页的差异也可见', async ({ page }) => {
  const original = '# 跨页历史\n' + '保留内容\n'.repeat(230) + '最后一页旧内容\n';
  const current = original.replace('最后一页旧内容', '最后一页新内容');
  await historyNote(page, [original, current]);
  await clickNoteAction(page, '历史版本');
  const dialog = page.locator('.note-history-dialog');
  await expect(dialog.locator('.git-diff-delete')).toContainText(['最后一页旧内容']);
  await expect(dialog.locator('.git-diff-insert')).toContainText(['最后一页新内容']);
  await dialog.getByRole('tab', { name: '历史原文', exact: true }).click();
  await expect(dialog.locator('.note-history-source')).toHaveText(original);
});

test('超过单次阅读会话页数时仍能连续读取完整历史并对比末尾', async ({ page }) => {
  test.setTimeout(60000);
  const original = '# 多页历史\n' + 'a\n'.repeat(40_001) + '末尾旧内容\n';
  await historyNote(page, [original, original.replace('末尾旧内容', '末尾新内容')]);
  await clickNoteAction(page, '历史版本');
  const dialog = page.locator('.note-history-dialog');
  await expect(dialog.locator('.git-diff-delete')).toContainText(['末尾旧内容'], {
    timeout: 30000,
  });
  await expect(dialog.locator('.git-diff-insert')).toContainText(['末尾新内容']);
  await expect(dialog.getByRole('alert')).toHaveCount(0);
});

test('差异视图加载失败保留原始差异并提供本地重试', async ({ page }) => {
  await historyNote(page, ['重试之前\n', '重试之后\n']);
  await page.route(
    /\/packages\/plugin-ui\/diff-view\.ts(?:\?|$)/,
    (route) => route.abort('failed'),
    { times: 1 },
  );
  await clickNoteAction(page, '历史版本');
  const dialog = page.locator('.note-history-dialog');
  await expect(dialog).toContainText('原始差异');
  await expect(dialog.getByRole('button', { name: '重试差异视图', exact: true })).toBeVisible();
  await expect(dialog.locator('.note-history-source')).toContainText('-重试之前');
  await dialog.getByRole('button', { name: '重试差异视图', exact: true }).click();
  await expect(dialog.locator('.git-diff-delete')).toContainText(['重试之前']);
});

test('读取失败在面板内重试，关闭后可以重新打开', async ({ page }) => {
  const note = await historyNote(page, ['旧内容\n', '当前内容\n']);
  const revisions = await (await page.request.get(`/api/notes/${note.id}/revisions`)).json();
  const readUrl = `**/api/notes/${note.id}/revisions/${revisions.items[0].id}/read`;
  await page.route(
    readUrl,
    (route) => route.fulfill({ status: 503, json: { error: '历史读取测试失败' } }),
    { times: 1 },
  );
  await clickNoteAction(page, '历史版本');
  const dialog = page.locator('.note-history-dialog');
  await expect(dialog.getByRole('alert')).toContainText('历史读取测试失败');
  await dialog.getByRole('button', { name: '重试读取', exact: true }).click();
  await expect(dialog.locator('.git-diff-delete')).toContainText(['旧内容']);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await clickNoteAction(page, '历史版本');
  await expect(dialog.locator('.git-diff-delete')).toContainText(['旧内容']);
});

test('切换版本后忽略迟到的读取结果，关闭也不会留下旧选择', async ({ page }) => {
  const note = await historyNote(page, ['最初的版本\n', '较近的版本\n', '当前的版本\n']);
  const revisions = await (await page.request.get(`/api/notes/${note.id}/revisions`)).json();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = false;
  await page.route(
    `**/api/notes/${note.id}/revisions/${revisions.items[0].id}/read`,
    async (route) => {
      started = true;
      const response = await route.fetch();
      await held;
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  const dialog = page.locator('.note-history-dialog');
  try {
    await clickNoteAction(page, '历史版本');
    await expect.poll(() => started).toBe(true);
    await selectHistoryVersion(page, -1);
    await expect(dialog.locator('.git-diff-delete')).toContainText(['最初的版本']);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await clickNoteAction(page, '历史版本');
    await expect(dialog.locator('.git-diff-delete')).toContainText(['较近的版本']);
    await selectHistoryVersion(page, -1);
    await expect(dialog.locator('.git-diff-delete')).toContainText(['最初的版本']);
  } finally {
    release();
  }
  await expect(dialog.locator('.note-history-version').last()).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(dialog.locator('.git-diff-delete')).toContainText(['最初的版本']);
  await expect(dialog.locator('.git-diff-view')).not.toContainText('较近的版本');
});

test('超出比较范围仍自动预览并可逐页查看和恢复', async ({ page }) => {
  const original = '第一段历史\n' + ('x'.repeat(1024) + '\n').repeat(130) + '末尾历史\n';
  const note = await historyNote(page, [original, '现在的正文\n']);
  // Simulate a revision over the comparison limit using only list metadata;
  // the normal immutable read API still supplies real paginated source text.
  const url = `**/api/notes/${note.id}/revisions`;
  await page.route(url, async (route) => {
    const reply = await route.fetch();
    const data = await reply.json();
    data.items[0].sizeBytes = 2 * 1024 * 1024;
    await route.fulfill({ json: data });
  });
  await clickNoteAction(page, '历史版本');
  const dialog = page.locator('.note-history-dialog');
  await expect(dialog.locator('.note-history-source')).toContainText('第一段历史');
  await expect(dialog).toContainText('暂不生成完整对比');
  await expect(dialog.locator('.git-diff-table')).toHaveCount(0);
  await dialog.getByRole('button', { name: '下一片段', exact: true }).click();
  await expect(dialog.locator('.note-history-source')).toContainText('末尾历史');
  await expect(dialog.getByRole('button', { name: '恢复此版本', exact: true })).toBeEnabled();
});
