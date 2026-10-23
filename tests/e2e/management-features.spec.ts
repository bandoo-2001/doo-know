import { test, expect } from '../support/browser-test';
import type { Page, Locator, TestInfo } from '@playwright/test';
import { readFile, mkdir, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { extract } from 'tar';
import Database from 'better-sqlite3';
import { testPassword } from '../support/credentials';
import type { TransferTask } from '../../shared/transfer-contracts';
import type {
  ManagementTrashPurgeInput,
  ManagementTrashRestoreInput,
} from '../../shared/management-contracts';

const origin = 'http://127.0.0.1:4179';
test.setTimeout(150_000);
test.use({ actionTimeout: 10_000 });

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

async function fixturePaths() {
  const config = JSON.parse(await readFile('.local/e2e-config.json', 'utf8'));
  const root = dirname(resolve(config.dataRoot));
  if (
    dirname(root) !== resolve(tmpdir()) ||
    !basename(root).startsWith('dooknow-browser-') ||
    dirname(resolve(config.knowledgeRoot)) !== root
  )
    throw Error('Management tests must use the disposable browser fixture');
  return { root, dataRoot: resolve(config.dataRoot), knowledgeRoot: resolve(config.knowledgeRoot) };
}

async function mutation(page: Page, url: string, data: object, method = 'POST') {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const response = await page.request.fetch(url, {
    method,
    headers: { origin, 'x-csrf-token': csrf.token },
    data,
  });
  expect(response.ok()).toBe(true);
  return response;
}

async function note(page: Page, name: string, content: string) {
  return (
    await mutation(page, '/api/notes', {
      folderPath: '00-Inbox',
      fileName: name,
      content,
      requestId: crypto.randomUUID(),
    })
  ).json();
}

async function archive(page: Page, item: { id: string; modifiedAt: string }) {
  await mutation(
    page,
    '/api/notes/' + item.id,
    {
      expectedModifiedAt: item.modifiedAt,
      requestId: crypto.randomUUID(),
    },
    'DELETE',
  );
}

function card(page: Page, heading: string) {
  return page.locator('section.settings-card').filter({
    has: page.getByRole('heading', { name: heading, exact: true }),
  });
}

async function choose(page: Page, label: string, option: string) {
  await page
    .locator('.ant-select')
    .filter({ has: page.getByRole('combobox', { name: label, exact: true }) })
    .click();
  await page.locator('.ant-select-dropdown:visible').getByText(option, { exact: true }).click();
}

async function uiPost(page: Page, path: string, click: () => Promise<unknown>) {
  const pending = page.waitForResponse(
    (r) => new URL(r.url()).pathname === path && r.request().method() === 'POST',
  );
  await click();
  const response = await pending;
  expect(response.ok()).toBe(true);
  return response.json();
}

async function uiPurgeWithBusyRetry(page: Page, id: string, confirm: () => Promise<unknown>) {
  let original: ManagementTrashPurgeInput | undefined;
  const retry = page.getByRole('button', { name: '按原请求核对结果', exact: true });
  for (let attempt = 0; attempt < 8; attempt++) {
    const pending = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === '/api/manage/trash/purge' && r.request().method() === 'POST',
    );
    if (attempt === 0) await confirm();
    else await retry.click();
    const response = await pending;
    const input = response.request().postDataJSON() as ManagementTrashPurgeInput;
    if (!original) {
      original = input;
      expect(original).toEqual({
        ids: [id],
        confirm: 'PERMANENTLY_DELETE',
        snapshotId: expect.any(String),
        requestId: expect.any(String),
      });
      expect(original.snapshotId).not.toBe('');
      expect(original.requestId).not.toBe('');
    } else expect(input).toEqual(original);
    const result = await response.json();
    if (response.status() === 200) return result;
    // Other fixture cases can hold the workspace gate. Only this explicit,
    // retryable rejection permits clicking the UI's retained original request.
    expect(response.status()).toBe(503);
    expect(result).toMatchObject({ code: 'WORKSPACE_BUSY', retryable: true });
    await expect(retry).toBeEnabled();
    if (attempt < 7) await page.waitForTimeout(Math.min(250 * 2 ** attempt, 2000));
  }
  throw Error('Workspace remained busy after eight UI attempts of the same scoped purge request');
}

