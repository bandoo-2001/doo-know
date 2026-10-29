import { openLegacyMcpSettings } from '../support/settings-navigation';
import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import type { PluginView } from '../../packages/plugin-contracts';
import { test, expect } from '../support/browser-test';

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

async function mcp(page: Page): Promise<PluginView> {
  const registry = await (await page.request.get('/api/platform/plugins')).json();
  return registry.installed.find((entry: PluginView) => entry.id === 'mcp');
}

async function openMcp(page: Page) {
  await page.goto('/?view=settings&section=plugins');
  await expect(page.getByRole('button', { name: '刷新插件状态', exact: true })).toBeEnabled();
  const card = page.locator('.plugin-card').filter({ hasText: 'MCP 服务' });
  if (await card.isVisible()) await card.getByRole('button', { name: '配置', exact: true }).click();
  else {
    await page.getByRole('tab', { name: '添加插件', exact: true }).click();
    await page.getByRole('button', { name: '安装MCP 服务', exact: true }).click();
  }
  await expect(page.getByRole('heading', { name: 'MCP 服务设置', exact: true })).toBeVisible();
  await openLegacyMcpSettings(page);
}

async function saveRemote(page: Page, values: Record<string, unknown>, configVersion: number) {
  return page.evaluate(
    async (input) => {
      const csrf = await (await fetch('/api/security/csrf')).json();
      const response = await fetch('/api/platform/plugins/mcp/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf.token },
        body: JSON.stringify(input),
      });
      if (!response.ok) throw Error('Fixture configuration update failed: ' + response.status);
      return (await response.json()) as PluginView;
    },
    { values, configVersion },
  );
}

async function selectMode(page: Page, label: string) {
  await page.getByRole('combobox', { name: '连接方式', exact: true }).press('ArrowDown');
  await page.locator('.ant-select-item-option').filter({ hasText: label }).click();
}

