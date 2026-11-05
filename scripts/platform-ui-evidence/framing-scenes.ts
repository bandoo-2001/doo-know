/** Explicit supplementary scroll frames; they do not replace original views. */
import { randomUUID } from 'node:crypto';
import { expect, type Locator, type Page } from '@playwright/test';
import { scenes } from './scenes';
import { settingsScenes } from './settings-scenes';
import { workspaceScenes } from './workspace-scenes';
import type { Scene } from './model';

const originals = [...scenes, ...settingsScenes, ...workspaceScenes];
function frame(id: string, locate: (page: Page) => Locator, assertState?: (page: Page) => Promise<void>): Scene {
  const source = originals.find(scene => scene.id === id);
  if (!source) throw Error('Missing framing source: ' + id);
  return {
    ...source,
    id: id + '-state-frame',
    title: source.title + ' · supplementary state frame',
    state: source.state + '; explicit scroll to the actual state region',
    representative: false,
    target: locate,
    open: async env => {
      await source.open?.(env);
      await assertState?.(env.page);
      const region = locate(env.page);
      await expect(region).toBeVisible();
      await region.scrollIntoViewIfNeeded();
      await expect(region).toBeInViewport();
    },
  };
}

const originalSiteThemes = new WeakMap<Page, 'system' | 'light'>();
const readingScene = originals.find(scene => scene.id === 'public-reader')!;

