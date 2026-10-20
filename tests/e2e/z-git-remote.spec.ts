import { test, expect } from '../support/browser-test';
import { openSettingsSection, returnToNotes, showSidebar } from '../support/settings-navigation';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

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
  // This fresh, isolated note is the only file edited by this case. Earlier cases
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
  git('-C', fixture.gitExternalRoot, 'add', '--', note.relativePath);
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
  await returnToNotes(page);
  await showSidebar(page);
  await page.getByRole('button', { name: '云端同步', exact: true }).click();
  await expect(page.getByRole('region', { name: '云端同步面板', exact: true })).toBeVisible();
  await expect(
    page.locator('.sidebar-tools').getByText('提交全部变更', { exact: true }),
  ).toBeAttached();
});
