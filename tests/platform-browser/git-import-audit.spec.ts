import { test, expect, type Page } from '@playwright/test';
import { generateKeyPairSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { testPassword } from '../support/credentials.js';

const fakeToken = 'fixture-only-not-a-real-token';
const sshKey = generateKeyPairSync('ed25519', {
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;
const sshType = Buffer.from('ssh-ed25519');
const sshRecord = Buffer.alloc(4 + sshType.length + 4 + 32);
sshRecord.writeUInt32BE(sshType.length, 0);
sshType.copy(sshRecord, 4);
sshRecord.writeUInt32BE(32, 4 + sshType.length);
sshRecord.fill(7, 8 + sshType.length);
const hosts = `github.com ssh-ed25519 ${sshRecord.toString('base64')}`;

async function openRemote(page: Page) {
  await page.goto('/');
  await page.getByLabel('用户名', { exact: true }).fill('owner');
  await page.getByLabel('密码', { exact: true }).fill(testPassword);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: '从 GitHub／Gitee 导入', exact: true }).click();
  await expect(page.getByLabel('仓库克隆地址', { exact: true })).toBeVisible();
}
async function addHttpsCredential(page: Page, name: string) {
  await page.getByRole('button', { name: '添加凭据', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '添加凭据', exact: true });
  await dialog.getByLabel('凭据名称', { exact: true }).fill(name);
  await dialog.getByLabel('仓库用户名', { exact: true }).fill('fixture-user');
  await dialog.getByLabel('访问令牌', { exact: true }).fill(fakeToken);
  const saved = page.waitForResponse(
    (r) => r.url().endsWith('/api/platform/git/credentials') && r.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: '保存仓库凭据', exact: true }).click();
  const response = await saved;
  expect(response.status()).toBe(200);
  expect(await response.text()).not.toContain(fakeToken);
  await expect(dialog).toBeHidden();
  return response.json();
}

test.beforeEach(async ({ page }) => {
  const reset = await page.request.post('/__test/setup/reset');
  expect(reset.ok()).toBe(true);
});

test('Git import refuses empty and unsafe remote inputs without starting an external operation', async ({
  page,
}) => {
  await openRemote(page);
  const testConnection = page.getByRole('button', { name: '测试读取连接', exact: true });
  const clone = page.getByRole('button', { name: '导入并继续', exact: true });
  await expect(testConnection).toBeDisabled();
  await expect(clone).toBeDisabled();
  await page.getByLabel('仓库克隆地址', { exact: true }).fill('file:///etc/passwd');
  await testConnection.click();
  await expect(page.getByRole('alert')).toContainText('请填写 GitHub 或 Gitee');
  await page
    .getByLabel('仓库克隆地址', { exact: true })
    .fill('https://github.com/fixture/onboarding.git');
  await page.getByLabel('导入后的知识库名称', { exact: true }).fill('');
  await expect(clone).toBeDisabled();
  await expect(page.getByLabel('仓库认证', { exact: true })).toHaveValue('');
});

test('HTTPS credential create, same-binding edit and removal use real isolated API storage without returning secrets', async ({
  page,
}) => {
  await openRemote(page);
  await page
    .getByLabel('仓库克隆地址', { exact: true })
    .fill('https://github.com/fixture/onboarding.git');
  await page.getByLabel('云端分支（选填）', { exact: true }).fill('main');
  const saved = await addHttpsCredential(page, 'Audit HTTPS');
  await expect(page.getByLabel('仓库认证', { exact: true })).toHaveValue(saved.id);
  await expect(page.getByLabel('仓库克隆地址', { exact: true })).toHaveValue(
    'https://github.com/fixture/onboarding.git',
  );
  await page.getByRole('button', { name: '更换凭据 Audit HTTPS', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '更换凭据', exact: true });
  await expect(dialog.getByLabel('访问令牌', { exact: true })).toHaveValue('');
  await expect(dialog.getByLabel('访问令牌', { exact: true })).not.toHaveAttribute('required');
  await dialog.getByLabel('凭据名称', { exact: true }).fill('Audit HTTPS renamed');
  const updated = page.waitForResponse(
    (r) => r.url().endsWith('/api/platform/git/credentials') && r.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: '保存仓库凭据', exact: true }).click();
  expect((await updated).status()).toBe(200);
  await expect(dialog).toBeHidden();
  const listed = await page.request.get('/api/platform/git/credentials');
  expect(await listed.text()).not.toContain(fakeToken);
  await page.getByRole('button', { name: '移除凭据 Audit HTTPS renamed', exact: true }).click();
  await expect(page.getByLabel('仓库认证', { exact: true })).toHaveValue('');
  await expect(
    page.getByRole('button', { name: '更换凭据 Audit HTTPS renamed', exact: true }),
  ).toHaveCount(0);
});

test('changing a saved credential service or authentication kind requires new secret material', async ({
  page,
}) => {
  await openRemote(page);
  await addHttpsCredential(page, 'Audit binding');
  await page.getByRole('button', { name: '更换凭据 Audit binding', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '更换凭据', exact: true });
  await dialog.getByLabel('凭据服务平台', { exact: true }).selectOption('gitee.com');
  await expect(dialog.getByLabel('访问令牌', { exact: true })).toHaveAttribute('required', '');
  await expect(dialog.getByLabel('访问令牌', { exact: true })).not.toHaveAttribute(
    'placeholder',
    '留空保留原令牌',
  );
  await dialog.getByLabel('认证方式', { exact: true }).selectOption('ssh');
  await expect(dialog.getByLabel('SSH 私钥', { exact: true })).toHaveAttribute('required', '');
  await expect(dialog.getByLabel('SSH 私钥', { exact: true })).not.toHaveAttribute(
    'placeholder',
    '留空保留原私钥',
  );
});

