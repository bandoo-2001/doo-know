import { readFile } from 'node:fs/promises';
import type { Locator, Page } from '@playwright/test';
import type { PluginCatalogEntry, PluginView } from '../../packages/plugin-contracts';
import type { PermissionPolicy, ResourceRef } from '../../shared/permissions';
import { test, expect } from '../support/browser-test';

const longName = '跨团队长期研究资料与归档说明'.repeat(5) + '.md';
const resources = [
  { kind: 'directory', id: 'projects', path: '项目资料', label: '项目资料' },
  { kind: 'directory', id: 'research', path: '项目资料/研究', label: '项目资料/研究' },
  {
    kind: 'note',
    id: 'guide',
    path: '项目资料/研究/入门指南.md',
    label: '项目资料/研究/入门指南.md',
  },
  {
    kind: 'note',
    id: 'design',
    path: '项目资料/研究/设计笔记.md',
    label: '项目资料/研究/设计笔记.md',
  },
  { kind: 'note', id: 'roadmap', path: '项目资料/路线图.md', label: '项目资料/路线图.md' },
  { kind: 'directory', id: 'archive', path: '项目资料-归档', label: '项目资料-归档' },
  { kind: 'note', id: 'private', path: '项目资料-归档/机密.md', label: '项目资料-归档/机密.md' },
  { kind: 'note', id: 'long-note', path: longName, label: longName },
];

function policy(selected: ResourceRef[] = []): PermissionPolicy {
  return {
    version: 2,
    domains: {
      knowledge: {
        enabled: true,
        ownerId: 'tree-fixture-owner',
        instanceId: 'tree-fixture-library',
        actions: ['read'],
        resources: { mode: 'selected', resources: selected },
      },
      blog: {
        enabled: false,
        ownerId: 'tree-fixture-owner',
        instanceId: 'tree-fixture-blog',
        actions: [],
        resources: { mode: 'all' },
      },
      'to-doo': {
        enabled: false,
        ownerId: 'tree-fixture-owner',
        instanceId: 'tree-fixture-tasks',
        actions: [],
        resources: { mode: 'all' },
      },
    },
  };
}

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

async function inventory(page: Page, initial: PermissionPolicy) {
  await page.route('**/api/platform/mcp/permissions', (route) =>
    route.fulfill({
      json: {
        policy: initial,
        bindings: Object.fromEntries(
          Object.entries(initial.domains).map(([domain, grant]) => [
            domain,
            { ownerId: grant.ownerId, instanceId: grant.instanceId },
          ]),
        ),
        resources: { knowledge: resources, blog: [], 'to-doo': [] },
      },
    }),
  );
}

// Only the resource inventory and persistence boundary are fixtures. The page,
// permission editor and AntDV popup all execute their real browser code.
async function openPlugin(page: Page, selected: ResourceRef[] = []) {
  const initial = policy(selected);
  await inventory(page, initial);
  const registry = (await (await page.request.get('/api/platform/plugins')).json()) as {
    installed: PluginView[];
    catalog: PluginCatalogEntry[];
    contributions: unknown[];
  };
  const existing = registry.installed.find((plugin) => plugin.id === 'mcp');
  const manifest = existing?.manifest ?? registry.catalog.find((plugin) => plugin.id === 'mcp')!;
  const plugin: PluginView = {
    id: 'mcp',
    installedVersion: manifest.version,
    desiredEnabled: false,
    state: 'disabled',
    configVersion: 1,
    restartRequired: false,
    manifest,
    configuredSecrets: [],
    ...existing,
    config: {
      ...existing?.config,
      mode: 'oauth',
      allowedPrefixes: ['00-Inbox'],
      permissionPolicy: initial,
    },
  };
  registry.installed = [...registry.installed.filter((entry) => entry.id !== 'mcp'), plugin];
  await page.route('**/api/platform/plugins', (route) => route.fulfill({ json: registry }));
  await page.route('**/api/platform/plugins/mcp/config', async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    plugin.config = route.request().postDataJSON().values;
    plugin.configVersion += 1;
    await route.fulfill({ json: plugin });
  });
  await page.goto('/?view=settings&section=plugins');
  await expect(page.getByRole('button', { name: '刷新插件状态', exact: true })).toBeEnabled();
  await page
    .locator('.plugin-card')
    .filter({ hasText: 'MCP 服务' })
    .getByRole('button', { name: '配置', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'MCP 服务设置', exact: true })).toBeVisible();
  return page.getByRole('article', { name: '知识库权限', exact: true });
}