test('shows relevant MCP fields, generates a local key and retains separate plugin drafts', async ({
  page,
}, info) => {
  await openMcp(page);
  const saved = await mcp(page);
  await selectMode(page, '网页授权（OAuth）');
  for (const name of ['Tunnel 本地端口', 'Tunnel Bearer 密钥', 'Tunnel 外部地址'])
    await expect(page.getByLabel(name, { exact: true })).toHaveCount(0);
  const prefixes = page.getByLabel('允许访问的目录', { exact: true });
  await expect(prefixes).toHaveValue((saved.config.allowedPrefixes as string[]).join('\n'));
  await prefixes.fill('00-Inbox\n我的草稿目录');
  await selectMode(page, '本地隧道（Tunnel）');
  const key = page.getByLabel('Tunnel Bearer 密钥', { exact: true });
  await page.getByRole('button', { name: '生成连接密钥', exact: true }).click();
  await expect(key).toHaveValue(/^[a-f0-9]{64}$/);
  const generated = await key.inputValue();
  await page.getByLabel('Tunnel 外部地址', { exact: true }).fill('https://tunnel.example.invalid');
  await selectMode(page, '网页授权（OAuth）');
  await expect(key).toHaveCount(0);
  await selectMode(page, '同时启用');
  await expect(key).toHaveValue(generated);
  await expect(page.getByLabel('Tunnel 外部地址', { exact: true })).toHaveValue(
    'https://tunnel.example.invalid',
  );
  const form = page.locator('.plugin-form'),
    addressRow = page.getByLabel('外部网页地址', { exact: true }).locator('..');
  expect((await addressRow.boundingBox())!.width).toBeGreaterThan(
    (await form.boundingBox())!.width * 0.9,
  );
  await page.screenshot({ path: info.outputPath('mcp-config-form.png'), animations: 'disabled' });
  await page.getByRole('button', { name: '返回插件列表', exact: true }).click();
  const git = page.locator('.plugin-card').filter({ hasText: 'Git 版本管理' });
  if (!(await git.isVisible())) {
    await page.getByRole('tab', { name: '添加插件', exact: true }).click();
    await page.getByRole('button', { name: '安装Git 版本管理', exact: true }).click();
  } else await git.getByRole('button', { name: '配置', exact: true }).click();
  await page.getByLabel('提交作者', { exact: true }).fill('尚未保存的作者');
  await page.getByRole('button', { name: '返回插件列表', exact: true }).click();
  await page
    .locator('.plugin-card')
    .filter({ hasText: 'MCP 服务' })
    .getByRole('button', { name: '配置', exact: true })
    .click();
  await expect(prefixes).toHaveValue('00-Inbox\n我的草稿目录');
  await expect(key).toHaveValue(generated);
  await page.getByRole('button', { name: '返回插件列表', exact: true }).click();
  await git.getByRole('button', { name: '配置', exact: true }).click();
  await expect(page.getByLabel('提交作者', { exact: true })).toHaveValue('尚未保存的作者');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('preserves input on remote changes, requires explicit reload and saves against the new baseline', async ({
  page,
}) => {
  await openMcp(page);
  const initial = await mcp(page);
  try {
    const prefixes = page.getByLabel('允许访问的目录', { exact: true });
    await prefixes.fill('00-Inbox\n未保存的目录');
    const remote = await saveRemote(
      page,
      { readOnly: !initial.config.readOnly },
      initial.configVersion,
    );
    await page.getByRole('button', { name: '刷新插件状态', exact: true }).click();
    await expect(page.getByText('已保存配置在其他位置发生变化', { exact: true })).toBeVisible();
    await expect(prefixes).toHaveValue('00-Inbox\n未保存的目录');
    await expect(page.getByRole('button', { name: '保存插件配置', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '重新载入已保存配置', exact: true }).click();
    await page.getByRole('button', { name: '保留当前输入', exact: true }).click();
    await expect(prefixes).toHaveValue('00-Inbox\n未保存的目录');
    await page.getByRole('button', { name: '重新载入已保存配置', exact: true }).click();
    await page.getByRole('button', { name: '丢弃输入并重新载入', exact: true }).click();
    await expect(prefixes).toHaveValue((remote.config.allowedPrefixes as string[]).join('\n'));
    await expect(page.getByText('已保存配置在其他位置发生变化', { exact: true })).toHaveCount(0);
    await prefixes.fill('00-Inbox\nREADME.md');
    const request = page.waitForRequest(
      (r) => r.url().endsWith('/api/platform/plugins/mcp/config') && r.method() === 'PUT',
    );
    await page.getByRole('button', { name: '保存插件配置', exact: true }).click();
    const payload = (await request).postDataJSON();
    expect(payload.values.allowedPrefixes).toEqual(['00-Inbox', 'README.md']);
    expect(payload.configVersion).toBe(remote.configVersion);
    await expect(page.locator('.form-success')).toContainText('插件配置已保存');
    await expect(page.getByText('已保存配置在其他位置发生变化', { exact: true })).toHaveCount(0);
    expect((await mcp(page)).config.allowedPrefixes).toEqual(['00-Inbox', 'README.md']);
  } finally {
    const current = await mcp(page);
    await saveRemote(page, initial.config, current.configVersion);
  }
});

test('selects full-library autonomous organization while archive, index and public disclosure stay independent',async({page})=>{
  await openMcp(page);
  const saved=await mcp(page);
  const knowledge=page.locator('.domain-card[aria-label="知识库权限"]');
  const blog=page.locator('.domain-card[aria-label="博客权限"]');
  await expect(knowledge).toBeVisible();
  await knowledge.locator('summary').click();
  const archive=knowledge.getByRole('checkbox',{name:'归档',exact:true});
  const index=knowledge.getByRole('checkbox',{name:'维护索引',exact:true});
  const archived=await archive.isChecked(),indexed=await index.isChecked();
  const published=await blog.getByRole('switch',{name:'启用博客权限',exact:true}).getAttribute('aria-checked');
  await page.getByRole('combobox',{name:'知识库能力预设',exact:true}).press('ArrowDown');
  await page.locator('.ant-select-item-option').filter({hasText:/^自主整理$/}).click();
  await page.getByRole('combobox',{name:'知识库资源范围',exact:true}).press('ArrowDown');
  await page.locator('.ant-select-item-option').filter({hasText:/^整个知识库$/}).click();
  await expect(knowledge.getByRole('checkbox',{name:'读取',exact:true})).toBeChecked();
  await expect(knowledge.getByRole('checkbox',{name:'内容编辑',exact:true})).toBeChecked();
  await expect(knowledge.getByRole('checkbox',{name:'自主整理',exact:true})).toBeChecked();
  expect(await archive.isChecked()).toBe(archived);
  expect(await index.isChecked()).toBe(indexed);
  await expect(blog.getByRole('switch',{name:'启用博客权限',exact:true})).toHaveAttribute('aria-checked',published!);
  expect((await mcp(page)).config).toEqual(saved.config);
  await expect(page.locator('.plugin-draft-notice')).toContainText('未保存');
});