test('SSH credentials require a trusted matching host and can be saved as temporary credentials', async ({
  page,
}) => {
  await openRemote(page);
  await page.getByRole('button', { name: '添加凭据', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '添加凭据', exact: true });
  await dialog.getByLabel('凭据名称', { exact: true }).fill('Audit SSH');
  await dialog.getByLabel('认证方式', { exact: true }).selectOption('ssh');
  await dialog.getByLabel('SSH 私钥', { exact: true }).fill(sshKey);
  await dialog.getByLabel('已核对的 known_hosts', { exact: true }).fill(hosts);
  const save = dialog.getByRole('button', { name: '保存仓库凭据', exact: true });
  await expect(save).toBeDisabled();
  const trust = dialog.getByRole('checkbox', {
    name: '我已对照官方文档核对指纹，确认信任此主机',
    exact: true,
  });
  await trust.check();
  await expect(save).toBeEnabled();
  await dialog.getByLabel('凭据服务平台', { exact: true }).selectOption('gitee.com');
  await expect(trust).not.toBeChecked();
  await expect(dialog.getByLabel('已核对的 known_hosts', { exact: true })).toHaveValue('');
  await expect(save).toBeDisabled();
  await dialog.getByLabel('凭据服务平台', { exact: true }).selectOption('github.com');
  await dialog.getByLabel('已核对的 known_hosts', { exact: true }).fill(hosts);
  await trust.check();
  await dialog
    .getByRole('checkbox', { name: '在服务器加密保存凭据（取消后仅保留 30 分钟）', exact: true })
    .uncheck();
  const saved = page.waitForResponse(
    (r) => r.url().endsWith('/api/platform/git/credentials') && r.request().method() === 'POST',
  );
  await save.click();
  const response = await saved;
  expect(response.status()).toBe(200);
  expect((await response.json()).temporary).toBe(true);
  expect(await response.text()).not.toContain('PRIVATE KEY');
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: '移除凭据 Audit SSH', exact: true }).click();
  await expect(page.getByLabel('仓库认证', { exact: true })).toHaveValue('');
});

test('actual local Git read and clone recover from a name conflict and activate imported Markdown', async ({
  page,
}, info) => {
  const fixture = JSON.parse(await readFile('.local/setup-e2e.json', 'utf8'));
  await openRemote(page);
  await page.getByLabel('仓库克隆地址', { exact: true }).fill(fixture.remoteUrl);
  await page.getByLabel('云端分支（选填）', { exact: true }).fill('main');
  await page.getByRole('button', { name: '测试读取连接', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: '读取连接成功。这不代表拥有推送权限。' }),
  ).toBeVisible({ timeout: 30000 });
  await page.getByLabel('导入后的知识库名称', { exact: true }).fill('personal');
  await page.getByRole('button', { name: '导入并继续', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('目标文件夹已经存在', { timeout: 30000 });
  await expect(page.getByLabel('仓库克隆地址', { exact: true })).toHaveValue(fixture.remoteUrl);
  const libraryName = `Audit imported ${info.project.name}`;
  await page.getByLabel('导入后的知识库名称', { exact: true }).fill(libraryName);
  await page.getByRole('button', { name: '导入并继续', exact: true }).click();
  await expect(page.getByRole('heading', { name: '选择需要的功能', exact: true })).toBeVisible({
    timeout: 30000,
  });
  const status = await (await page.request.get('/api/platform/status')).json();
  expect(status.phase).toBe('ready');
  expect(await readFile(join(status.knowledgeRoot, '00-Inbox/imported-note.md'), 'utf8')).toContain(
    '# 导入的验收笔记\n',
  );
  const git = await (await page.request.get('/api/platform/git/status')).json();
  expect(git.connection.url).toBe(fixture.remoteUrl);
  expect(git.connection.branch).toBe('main');
  expect(git.pluginInstalled).toBe(true);
});

test('an accepted clone whose HTTP response is lost is reconciled once without a duplicate clone', async ({
  page,
}) => {
  const fixture = JSON.parse(await readFile('.local/setup-e2e.json', 'utf8'));
  await openRemote(page);
  await page.getByLabel('仓库克隆地址', { exact: true }).fill(fixture.remoteUrl);
  await page.getByLabel('导入后的知识库名称', { exact: true }).fill('Lost response import');
  let submissions = 0;
  await page.route('**/api/platform/git/jobs', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    submissions++;
    const response = await route.fetch();
    expect(response.status()).toBe(202);
    await route.abort('connectionreset');
  });
  await page.getByRole('button', { name: '导入并继续', exact: true }).click();
  await expect(
    page.getByText('请求结果尚未确认，请先读取服务器任务回执，避免重复操作。', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '核对请求结果', exact: true }).click();
  await expect(page.getByRole('heading', { name: '选择需要的功能', exact: true })).toBeVisible({
    timeout: 30000,
  });
  expect(submissions).toBe(1);
});