function picker(page: Page) {
  return page.getByRole('combobox', { name: '选择知识库资源', exact: true });
}

function popup(page: Page) {
  return page.locator('.knowledge-resource-tree-popup:visible');
}

function row(page: Page, title: string) {
  return popup(page)
    .locator('.ant-select-tree-treenode')
    .filter({ has: page.getByText(title, { exact: true }) });
}

async function expand(page: Page, title: string) {
  const node = row(page, title);
  await expect(node).toBeVisible();
  const switcher = node.locator('.ant-select-tree-switcher');
  if (
    await switcher.evaluate((element) =>
      element.classList.contains('ant-select-tree-switcher_close'),
    )
  )
    await switcher.click();
}

async function choose(page: Page, title: string) {
  await row(page, title).locator('.ant-select-tree-checkbox').click();
}

async function savePlugin(page: Page) {
  const request = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === '/api/platform/plugins/mcp/config' &&
      request.method() === 'PUT',
  );
  await page.getByRole('button', { name: '保存插件配置', exact: true }).click();
  const submitted = (await request).postDataJSON();
  await expect(page.locator('.form-success')).toContainText('插件配置已保存');
  return submitted.values.permissionPolicy as PermissionPolicy;
}

async function expectWithinViewport(page: Page, element: Locator) {
  const box = await element.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test('selecting a parent displays inherited descendants and saves only the parent identity', async ({
  page,
}, info) => {
  const knowledge = await openPlugin(page);
  await picker(page).click();
  await expand(page, '项目资料');
  await expand(page, '研究');
  const parent = await row(page, '项目资料').locator('.ant-select-tree-title').boundingBox();
  const child = await row(page, '入门指南.md').locator('.ant-select-tree-title').boundingBox();
  expect(child!.x).toBeGreaterThan(parent!.x);
  await choose(page, '项目资料');
  await expect(
    row(page, '研究').getByRole('checkbox', { name: '随父目录包含', exact: true }),
  ).toHaveAttribute('aria-checked', 'true');
  await expect(row(page, '入门指南.md').getByText('随父目录包含', { exact: true })).toBeVisible();
  await expect(knowledge).toContainText('已选 1 个目录 · 0 篇笔记');
  await expect(knowledge).toContainText('目录包含当前及以后新增的子目录和笔记。');
  await page.screenshot({
    path: info.outputPath('knowledge-parent-inclusion.png'),
    animations: 'disabled',
  });
  await picker(page).press('Escape');
  const saved = await savePlugin(page);
  expect(saved.domains.knowledge.resources).toEqual({
    mode: 'selected',
    resources: [{ kind: 'directory', id: 'projects' }],
  });
});

test('selecting every leaf in a directory never promotes them into a directory grant', async ({
  page,
}) => {
  const knowledge = await openPlugin(page);
  await picker(page).click();
  await expand(page, '项目资料');
  await expand(page, '研究');
  await choose(page, '入门指南.md');
  await choose(page, '设计笔记.md');
  await expect(row(page, '研究').locator('.ant-select-tree-checkbox')).not.toHaveClass(
    /checkbox-checked/,
  );
  await expect(knowledge).toContainText('已选 0 个目录 · 2 篇笔记');
  await picker(page).press('Escape');
  const saved = await savePlugin(page);
  expect(saved.domains.knowledge.resources).toEqual({
    mode: 'selected',
    resources: [
      { kind: 'note', id: 'guide' },
      { kind: 'note', id: 'design' },
    ],
  });
});

test('OAuth can narrow a parent ceiling to one child note without exposing adjacent paths', async ({
  page,
}) => {
  const ceiling = policy([{ kind: 'directory', id: 'projects' }]);
  await inventory(page, ceiling);
  await page.route('**/api/platform/mcp/oauth/request', (route) =>
    route.fulfill({
      json: {
        ownerId: 'tree-fixture-owner',
        clientId: 'resource-tree-client',
        clientName: '资源树授权验收',
        requestedScopes: ['knowledge:read'],
        allowedScopes: ['knowledge:read'],
        resource: 'http://127.0.0.1:4179/mcp',
        allowedPrefixes: ['项目资料'],
        allowedPolicy: ceiling,
      },
    }),
  );
  await page.route('**/api/platform/mcp/oauth/consent', (route) =>
    route.fulfill({
      json: { url: 'http://127.0.0.1:4179/?resource-tree-authorized=1' },
    }),
  );
  await page.goto('/oauth/consent?oauth_query=resource-tree-fixture');
  await expect(page.getByText('资源树授权验收', { exact: true })).toBeVisible();
  await picker(page).click();
  await expand(page, '项目资料');
  await expand(page, '研究');
  await expect(row(page, '项目资料-归档')).toHaveCount(0);
  await choose(page, '项目资料');
  await choose(page, '入门指南.md');
  await picker(page).press('Escape');
  const request = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === '/api/platform/mcp/oauth/consent' &&
      request.method() === 'POST',
  );
  await page.getByRole('button', { name: '允许访问', exact: true }).click();
  expect((await request).postDataJSON().permissionPolicy.domains.knowledge.resources).toEqual({
    mode: 'selected',
    resources: [{ kind: 'note', id: 'guide' }],
  });
});

