import { test, expect } from '../support/browser-test';
import {
  openSettingsSection,
  returnToNotes,
  showSidebar,
  closeSidebar,
} from '../support/settings-navigation';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expandFolderPath } from '../support/notebook-tree';

test('connects an existing library, previews and pushes, then checks and pulls a real remote update', async ({
  page,
  context,
}, info) => {
  test.setTimeout(120000);
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const fixture = JSON.parse(await readFile('.local/e2e-config.json', 'utf8'));
  await page.goto('/');
  await openSettingsSection(page, '知识库与存储');
  const panel = page.getByRole('region', { name: '云端同步面板', exact: true });
  await expect(panel.getByLabel('仓库克隆地址', { exact: true })).toBeVisible();
  await panel.getByLabel('仓库克隆地址', { exact: true }).fill(fixture.gitRemoteURL);
  await panel.getByLabel('云端分支（选填）', { exact: true }).fill('main');
  await panel.getByRole('button', { name: '关联云端仓库', exact: true }).click();
  await expect(panel.getByText('云端仓库已连接。', { exact: true })).toBeVisible({
    timeout: 30000,
  });
  await expect(
    panel.getByText('推送权限尚未验证。读取连接成功不代表可以推送。', { exact: true }),
  ).toBeVisible();
  // These fresh fixture notes are isolated to this case. Earlier cases
  // can leave other saved fixture notes; the real preview deliberately lists all.
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const headers = { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token };
  const original = '# Cloud sync browser fixture\n\nSaved on the local server.\n';
  const created = await page.request.post('/api/notes', {
    headers,
    data: {
      folderPath: '00-Inbox',
      fileName: `云端同步-${info.project.name}-${crypto.randomUUID()}.md`,
      content: original,
      requestId: crypto.randomUUID(),
    },
  });
  expect(created.status()).toBe(201);
  const note = await created.json();
  const removedName = `云端移除-${info.project.name}-${crypto.randomUUID()}.md`;
  const removed = await page.request.post('/api/notes', {
    headers,
    data: {
      folderPath: '00-Inbox',
      fileName: removedName,
      content: '# Removed by remote fixture\n',
      requestId: crypto.randomUUID(),
    },
  });
  expect(removed.status()).toBe(201);
  const removedNote = await removed.json();
  const author = panel.getByLabel('同步提交作者', { exact: true });
  if (await author.isVisible()) {
    await author.fill('Remote Browser Fixture');
    await panel.getByLabel('同步作者邮箱', { exact: true }).fill('remote-browser@example.invalid');
    await panel.getByRole('button', { name: '保存同步署名', exact: true }).click();
    await expect(author).toHaveCount(0);
  }
  await panel.getByRole('button', { name: '刷新同步状态', exact: true }).click();
  await panel.getByLabel('云端同步提交说明', { exact: true }).fill('Browser remote fixture commit');
  let commits = 0;
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      request.url().endsWith('/api/plugins/git/call') &&
      request.postDataJSON()?.id === 'git.commit'
    )
      commits++;
  });
  await panel.getByRole('button', { name: '预览提交并推送', exact: true }).click();
  await expect(panel.getByText('确认本次提交内容', { exact: true })).toBeVisible({
    timeout: 15000,
  });
  await expect(panel.locator('.commit-preview')).toContainText(note.relativePath);
  await panel.getByRole('button', { name: '确认提交并推送', exact: true }).click();
  await expect(panel.getByText('已推送提交版本。', { exact: true })).toBeVisible({
    timeout: 30000,
  });
  expect(commits).toBe(1);
  await returnToNotes(page);
  await showSidebar(page);
  // API fixture seeding happened after the initial navigation tree was loaded.
  await page.getByRole('button', { name: '刷新目录', exact: true }).click();
  await expandFolderPath(page, '00-Inbox');
  await page
    .locator('.tree-scroll')
    .getByRole('button', { name: note.relativePath.split('/').at(-1), exact: true })
    .click();
  await expect(page.locator('.cm-content')).toContainText('Saved on the local server.');
  await showSidebar(page);
  await expect(
    page.locator('.tree-scroll').getByRole('button', { name: removedName, exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '云端同步', exact: true }).click();
  await expect(panel).toBeVisible();
  const git = (...args: string[]) =>
    execFileSync('git', args, { stdio: 'pipe', encoding: 'utf8' }).trim();
  expect(git('--git-dir', fixture.gitRemoteRoot, 'show', 'main:' + note.relativePath)).toBe(
    original.trim(),
  );
  git('clone', '--', fixture.gitRemoteRoot, fixture.gitExternalRoot);
  git('-C', fixture.gitExternalRoot, 'config', 'user.name', 'External Fixture');
  git('-C', fixture.gitExternalRoot, 'config', 'user.email', 'external@example.invalid');
  const updated = original + '\nUpdated in another checkout.\n';
  await writeFile(join(fixture.gitExternalRoot, note.relativePath), updated);
  const addedName = `云端新增-${info.project.name}-${crypto.randomUUID()}.md`;
  const addedPath = '00-Inbox/' + addedName;
  await writeFile(join(fixture.gitExternalRoot, addedPath), '# Added in remote checkout\n');
  git('-C', fixture.gitExternalRoot, 'add', '--', note.relativePath, addedPath);
  git('-C', fixture.gitExternalRoot, 'rm', '--', removedNote.relativePath);
  git('-C', fixture.gitExternalRoot, 'commit', '-m', 'External remote fixture update');
  git('-C', fixture.gitExternalRoot, 'push', 'origin', 'main');
  await panel.getByRole('button', { name: '检查云端', exact: true }).click();
  await expect(panel.getByText('云端检查完成。', { exact: true })).toBeVisible({ timeout: 30000 });
  await expect(panel.getByText('待推送：0 · 待拉取：1', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: '拉取更新', exact: true }).click();
  await expect(panel.getByText('云端更新已拉取，目录与索引已刷新。', { exact: true })).toBeVisible({
    timeout: 30000,
  });
  expect(await readFile(join(fixture.knowledgeRoot, note.relativePath), 'utf8')).toBe(updated);
  expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).toBe(updated);
  // The selected editor and tree must update without a page reload or opening the note again.
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(page.locator('.cm-content')).toContainText('Updated in another checkout.');
  await showSidebar(page);
  await expandFolderPath(page, '00-Inbox');
  await expect(
    page.locator('.tree-scroll').getByRole('button', { name: addedName, exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('.tree-scroll').getByRole('button', { name: removedName, exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: '云端同步', exact: true }).click();
  await expect(page.getByRole('region', { name: '云端同步面板', exact: true })).toBeVisible();
  await expect(
    page.locator('.sidebar-tools').getByText('提交全部变更', { exact: true }),
  ).toBeAttached();
});

test('@git-onboarding imports from the initial page into a fresh knowledge library', async ({
  page,
  context,
}, info) => {
  test.skip(
    process.env.DOOKNOW_E2E_GIT_ONBOARDING !== '1',
    'Requires the isolated fresh unbound fixture variant.',
  );
  test.setTimeout(120000);
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const fixture = JSON.parse(await readFile('.local/e2e-config.json', 'utf8'));
  const initial = await (await page.request.get('/api/platform/status')).json();
  expect(initial.phase).toBe('setup_required');
  expect((await (await page.request.get('/api/platform/plugins')).json()).installed).toEqual([]);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '准备你的知识库', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '从 GitHub／Gitee 导入', exact: true }).click();
  const panel = page.getByRole('region', { name: '云端同步面板', exact: true });
  await panel.getByLabel('仓库克隆地址', { exact: true }).fill(fixture.gitRemoteURL);
  await panel.getByLabel('云端分支（选填）', { exact: true }).fill('main');
  const name = `云端导入-${info.project.name}`;
  await panel.getByLabel('导入后的知识库名称', { exact: true }).fill(name);
  await panel.getByLabel('导入保存位置（选填）', { exact: true }).fill(fixture.gitImportParent);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: info.outputPath('git-onboarding-form.png'),
    fullPage: true,
    animations: 'disabled',
  });
  let cloneRequests = 0;
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      request.url().endsWith('/api/platform/git/jobs') &&
      request.postDataJSON()?.kind === 'clone'
    )
      cloneRequests++;
  });
  await panel.getByRole('button', { name: '导入并继续', exact: true }).click();
  await expect(page.getByRole('heading', { name: '选择需要的功能', exact: true })).toBeVisible({
    timeout: 45000,
  });
  expect(cloneRequests).toBe(1);
  const current = await (await page.request.get('/api/platform/status')).json();
  expect(current.phase).toBe('ready');
  expect(current.knowledgeRoot).toBe(join(fixture.gitImportParent, name));
  const registry = await (await page.request.get('/api/platform/plugins')).json();
  expect(registry.installed.find((entry: any) => entry.id === 'git')).toMatchObject({
    state: 'enabled',
    installedVersion: '1.1.0',
  });
  expect(registry.installed.some((entry: any) => entry.id === 'mcp')).toBe(false);
  expect(await readFile(join(current.knowledgeRoot, '00-Inbox/远端导入示例.md'), 'utf8')).toBe(
    fixture.gitImportContent,
  );
  const gitStatus = await (await page.request.get('/api/platform/git/status')).json();
  expect(gitStatus).toMatchObject({
    pluginInstalled: true,
    pluginEnabled: true,
    repository: 'ready',
    branch: 'main',
    connection: { url: fixture.gitRemoteURL, branch: 'main' },
  });
  await page.getByRole('button', { name: '暂时跳过', exact: true }).click();
  await expect(page.getByRole('heading', { name: '知识库准备好了', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '进入工作区', exact: true }).click();
  await expect(page.locator('.workspace')).toBeVisible();
  await showSidebar(page);
  await expect(page.getByRole('button', { name: '云端同步', exact: true })).toBeVisible();
  await expandFolderPath(page, '00-Inbox');
  await page.getByRole('button', { name: '远端导入示例.md', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('从隔离远端克隆的原文');
  await page.screenshot({ path: info.outputPath('git-onboarding-workspace.png'), fullPage: true });
});