async function uiRestoreWithBusyRetry(page: Page, id: string, restore: () => Promise<unknown>) {
  let original: ManagementTrashRestoreInput | undefined;
  const retry = page.getByRole('button', { name: '按原请求核对结果', exact: true });
  for (let attempt = 0; attempt < 8; attempt++) {
    const pending = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/manage/trash/restore' &&
        response.request().method() === 'POST',
    );
    if (attempt === 0) await restore();
    else await retry.click();
    const response = await pending;
    const input = response.request().postDataJSON() as ManagementTrashRestoreInput;
    if (!original) {
      original = input;
      expect(input.ids).toEqual([id]);
      expect(input.requestId).toMatch(/^[a-f0-9-]{36}$/);
    } else expect(input).toEqual(original);
    const result = await response.json();
    if (response.status() === 200) return result;
    // Match the purge helper: only this definite retryable gate rejection
    // permits resending the UI's retained original restore request.
    expect(response.status()).toBe(503);
    expect(result).toMatchObject({ code: 'WORKSPACE_BUSY', retryable: true });
    await expect(retry).toBeEnabled();
    if (attempt < 7) await page.waitForTimeout(Math.min(250 * 2 ** attempt, 2000));
  }
  throw Error('Workspace remained busy after eight UI attempts of the same restore request');
}

async function settle(page: Page, id: string): Promise<TransferTask> {
  let task!: TransferTask;
  await expect
    .poll(
      async () => {
        const response = await page.request.get('/api/manage/tasks/' + id);
        expect(response.ok()).toBe(true);
        task = await response.json();
        return ['queued', 'running'].includes(task.state) ? 'pending' : task.state;
      },
      { timeout: 90_000, intervals: [100, 250, 500, 1000] },
    )
    .toBe('succeeded');
  return task;
}

function taskRow(page: Page, id: string) {
  return card(page, '任务与结果').locator(':scope > ul > li').filter({ hasText: id });
}

async function downloadFile(page: Page, info: TestInfo, link: Locator, name: string) {
  const pending = page.waitForEvent('download');
  await link.click();
  const download = await pending;
  expect(await download.failure()).toBeNull();
  const file = info.outputPath(name);
  await download.saveAs(file);
  return file;
}