test('search finds nested notes and Escape closes the popup without changing selection', async ({
  page,
}) => {
  await openPlugin(page);
  await picker(page).click();
  await picker(page).fill('入门指南');
  await expect(row(page, '入门指南.md')).toBeVisible();
  await expect(row(page, '机密.md')).toHaveCount(0);
  await choose(page, '入门指南.md');
  await picker(page).press('Escape');
  await expect(popup(page)).toHaveCount(0);
  await expect(picker(page)).toBeFocused();
  const saved = await savePlugin(page);
  expect(saved.domains.knowledge.resources).toEqual({
    mode: 'selected',
    resources: [{ kind: 'note', id: 'guide' }],
  });
});

test('long selections fold after two tags and remain removable without overflowing the viewport', async ({
  page,
}) => {
  const knowledge = await openPlugin(page, [
    { kind: 'note', id: 'long-note' },
    { kind: 'note', id: 'guide' },
    { kind: 'note', id: 'design' },
    { kind: 'note', id: 'unavailable-note' },
  ]);
  const selector = knowledge.locator('.ant-select').filter({ has: picker(page) });
  await expect(selector.locator('.ant-select-selection-item')).toHaveCount(3);
  await expect(selector).toContainText('另 2 项');
  await expectWithinViewport(page, selector);
  await picker(page).click();
  const missing = row(page, '笔记 · unavailable-note（当前不可用或未加载）');
  await expect(missing).toBeVisible();
  await expectWithinViewport(page, popup(page));
  await missing.locator('.ant-select-tree-checkbox').click();
  await picker(page).press('Escape');
  await expect(selector).toContainText('另 1 项');
  const saved = await savePlugin(page);
  expect(saved.domains.knowledge.resources).toEqual({
    mode: 'selected',
    resources: [
      { kind: 'note', id: 'long-note' },
      { kind: 'note', id: 'guide' },
      { kind: 'note', id: 'design' },
    ],
  });
});