export const framingScenes: Scene[] = [
  {
    ...readingScene, id: 'public-reader-system-theme', title: '公开文章跟随系统主题',
    state: 'Published site explicitly follows real browser color preference',
    before: async ({ page, fixture }) => {
      const settings = await fixture.api('/api/blog/settings');
      originalSiteThemes.set(page, settings.theme);
      await fixture.api('/api/blog/settings', 'PATCH', { settings: { ...settings, theme: 'system' }, requestId: randomUUID() });
    },
    open: async ({ page, variant }) => {
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'system');
      await expect(page.locator('html')).toHaveCSS('color-scheme', variant.theme);
      await expect(page.getByRole('heading', { name: '让知识保持可用', exact: true }).first()).toBeVisible();
    },
    afterCapture: async ({ page, fixture }) => {
      const settings = await fixture.api('/api/blog/settings');
      await fixture.api('/api/blog/settings', 'PATCH', { settings: { ...settings, theme: originalSiteThemes.get(page) }, requestId: randomUUID() });
      return { publishedThemeRestored: true };
    },
  },
  frame('ws-extra-trash-request-uncertain', page => page.locator('.trash-workspace .callout[role="status"]')
    .filter({ has: page.getByRole('button', { name: '按原请求核对结果', exact: true }) })),
  frame('ws-extra-fragment-preview', page => page.locator('.large-preview').getByRole('heading', { name: 'Large capture', exact: true })),
  {
    ...originals.find(scene => scene.id === 'directory-open')!,
    id: 'directory-search-results-frame', sourceIds: ['WS-003'], title: '目录中实际搜索结果',
    state: 'Actual filename match in opened notebook search', representative: false,
    target: '#notebook-navigation',
    open: async env => {
      await originals.find(scene => scene.id === 'directory-open')!.open!(env);
      const note = await env.fixture.api('/api/notes/' + env.fixture.noteId);
      const fileName = note.relativePath.split('/').pop().replace(/\.md$/, '');
      const nav = env.page.locator('#notebook-navigation');
      await nav.getByRole('textbox', { name: '搜索笔记与目录', exact: true }).fill(fileName);
      const result = nav.locator('.search-result').filter({ hasText: fileName });
      await expect(result.first()).toBeVisible();
      await expect(nav.locator('.tree-scroll')).toHaveAttribute('aria-busy', 'false', { timeout: 30000 });
    },
  },
  frame('mcp-create-client', page => page.getByRole('textbox', { name: '客户端名称', exact: true }),
    async page => { await expect(page.getByRole('combobox', { name: '密钥有效期', exact: true })).toBeVisible(); }),
  frame('preferences-preview', page => page.locator('.editor-preview'), async page => { await expect(page.locator('.editor-preview-details')).toHaveJSProperty('open', true); }),
  frame('settings-extra-client-cas-conflict', page => page.locator('.api-clients .ant-alert').filter({ hasText:
    '客户端或授权已经变化，当前输入已保留。请重新载入后检查并保存。',
  }), async page => { await expect(page.getByRole('button', { name: '保存客户端名称', exact: true })).toBeDisabled(); }),
  frame('settings-extra-client-permission-conflict', page => page.locator('.api-clients .ant-alert').filter({ hasText:
    '客户端或授权已经变化，当前输入已保留。请重新载入后检查并保存。',
  }), async page => { await expect(page.getByRole('button', { name: '保存客户端权限', exact: true })).toBeDisabled(); }),
  frame('settings-extra-oauth-narrow-error', page => page.locator('.client-permissions .ant-alert').filter({ hasText: '未能确认权限更新，请刷新连接状态后核对。' })),
  frame('settings-extra-oauth-revoke-error', page => page.locator('.mcp-guide > .ant-alert-error').filter({ hasText: '撤销未完成，请刷新状态后核对并重试。' })),
  frame('settings-extra-plugin-config-conflict', page => page.locator('.plugin-settings .ant-alert')
    .filter({ hasText: '已保存配置在其他位置发生变化' })),
  frame('settings-extra-plugin-restart-warning', page => page.locator('.plugin-settings .ant-alert')
    .filter({ hasText: '配置或版本需要重启生效' })),
  frame('settings-extra-import-preview-error', page => page.getByRole('dialog', { name: '批量导入', exact: true }).locator('.ant-alert-error').filter({ hasText: 'IMPORT_PREVIEW_STALE' }),
    async page => { await expect(page.getByRole('dialog', { name: '批量导入', exact: true }).getByRole('button', { name: '预览导入', exact: true })).toBeEnabled(); }),
  {
    id: 'library-storage-state-frame', sourceIds: ['ST-013'], title: '存储占用 · 独立状态帧',
    state: 'Actual loaded storage table in viewport', role: 'owner',
    path: '/?view=settings&section=library', target: '.storage-settings',
    open: async ({ page }) => {
      const region = page.locator('.storage-settings');
      await expect(region.locator('.storage-table')).toBeVisible();
      await region.scrollIntoViewIfNeeded();
    },
    tests: ['tests/e2e/management-workspace.spec.ts'],
  },
  {
    id: 'library-organization-state-frame', sourceIds: ['ST-014'], title: '批量整理 · 独立状态帧',
    state: 'Actual organization controls in viewport', role: 'owner',
    path: '/?view=settings&section=library',
    target: page => page.locator('.settings-card').filter({
      has: page.getByRole('heading', { name: '批量整理', exact: true }),
    }),
    open: async ({ page }) => {
      await page.getByRole('heading', { name: '批量整理', exact: true }).scrollIntoViewIfNeeded();
    },
    tests: ['tests/e2e/organization-retention.spec.ts'],
  },
  {
    id: 'library-git-state-frame', sourceIds: ['ST-074'], title: '云端仓库概览 · 独立状态帧',
    state: 'Actual Git connection panel in viewport; connection state comes from its real API',
    role: 'owner', path: '/?view=settings&section=library', target: '.git-remote-panel',
    open: async ({ page }) => {
      const region = page.locator('.git-remote-panel');
      await expect(region).toBeVisible();
      await expect(region.getByRole('button', { name: '刷新同步状态', exact: true })).not.toHaveClass(/ant-btn-loading/);
      await expect(region.getByRole('button', { name: /^(管理同步|关联云端仓库)$/ })).toBeVisible();
      await region.scrollIntoViewIfNeeded();
    },
    tests: ['tests/e2e/settings-overlays.spec.ts'],
  },
];