test('saved display preferences change the actual editor and survive reload without changing source', async ({
  page,
}) => {
  const fileName = `display-${crypto.randomUUID()}.md`;
  const source =
    '# Display fixture\n\n' + 'A long unchanged paragraph. '.repeat(50) + '\n\nLast line.\n';
  const item = await note(page, fileName, source);
  await page.goto('/?view=settings&section=editor');
  await expect(page.getByRole('heading', { name: '编辑器与外观', exact: true })).toBeVisible();
  await choose(page, '默认打开方式', '编辑');
  await choose(page, '默认编辑方式', 'Markdown 源码');
  await page.getByRole('switch', { name: '自动换行', exact: true }).click();
  await page.getByRole('switch', { name: '显示行号', exact: true }).click();
  await choose(page, '文字大小', '20 px');
  await choose(page, '阅读宽度', '宽屏');
  await choose(page, '外观', '深色');
  await page.getByRole('button', { name: '保存偏好', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '编辑器偏好已保存' })).toBeVisible();
  await page.goto('/?note=' + item.id);
  const editor = page.locator('.document-surface .cm-editor');
  await expect(editor).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(editor).toHaveCSS('font-size', '20px');
  await expect(page.locator('.cm-content')).toHaveCSS('white-space', 'pre');
  await expect(page.locator('.cm-content')).toHaveCSS('max-width', '1080px');
  await expect(page.locator('.cm-lineNumbers')).toBeVisible();
  await expect(editor).toHaveCSS('background-color', 'rgb(23, 32, 51)');
  await page.reload();
  await expect(editor).toHaveCSS('font-size', '20px');
  await expect(page.locator('.cm-lineNumbers')).toBeVisible();
  await expect(page.locator('.cm-content')).toHaveCSS('white-space', 'pre');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect((await (await page.request.get('/api/notes/' + item.id)).json()).content).toBe(source);
  const paths = await fixturePaths();
  expect(await readFile(join(paths.knowledgeRoot, '00-Inbox', fileName), 'utf8')).toBe(source);
  await page.goto('/?view=settings&section=editor');
  await page.getByRole('button', { name: '恢复默认设置', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: '保存偏好', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('library previews a colliding batch, imports real files and exports a portable archive', async ({
  page,
}, info) => {
  const token = crypto.randomUUID();
  const first = `batch-${token}.md`,
    second = `companion-${token}.md`,
    asset = `asset-${token}.png`;
  const existing = await note(page, first, '# Existing fixture must survive\n');
  const content = `# Imported fixture\n\n![pixel](${asset})\n`;
  const image = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=',
    'base64',
  );
  await page.goto('/?view=settings&section=library');
  await page.getByRole('button', { name: '批量导入', exact: true }).click();
  const importDialog = page.getByRole('dialog', { name: '批量导入', exact: true });
  await importDialog.getByLabel('选择文件', { exact: true }).setInputFiles([
    { name: first, mimeType: 'text/markdown', buffer: Buffer.from(content) },
    { name: second, mimeType: 'text/markdown', buffer: Buffer.from('# Companion fixture\n') },
    { name: asset, mimeType: 'image/png', buffer: image },
  ]);
  await choose(page, '遇到同名文件', '自动使用新文件名');
  const preview = await uiPost(page, '/api/manage/import/preview', () =>
    page.getByRole('button', { name: '预览导入', exact: true }).click(),
  );
  expect(preview.items).toHaveLength(3);
  const renamed = preview.items.find((i: { path: string }) => i.path === first);
  expect(renamed.decision).toBe('rename');
  const previewRow = importDialog.getByRole('row').filter({ hasText: renamed.targetPath });
  await expect(previewRow).toContainText('使用新名称');
  await importDialog.getByRole('button', { name: '下一步：确认导入', exact: true }).click();
  const submitted = await uiPost(page, '/api/manage/import', () =>
    page.getByRole('button', { name: '确认导入 3 个文件', exact: true }).click(),
  );
  const imported = await settle(page, submitted.id);
  expect(imported.items?.map((i) => i.state)).toEqual(['succeeded', 'succeeded', 'succeeded']);
  await card(page, '任务与结果').getByRole('button', { name: '刷新任务', exact: true }).click();
  await taskRow(page, submitted.id).getByText('逐项结果（3）', { exact: true }).click();
  await expect(taskRow(page, submitted.id)).toContainText(renamed.targetPath + ' · 成功');
  const importedId = imported.items?.find((i) => i.path === first)?.noteId;
  expect(importedId).toBeTruthy();
  expect((await (await page.request.get('/api/notes/' + importedId)).json()).content).toContain(
    '![pixel](' + asset + ')',
  );
  expect((await (await page.request.get('/api/notes/' + existing.id)).json()).content).toBe(
    '# Existing fixture must survive\n',
  );
  const paths = await fixturePaths();
  expect(await readFile(join(paths.knowledgeRoot, '00-Inbox', asset))).toEqual(image);
  await page.getByRole('button', { name: '导出资料', exact: true }).click();
  await choose(page, '导出范围', '指定目录');
  const folderSelect = page.getByRole('combobox', { name: '仅导出指定目录', exact: true });
  await folderSelect.fill('00-Inbox');
  await page
    .locator('.directory-tree-popup:visible')
    .getByText('00-Inbox', { exact: true })
    .click();
  const exported = await uiPost(page, '/api/manage/export', () =>
    page.getByRole('button', { name: '导出此目录', exact: true }).click(),
  );
  const done = await settle(page, exported.id);
  expect(done.result?.scope).toBe('00-Inbox');
  await card(page, '任务与结果').getByRole('button', { name: '刷新任务', exact: true }).click();
  const archivePath = await downloadFile(
    page,
    info,
    taskRow(page, exported.id).getByRole('link', { name: '下载结果', exact: true }),
    'library.tar.gz',
  );
  const extracted = info.outputPath('portable-library');
  await mkdir(extracted, { recursive: true });
  await extract({ file: archivePath, cwd: extracted, strict: true });
  const manifest = JSON.parse(await readFile(join(extracted, 'dooknow-export.json'), 'utf8'));
  expect(manifest.scope).toBe('00-Inbox');
  expect(manifest.files).toContain(renamed.targetPath);
  expect(manifest.files).toContain('00-Inbox/' + asset);
  expect(await readFile(join(extracted, renamed.targetPath), 'utf8')).toBe(content);
  expect(await readFile(join(extracted, '00-Inbox', asset))).toEqual(image);
});

test('library share overview revokes public access while retaining the note and revisions', async ({
  page,
  browser,
}) => {
  const fileName = `share-${crypto.randomUUID()}.md`,
    source = '# Share management fixture\n\nKeep this source.\n';
  const item = await note(page, fileName, source);
  const shared = await (await mutation(page, '/api/notes/' + item.id + '/share', {})).json();
  const revisions = await (await page.request.get('/api/notes/' + item.id + '/revisions')).json();
  const guest = await browser.newContext({ baseURL: origin });
  try {
    expect((await guest.request.get('/api/public/shares/' + shared.token)).ok()).toBe(true);
    await page.goto('/?view=settings&section=library');
    await page.getByLabel('查找共享链接', { exact: true }).fill(fileName.replace(/\.md$/, ''));
    await page.getByRole('button', { name: '查找链接', exact: true }).click();
    const row = card(page, '共享链接').getByRole('listitem').filter({ hasText: fileName });
    await expect(row).toContainText('可访问');
    await expect(row.getByRole('link', { name: '打开共享页面', exact: true })).toHaveAttribute(
      'href',
      /\//,
    );
    await row.getByRole('button', { name: '撤销', exact: true }).click();
    await page.getByRole('button', { name: '撤销链接', exact: true }).click();
    await expect(row).toContainText('已撤销');
    await expect(row.getByRole('button', { name: '撤销', exact: true })).toHaveCount(0);
    expect((await guest.request.get('/api/public/shares/' + shared.token)).status()).toBe(404);
    expect((await (await page.request.get('/api/notes/' + item.id)).json()).content).toBe(source);
    expect(await (await page.request.get('/api/notes/' + item.id + '/revisions')).json()).toEqual(
      revisions,
    );
  } finally {
    await guest.close();
  }
});

test('trash collision can restore with a new name and permanent removal affects only the confirmed selection', async ({
  page,
}) => {
  const token = crypto.randomUUID(),
    fileName = `trash-${token}.md`;
  const old = await note(page, fileName, '# Archived collision fixture\n');
  await archive(page, old);
  const current = await note(page, fileName, '# Current collision fixture\n');
  const purged = await note(page, `purge-${token}.md`, '# Purge selected fixture\n');
  const retained = await note(page, `retained-${token}.md`, '# Retain unselected fixture\n');
  await archive(page, purged);
  await archive(page, retained);
  await page.goto('/?view=trash');
  await expect(page.getByRole('heading', { name: '回收站', exact: true })).toBeVisible();
  await page.getByRole('searchbox', { name: '搜索回收站', exact: true }).fill(token);
  await page.getByRole('button', { name: '查找', exact: true }).click();
  const row = page.locator('.trash-item').filter({ hasText: fileName });
  await expect(row.locator('.item-meta')).toContainText(/\d+ B/);
  await uiRestoreWithBusyRetry(page, old.id, () =>
    row.getByRole('button', { name: '恢复并打开', exact: true }).click(),
  );
  await expect(page.locator('.operation-results')).toContainText(
    '原位置已有同名项目，请填写另一个名称后重试。',
  );
  const renamed = `restored-${token}.md`;
  await row.getByLabel('恢复时使用的文件名', { exact: true }).fill(renamed);
  await uiRestoreWithBusyRetry(page, old.id, () =>
    row.getByRole('button', { name: '恢复并打开', exact: true }).click(),
  );
  await expect(page).toHaveURL(new RegExp('note=' + old.id));
  await page.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('Archived collision fixture');
  expect((await (await page.request.get('/api/notes/' + old.id)).json()).relativePath).toBe(
    '00-Inbox/' + renamed,
  );
  expect((await (await page.request.get('/api/notes/' + current.id)).json()).content).toBe(
    '# Current collision fixture\n',
  );
  await page.goto('/?view=trash');
  await page.getByRole('searchbox', { name: '搜索回收站', exact: true }).fill(token);
  await page.getByRole('button', { name: '查找', exact: true }).click();
  await page
    .locator('.trash-item')
    .filter({ hasText: `purge-${token}.md` })
    .getByRole('checkbox')
    .check();
  await page.getByRole('button', { name: '永久移除所选文件', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '永久移除回收站文件', exact: true });
  await expect(dialog.locator('.purge-items')).toHaveText('00-Inbox/purge-' + token + '.md');
  await expect(dialog).toContainText('历史版本、备份及必要的元数据');
  await dialog.getByRole('button', { name: '永久移除这 1 个文件', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('请输入“永久移除”');
  await dialog.getByLabel('输入“永久移除”确认本次所选文件', { exact: true }).fill('永久移除');
  const receipt = await uiPurgeWithBusyRetry(page, purged.id, () =>
    dialog.getByRole('button', { name: '永久移除这 1 个文件', exact: true }).click(),
  );
  expect(receipt).toMatchObject({
    scope: 'selected-trash-source-files',
    retained: ['history', 'backups', 'metadata'],
    results: [{ id: purged.id, ok: true }],
  });
  await expect(dialog).toBeHidden();
  await expect(
    page.locator('.trash-item').filter({ hasText: `retained-${token}.md` }),
  ).toBeVisible();
  const paths = await fixturePaths();
  await expect(
    stat(join(paths.knowledgeRoot, '90-Archive/.trash', purged.id, `purge-${token}.md`)),
  ).rejects.toMatchObject({ code: 'ENOENT' });
  expect(
    await readFile(
      join(paths.knowledgeRoot, '90-Archive/.trash', retained.id, `retained-${token}.md`),
      'utf8',
    ),
  ).toBe('# Retain unselected fixture\n');
  expect(await readFile(join(paths.knowledgeRoot, '00-Inbox', fileName), 'utf8')).toBe(
    '# Current collision fixture\n',
  );
});

test('backup UI downloads encrypted data, reauthenticates key export and verifies a separate restored copy', async ({
  page,
}, info) => {
  const fileName = `backup-${crypto.randomUUID()}.md`,
    source = '# Private backup fixture\n\nUnique recovery marker.\n';
  const item = await note(page, fileName, source);
  const paths = await fixturePaths();
  await page.goto('/?view=settings&section=backup');
  const submitted = await uiPost(page, '/api/manage/backups', () =>
    page.getByRole('button', { name: '创建加密备份', exact: true }).click(),
  );
  const backup = await settle(page, submitted.id);
  expect(backup.result?.backupId).toBeTruthy();
  await page.getByRole('button', { name: '刷新备份记录', exact: true }).click();
  const row = card(page, '加密备份')
    .locator(':scope > ul > li')
    .filter({ hasText: backup.result!.backupId! });
  const backupPath = await downloadFile(
    page,
    info,
    row.getByRole('link', { name: '下载备份', exact: true }),
    'snapshot.dkb',
  );
  const encrypted = await readFile(backupPath);
  expect(encrypted.subarray(0, 10).toString()).toBe('DOOKNOWBK1');
  expect(encrypted.includes(Buffer.from('Unique recovery marker'))).toBe(false);
  await page.getByRole('button', { name: '下载恢复密钥', exact: true }).click();
  const keyDialog = page.getByRole('dialog', { name: '下载恢复密钥', exact: true });
  await keyDialog.getByLabel('当前密码', { exact: true }).fill('Wrong-Fixture-Password');
  const rejected = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/manage/backups/key',
  );
  await page.getByRole('button', { name: '验证密码并下载密钥', exact: true }).click();
  expect((await rejected).status()).toBe(403);
  await expect(page.locator('#backup-key-error')).toBeVisible();
  await expect(page.getByLabel('当前密码', { exact: true })).toHaveValue('');
  await page.getByLabel('当前密码', { exact: true }).fill(testPassword);
  const keyPath = await downloadFile(
    page,
    info,
    page.getByRole('button', { name: '验证密码并下载密钥', exact: true }),
    'recovery-key.pem',
  );
  expect((await readFile(keyPath, 'utf8')).includes('PRIVATE KEY')).toBe(true);
  await expect(keyDialog).toBeHidden();
  await page.getByRole('button', { name: '下载恢复密钥', exact: true }).click();
  await expect(keyDialog.getByLabel('当前密码', { exact: true })).toHaveValue('');
  await keyDialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(keyDialog).toBeHidden();
  await row.getByRole('button', { name: '恢复到独立副本', exact: true }).click();
  const restore = await uiPost(page, '/api/manage/restores', () =>
    page.getByRole('button', { name: '开始独立恢复', exact: true }).click(),
  );
  const done = await settle(page, restore.id),
    verification = done.result!.verification!;
  expect(verification).toMatchObject({
    verified: true,
    activationRequired: true,
    sessionsRevoked: true,
    sharesRevoked: true,
    pluginsDisabled: true,
  });
  expect(verification.dataRoot).not.toBe(paths.dataRoot);
  expect(verification.knowledgeRoot).not.toBe(paths.knowledgeRoot);
  for (const path of [
    verification.dataRoot,
    verification.knowledgeRoot!,
    verification.restoreReceipt,
  ])
    expect(resolve(path).startsWith(paths.root + '/')).toBe(true);
  expect(await readFile(join(verification.knowledgeRoot!, '00-Inbox', fileName), 'utf8')).toBe(
    source,
  );
  expect((await stat(verification.restoreReceipt)).isFile()).toBe(true);
  const restoredDb = new Database(join(verification.dataRoot, 'app.sqlite'), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    expect(restoredDb.pragma('integrity_check', { simple: true })).toBe('ok');
  } finally {
    restoredDb.close();
  }
  await card(page, '任务与结果').getByRole('button', { name: '刷新任务', exact: true }).click();
  const restoreRow = taskRow(page, restore.id);
  await expect(restoreRow).toContainText('独立副本已恢复并通过校验');
  await restoreRow.getByText('恢复副本位置与校验回执', { exact: true }).click();
  await expect(restoreRow).toContainText(verification.restoreReceipt);
  await expect(restoreRow).toContainText('当前服务继续使用原有数据');
  expect((await (await page.request.get('/api/notes/' + item.id)).json()).content).toBe(source);
  expect(await readFile(join(paths.knowledgeRoot, '00-Inbox', fileName), 'utf8')).toBe(source);
  expect((await page.request.get('/api/manage/overview')).ok()).toBe(true);
});

test('account revokes a selected other device and about downloads redacted diagnostics with real status navigation', async ({
  page,
  browser,
}, info) => {
  const marker = 'Private-diagnostic-fixture-' + crypto.randomUUID();
  await note(page, `diagnostic-${crypto.randomUUID()}.md`, '# ' + marker);
  const device = 'Disposable Other Device ' + crypto.randomUUID();
  const other = await browser.newContext({ baseURL: origin, userAgent: device });
  try {
    const login = await other.request.post('/api/auth/sign-in/username', {
      headers: { origin },
      data: { username: 'owner', password: testPassword },
    });
    expect(login.ok()).toBe(true);
    await page.goto('/?view=settings&section=account');
    const sessions = card(page, '登录设备');
    await expect(sessions).toContainText('当前设备');
    const row = sessions.getByRole('listitem').filter({ hasText: device });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: '退出设备', exact: true }).click();
    await page
      .locator('.ant-popover')
      .getByRole('button', { name: '退出设备', exact: true })
      .click();
    await expect(row).toHaveCount(0);
    expect((await other.request.get('/api/manage/overview')).status()).toBe(401);
    expect((await page.request.get('/api/manage/overview')).ok()).toBe(true);
    const listed = await page.request.get('/api/manage/sessions');
    expect((await listed.json()).items.some((s: { current: boolean }) => s.current)).toBe(true);
    expect(await listed.text()).not.toMatch(/"(?:token|password|ipAddress)"/);
    await page.goto('/?view=settings&section=about');
    const diagnostic = await downloadFile(
      page,
      info,
      page.getByRole('button', { name: '下载脱敏诊断', exact: true }),
      'diagnostics.json',
    );
    const raw = await readFile(diagnostic, 'utf8'),
      data = JSON.parse(raw);
    expect(data.scope).toBe('redacted-status-only');
    expect(data.counts.activeNotes).toBeGreaterThan(0);
    expect(raw.includes(marker)).toBe(false);
    expect(raw.includes(testPassword)).toBe(false);
    expect(raw.includes((await fixturePaths()).root)).toBe(false);
    expect(raw).not.toMatch(/"(?:token|password|privateKey|knowledgeRoot|dataRoot)"/);
    if (info.project.name === 'mobile')
      await page.getByRole('button', { name: '打开侧栏', exact: true }).click();
    await page
      .getByRole('navigation', { name: '常用工具', exact: true })
      .getByRole('button', { name: '后台状态', exact: true })
      .click();
    const drawer = page.locator('.status-drawer-content');
    await expect(drawer.getByRole('heading', { name: '搜索准备', exact: true })).toBeVisible();
    await expect(drawer.getByRole('heading', { name: '索引更新', exact: true })).toBeVisible();
    await expect(drawer.getByRole('heading', { name: '写入与恢复', exact: true })).toBeVisible();
    await expect(drawer).toContainText('没有需要人工核对的写入');
    await drawer.locator('summary').filter({ hasText: '搜索准备' }).click();
    await drawer.getByRole('button', { name: '打开搜索设置', exact: true }).click();
    await expect(page.locator('.settings-workspace h1')).toHaveText('搜索');
    await expect(drawer).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  } finally {
    await other.close();
  }
});
