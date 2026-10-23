import { showSidebar } from '../support/settings-navigation';
import { expandFolderPath } from '../support/notebook-tree';
import { test, expect } from '../support/browser-test';
import { readFile } from 'node:fs/promises';

test.use({ sourceEditorPreference: true });

async function createNote(
  page: import('@playwright/test').Page,
  name: string,
  content = '# 工作流验收\n\n需要保留的正文。',
) {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const response = await page.request.post('/api/notes', {
    headers: { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token },
    data: { folderPath: '00-Inbox', fileName: name, content, requestId: crypto.randomUUID() },
  });
  expect(response.status()).toBe(201);
  return response.json();
}
test.beforeEach(async ({ context, page }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.goto('/');
  await expect(page.locator('.sidebar')).toBeVisible();
});

test('tracks the selected note in the URL, restores it on reload and guards browser back navigation', async ({
  page,
}, info) => {
  const a = await createNote(page, `导航甲-${Date.now()}.md`),
    b = await createNote(page, `导航乙-${Date.now()}.md`);
  await page.goto('/?note=' + a.id);
  await page.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
  await expect(page.locator('.cm-content')).toBeVisible();
  if (info.project.name === 'mobile')
    await page.getByRole('button', { name: '打开侧栏', exact: true }).click();
  await expandFolderPath(page, '00-Inbox');
  await page
    .locator('.tree-scroll')
    .getByRole('button', { name: b.relativePath.split('/').at(-1), exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp('note=' + b.id));
  await page.reload();
  await expect(page.locator('.document-title')).toContainText('导航乙');
  await page.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
  await page.locator('.cm-content').fill('# 导航中的草稿\n\n不能因为后退而丢失。');
  await page.goBack();
  await expect(
    page.getByText('离开前，请选择如何处理当前编辑内容。', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('不能因为后退而丢失');
  await expect(page).toHaveURL(new RegExp('note=' + b.id));
  await page.goBack();
  await page.getByRole('button', { name: '放弃修改', exact: true }).click();
  await expect(page).toHaveURL(new RegExp('note=' + a.id));
  await expect(page.locator('.document-title')).toContainText('导航甲');
  await page.goForward();
  await expect(page).toHaveURL(new RegExp('note=' + b.id));
  await page.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
  await expect(page.locator('.cm-content')).not.toContainText('不能因为后退而丢失');
});

test('exposes search modes and opens the matching line', async ({ page }) => {
  const note = await createNote(
    page,
    `命中定位-${Date.now()}.md`,
    '# 很长的笔记\n\n' + '普通段落。\n'.repeat(80) + '这里包含目标结论。\n',
  );
  let mode = '';
  await page.route('**/api/search/advanced', async (route) => {
    mode = route.request().postDataJSON().mode;
    await route.fulfill({
      json: {
        results: [
          {
            noteId: note.id,
            title: '很长的笔记',
            relativePath: note.relativePath,
            matches: [
              {
                snippet: '这里包含目标结论。',
                startLine: 83,
                endLine: 83,
                headingPath: ['很长的笔记'],
                url: '/?note=' + note.id + '#L83',
              },
            ],
          },
        ],
        index: { pending: 0 },
      },
    });
  });
  await page.getByPlaceholder('搜索笔记与目录').fill('目标结论');
  await expect(page.getByRole('combobox', { name: '搜索模式', exact: true })).toBeVisible();
  await page.locator('.search-result').filter({ hasText: '目标结论' }).click();
  await expect(page).toHaveURL(new RegExp('note=' + note.id + '#L83'));
  await page.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
  await expect(page.locator('.cm-content')).toBeVisible();
  expect(mode).toBeTruthy();
});

test('moves a note through the UI while preserving its identity, history and public share', async ({
  page,
}, info) => {
  const note = await createNote(page, `整理保留身份-${Date.now()}.md`);
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const headers = { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token };
  const shared = await (
    await page.request.post(`/api/notes/${note.id}/share`, { headers, data: {} })
  ).json();
  const edited = await page.request.put(`/api/notes/${note.id}`, {
    headers,
    data: {
      content: '# 整理后的正文\n\n分享和身份保持。',
      expectedModifiedAt: note.modifiedAt,
      requestId: crypto.randomUUID(),
    },
  });
  expect(edited.ok()).toBe(true);
  const history = await (await page.request.get(`/api/notes/${note.id}/revisions`)).json();
  await page.goto('/?note=' + note.id);
  await page.getByRole('button', { name: '更多操作', exact: true }).click();
  await page.getByRole('button', { name: '移动或重命名', exact: true }).click();
  const dialog = page.locator('.n-modal').filter({ hasText: '保持笔记身份、历史版本和分享链接' });
  const directory = dialog.getByRole('combobox', { name: '目标目录', exact: true });
  await dialog.locator('[aria-label="目标目录"]').click();
  await directory.fill('30-Knowledge/个人知识管理/方法');
  await page.locator('.directory-tree-popup:visible').getByTitle('方法', { exact: true }).click();
  await dialog.getByRole('textbox', { name: '文件名', exact: true }).fill('整理后的知识.md');
  await dialog.getByRole('button', { name: '确认移动', exact: true }).click();
  await expect(page.locator('.document-title')).toHaveText('整理后的知识');
  await expect(page).toHaveURL(new RegExp('note=' + note.id));
  const current = await (await page.request.get(`/api/notes/${note.id}`)).json();
  expect(current.relativePath).toBe('30-Knowledge/个人知识管理/方法/整理后的知识.md');
  expect((await (await page.request.get(`/api/notes/${note.id}/revisions`)).json()).items).toEqual(
    history.items,
  );
  const guest = await page.context().browser()!.newContext();
  try {
    const response = await guest.request.get(
      'http://127.0.0.1:4179/api/public/shares/' + shared.token,
    );
    expect(response.ok()).toBe(true);
    expect((await response.json()).html).toContain('分享和身份保持');
  } finally {
    await guest.close();
  }
});

test('imports a Markdown note from the daily workspace and downloads the saved source', async ({
  page,
}, info) => {
  await showSidebar(page);
  await page.locator('.sidebar').getByRole('button', { name: '创建与导入', exact: true }).click();
  await page
    .getByRole('dialog', { name: '创建与导入', exact: true })
    .getByRole('button', { name: '导入 Markdown', exact: true })
    .click();
  const name = `日常导入-${info.project.name}-${Date.now()}.md`,
    content = '# 日常导入\n\n迁入的原始内容。\n';
  await page
    .getByLabel('选择 Markdown 文件', { exact: true })
    .setInputFiles({ name, mimeType: 'text/markdown', buffer: Buffer.from(content) });
  await expect(page.locator('.n-modal .directory-select .ant-select-selection-item')).toHaveText(
    '00-Inbox',
  );
  const created = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/notes' && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: '确认导入', exact: true }).click();
  const response = await created;
  expect(response.status()).toBe(201);
  const imported = await response.json();
  expect(imported.relativePath).toBe('00-Inbox/' + name);
  await expect(page.getByRole('status').filter({ hasText: name + ' 已导入' })).toBeVisible();
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await showSidebar(page);
  await expandFolderPath(page, '00-Inbox');
  await page.locator('.tree-scroll').getByRole('button', { name, exact: true }).click();
  await expect(page).toHaveURL(new RegExp('note=' + imported.id));
  await page.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('迁入的原始内容');
  await page.getByRole('button', { name: '更多操作', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载 Markdown', exact: true }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe(name);
  const stream = await file.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).toString('utf8')).toBe(content);
});

test('the persistent preview outline jumps to its heading without leaving preview', async ({
  page,
}) => {
  const note = await createNote(
    page,
    `阅读目录-${Date.now()}.md`,
    '# 阅读记录\n\n' + '需要阅读的段落。\n\n'.repeat(90) + '## 本周结论\n\n保留清晰的结论。\n',
  );
  await page.goto('/?note=' + note.id);
  await page.getByRole('button', { name: '阅读', exact: true }).click();
  const chapterMenu = page.getByRole('button', { name: '章节目录', exact: true });
  await expect(chapterMenu).toBeVisible();
  if ((await chapterMenu.getAttribute('aria-expanded')) !== 'true') await chapterMenu.click();
  await page
    .getByRole('navigation', { name: '本文章节', exact: true })
    .getByRole('button', { name: '本周结论', exact: true })
    .click();
  await expect(page.locator('.preview-panel')).toBeVisible();
  await expect
    .poll(() => page.locator('.markdown').evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0);
  await expect(page).toHaveURL(new RegExp('note=' + note.id + '#L'));
});

test('the maintenance confirmation shows disk time and requires rechecking a changed version', async ({
  page,
}) => {
  const note = await createNote(page, `核对磁盘-${Date.now()}.md`);
  let generation = 1,
    calls = 0;
  await page.route('**/api/maintenance/conflicts', (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: 'review-operation',
            noteId: note.id,
            kind: 'update',
            status: 'needs_reconciliation',
            relativePath: note.relativePath,
            resolvable: true,
            disk: {
              modifiedAt: '1792330000000000000',
              contentHash: String(generation).repeat(64),
              sizeBytes: 20,
            },
          },
        ],
        syncConflicts: [],
      },
    }),
  );
  await page.route('**/api/maintenance/conflicts/review-operation/resolve', async (route) => {
    calls++;
    if (calls === 1) {
      generation = 2;
      await route.fulfill({
        status: 409,
        json: { error: 'VERSION_CONFLICT', code: 'VERSION_CONFLICT' },
      });
    } else {
      expect(route.request().postDataJSON().expectedContentHash).toBe('2'.repeat(64));
      await route.fulfill({
        json: {
          id: 'resolution',
          operationId: 'review-operation',
          resolved: true,
          evidencePreserved: true,
        },
      });
    }
  });
  await page.goto('/?view=settings&section=maintenance');
  await expect(page.locator('.settings-workspace h1')).toHaveText('备份与恢复');
  await page.locator('summary').filter({ hasText: '异常写入恢复' }).click();
  await page.getByRole('button', { name: '核对磁盘版本', exact: true }).click();
  const dialog = page.locator('.n-modal').filter({ hasText: '采用当前磁盘版本？' });
  await expect(dialog).not.toContainText('Invalid Date');
  await expect(dialog).toContainText('2026');
  await dialog.getByRole('button', { name: '采用磁盘版本', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('重新检查');
  await dialog.getByRole('button', { name: '重新检查', exact: true }).click();
  await dialog.getByRole('button', { name: '采用磁盘版本', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(calls).toBe(2);
});
