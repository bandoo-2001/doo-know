import { expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { closeSidebar, showSidebar, showMainMenu, configurePlugin } from '../../tests/support/settings-navigation';
import { showSource, showRead, showSplit } from '../../tests/support/editor-navigation';
import { clickNoteAction } from '../../tests/support/note-actions';
import { openGraphPanel, chooseGraphMode } from '../../tests/support/graph-navigation';
import { openPrimaryDiagram } from './workspace-scenes';
import type { Scene, SceneEnv } from './model';

const notePath = (fixture: SceneEnv['fixture']) => '/?note=' + fixture.noteId;
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const dialog = (name: string) => (page: Page) => page.getByRole('dialog', { name, exact: true });
const click = (name: string) => async ({ page }: SceneEnv) => { await button(page, name).click(); };
const note = (id: string, sourceIds: string[], state: string, target: Scene['target'], open?: Scene['open']): Scene => ({
  id, sourceIds, title: state, state, role: 'owner', path: notePath, target, open,
  tests: ['tests/e2e/document-editor-controls.spec.ts', 'tests/e2e/editor-secondary-menus.spec.ts'],
});
const setting = (id: string, sourceIds: string[], section: string, state: string, target: Scene['target'], open?: Scene['open']): Scene => ({
  id, sourceIds, title: state, state, role: 'owner', path: '/?view=settings&section=' + section, target, open,
  tests: ['tests/e2e/settings-overlays.spec.ts', 'tests/e2e/management-workspace.spec.ts'],
});
async function createMenu({ page }: SceneEnv) {
  await showSidebar(page); await button(page, '创建与导入').click();
}
const createWindow = (name: string) => async (env: SceneEnv) => {
  await createMenu(env); await env.page.getByRole('dialog', { name: '创建与导入', exact: true }).getByRole('button', { name, exact: true }).click();
};
async function source({ page }: SceneEnv) { await showSource(page); }
async function rich({ page }: SceneEnv) {
  await button(page, '文档编辑').click();
  await expect(page.getByRole('textbox', { name: '文档正文', exact: true })).toBeVisible();
}
async function share({ page }: SceneEnv) { await button(page, '分享').click(); }
async function mcp(env: SceneEnv) {
  await configurePlugin(env.page, 'MCP 服务');
  const enable = env.page.locator('.plugin-settings').getByRole('button', { name: '启用插件', exact: true });
  if (await enable.isVisible()) await enable.click();
}
async function guestEditor({ page }: SceneEnv) {
  await button(page, '编辑笔记').click();
  await expect(page.locator('.public-share-editor .cm-content, .public-share-editor .tiptap').first()).toBeVisible();
}
async function guestSource(env: SceneEnv) { await guestEditor(env); await button(env.page, 'Markdown 源码').click(); }
const graphFixtures = new WeakMap<Page, { query: string; titles: string[]; layout?: unknown }>();
async function graphNoteFixture(env: SceneEnv) {
  const query = 'graph-' + randomUUID().slice(0, 8), titles = ['起点 A', '终点 B', '独立 C'].map(label => label + ' ' + query);
  for (const [index, suffix] of ['target', 'source', 'orphan'].entries()) {
    await env.fixture.api('/api/notes', 'POST', { folderPath: '00-Inbox', fileName: query + '-' + suffix + '.md',
      content: '# ' + titles[index] + (index === 1 ? '\n\n[[' + query + '-target]]\n' : '\n'), requestId: randomUUID() });
  }
  await expect.poll(async () => (await env.fixture.api('/api/graph/explore?view=notes&q=' + query)).nodes.length,
    { timeout: 30000 }).toBe(3);
  graphFixtures.set(env.page, { query, titles });
}
async function stableNoteGraph(env: SceneEnv) {
  const sample = graphFixtures.get(env.page)!;
  await chooseGraphMode(env.page, '图谱类型', '笔记');
  await env.page.getByRole('searchbox', { name: '搜索图谱', exact: true }).fill(sample.query);
  await chooseGraphMode(env.page, '显示方式', '画布');
  const canvas = env.page.locator('.graph-canvas');
  await expect(canvas.locator('canvas').first()).toBeVisible({ timeout: 30000 });
  await expect(env.page.locator('.graph-summary')).toContainText('3 个节点', { timeout: 30000 });
  await button(env.page, '适应画布').click();
  let previous = '', stableSamples = 0;
  await expect.poll(async () => {
    const snapshot = await canvas.evaluate(element => {
      const cy = (element as HTMLElement & { _cyreg?: { cy?: import('cytoscape').Core } })._cyreg?.cy;
      if (!cy) return null;
      return { nodes: cy.nodes().map(node => ({ id: node.id(), title: String(node.data('label') ?? ''),
        position: node.position(), renderedPosition: node.renderedPosition(), bounds: node.renderedBoundingBox({ includeLabels: true }), animated: node.animated() })),
        edgeCount: cy.edges().length, zoom: cy.zoom(), pan: cy.pan() };
    });
    if (!snapshot || snapshot.nodes.length !== 3 || snapshot.nodes.some(node => node.animated || !sample.titles.includes(node.title))) { stableSamples = 0; return false; }
    snapshot.nodes.sort((a, b) => a.id.localeCompare(b.id));
    const current = JSON.stringify(snapshot);
    stableSamples = current === previous ? stableSamples + 1 : 0; previous = current;
    if (stableSamples >= 3) { sample.layout = snapshot; return true; } return false;
  }, { timeout: 30000, intervals: [200, 250, 300] }).toBe(true);
}

export const scenes: Scene[] = [
  { id: 'workspace-ready', sourceIds: ['WS-001'], title: '知识工作区', state: 'Ready with no selected note', role: 'owner', path: '/', target: '.workspace', representative: true,
    importantStates: { 'WS-001': ['Ready with no selected note'] }, tests: ['tests/e2e/platform-shared-ui.spec.ts'] },
  { id: 'directory-open', sourceIds: ['WS-002', 'WS-003', 'WS-103'], title: '笔记目录与搜索', state: 'Actual notebook drawer / directory tree', role: 'owner', path: '/', target: '#notebook-navigation', open: async ({ page }) => { await showSidebar(page); }, representative: true,
    verify: async ({ page }) => { const field = page.getByPlaceholder('搜索笔记与目录'); await field.fill('最终界面取证'); await expect(field).toBeFocused(); return { action: 'real directory search input', focused: true }; }, tests: ['tests/e2e/platform-shared-ui.spec.ts'] },
  { id: 'folder', sourceIds: ['WS-006'], title: '目录内容', state: 'Populated folder', role: 'owner', path: '/?folder=00-Inbox', target: '.folder-view', tests: ['tests/e2e/workspace.spec.ts'] },
  ...(['recent', 'favorites'] as const).map((view, i): Scene => ({ id: view, sourceIds: [i ? 'WS-008' : 'WS-007', 'WS-009'], title: view, state: 'Actual collection response', role: 'owner', path: '/?view=' + view, target: '.collection-workspace', tests: ['tests/e2e/note-collections.spec.ts'] })),
  { id: 'apps', sourceIds: ['WS-084'], title: '应用入口', state: 'Native applications home', role: 'owner', path: '/?view=apps', target: '.apps-home', tests: ['tests/e2e/apps-layout.spec.ts'] },
  { id: 'create-menu', sourceIds: ['WS-004'], title: '创建与导入', state: 'Open create menu', role: 'owner', path: '/', target: '.create-menu', open: createMenu, window: true, representative: true, tests: ['tests/e2e/platform-shared-ui.spec.ts'] },
  ...[['new-note', 'WS-011', '新建笔记'], ['new-folder', 'WS-012', '新建文件夹'], ['new-whiteboard', 'WS-013', '新建白板'], ['new-mindmap', 'WS-014', '新建脑图'], ['new-flowchart', 'WS-015', '新建流程图']].map(([id, sourceId, name]): Scene => ({
    id, sourceIds: [sourceId], title: name, state: 'Empty create form and original guards', role: 'owner', path: '/', target: dialog(name), open: createWindow(name), window: true, representative: true, tests: ['tests/e2e/diagram-document-chrome.spec.ts', 'tests/e2e/create-guidance.spec.ts'] })),
  { id: 'directory-picker', sourceIds: ['WS-023', 'ST-015'], title: '目录选择树', state: 'Actual tree selector popup', role: 'owner', path: '/', target: '.directory-tree-popup:visible', window: true,
    open: async env => { await createWindow('新建笔记')(env); await env.page.locator('.directory-select .ant-select-selector').click(); }, tests: ['tests/e2e/resource-tree-select.spec.ts'] },
  { ...note('source', ['WS-025', 'WS-105'], 'Markdown source editing', '.document-body', source), representative: true },
  note('split', ['WS-026'], 'Source with live preview', '.document-body', async ({ page }) => { await showSplit(page); }),
  note('read', ['WS-027'], 'Saved reading preview', '.preview-panel', async ({ page }) => { await showRead(page); }),
  note('note-more', ['WS-028'], 'Open note actions', '.note-action-menu', click('更多操作')),
  ...[['note-move', 'WS-017', '移动或重命名'], ['note-trash', 'WS-020', '删除笔记'], ['note-history', 'WS-064', '历史版本']].map(([id, sourceId, name]): Scene => ({
    ...note(id, [sourceId], name, sourceId === 'WS-064' ? '.note-history-dialog' : '.n-modal:visible, .ant-modal:visible, .ant-modal-confirm:visible', async ({ page }) => { await clickNoteAction(page, name); }), window: true, representative: true })),
  { id: 'note-copy', sourceIds: ['WS-019'], title: '创建文档副本', state: 'Real saved note copy dialog before confirmation', role: 'owner', path: '/?folder=00-Inbox', target: dialog('创建文档副本'), window: true,
    open: async ({ page, fixture }) => { const note = await fixture.api('/api/notes/' + fixture.noteId); const name = note.relativePath.split('/').at(-1).replace(/\.md$/, ''); await page.locator('.folder-entry-open').filter({ hasText: name }).first().click({ button: 'right' }); await page.getByRole('menuitem', { name: '创建副本', exact: true }).click(); }, tests: ['tests/e2e/document-copy.spec.ts'] },
  { id: 'import-markdown', sourceIds: ['WS-022'], title: '导入 Markdown', state: 'Actual import entry form', role: 'owner', path: '/',
    target: page => page.locator('.n-card:visible').filter({ has: page.locator('.n-card-header__main').filter({ hasText: '导入 Markdown' }) }),
    open: async env => { await createMenu(env); await env.page.getByRole('dialog', { name: '创建与导入', exact: true }).getByRole('button', { name: '导入 Markdown', exact: true }).click();
      const form = env.page.locator('.n-card:visible').filter({ has: env.page.locator('.n-card-header__main').filter({ hasText: '导入 Markdown' }) });
      await expect(form.getByRole('combobox', { name: '导入目录', exact: true })).toBeVisible(); await expect(form.getByLabel('选择 Markdown 文件', { exact: true })).toBeVisible();
      await expect(form.getByRole('button', { name: '完成', exact: true })).toBeEnabled(); }, window: true, tests: ['tests/e2e/portable-data.spec.ts'] },
  ...[['quick-insert', 'WS-042', '快捷插入'], ['properties', 'WS-043', '笔记属性'], ['markdown-paste', 'WS-044', '按 Markdown 粘贴'], ['backlinks', 'WS-046', '反向引用'], ['insert-whiteboard', 'WS-102', '插入白板']].map(([id, sourceId, name]): Scene => ({
    ...note(id, [sourceId], name, '.n-modal:visible, .ant-modal:visible, .settings-overlay:visible', async env => { await source(env); await button(env.page, name).click(); }), window: true, tests: ['tests/e2e/editor-secondary-menus.spec.ts', 'tests/e2e/note-backlinks.spec.ts'] })),
  note('source-find', ['WS-045'], 'Source find and replace', '.cm-search, .editor-search', async env => { await source(env); await env.page.locator('.cm-content').click(); await env.page.keyboard.press('Control+h'); await expect(env.page.getByRole('textbox', { name: '查找内容', exact: true })).toBeVisible(); }),
  note('outline', ['WS-047'], 'Document outline', '[aria-label="本文章节"]:visible', async ({ page }) => { if (!await page.getByRole('navigation', { name: '本文章节', exact: true }).isVisible()) await button(page, '章节目录').click(); }),
  { ...note('rich-editor', ['WS-024', 'WS-029', 'WS-083'], 'Rich document editor and actual formatting controls', '.document-body', rich), requires: 'document-editor', representative: true },
  ...[['paragraph', 'WS-030', '段落格式'], ['insert-table', 'WS-031', '插入表格'], ['text-color', 'WS-032', '文字颜色']].map(([id, sourceId, name]): Scene => ({
    ...note(id, [sourceId], name, sourceId === 'WS-030' ? '[role="listbox"][aria-label="段落样式"]' : sourceId === 'WS-031' ? '[role="dialog"][aria-label="插入表格"]' : '.text-color-palette', async env => { await rich(env); if (sourceId === 'WS-030') await env.page.getByRole('combobox', { name, exact: true }).click(); else await button(env.page, name).click(); }), requires: 'document-editor', window: true, representative: true })),
  { ...note('rich-link', ['WS-037'], 'Edit document link fields', '.document-link-fields', async env => { await rich(env); await env.page.getByRole('textbox', { name: '文档正文', exact: true }).click(); await button(env.page, '插入链接').click(); }), requires: 'document-editor', window: true },
  { ...note('rich-table-context', ['WS-034'], 'Contextual table controls', '[role="toolbar"][aria-label="表格操作"]', async env => { await rich(env); await env.page.locator('.tiptap td').first().click(); }), requires: 'document-editor', window: true },
  ...[['private', 'WS-114'], ['active', 'WS-115'], ['expired', 'WS-116'], ['revoked', 'WS-117']].map(([state, sourceId]): Scene => ({
    ...note('share-' + state, ['WS-099', sourceId], 'Share ' + state, '.share-dialog', async env => {
      await share(env); const surface = env.page.locator('.share-dialog');
      await expect(surface.locator('.share-badge')).toHaveText({ private: '私人笔记', active: '分享已开启', expired: '分享已到期', revoked: '分享已取消' }[state]!);
      if (state !== 'active') { await expect(surface.getByRole('button', { name: '生成分享链接', exact: true })).toBeVisible(); await expect(surface.getByRole('button', { name: '取消分享', exact: true })).toHaveCount(0); await expect(surface.getByLabel('公开链接', { exact: true })).toHaveCount(0); }
    }),
    path: fixture => '/?note=' + (state === 'private' ? fixture.privateNoteId : state === 'revoked' ? fixture.revokedNoteId : state === 'expired' ? fixture.expiredNoteId : fixture.noteId), window: true, representative: true,
    tests: ['tests/e2e/share-management-expiry.spec.ts'] })),
  { ...note('share-custom-expiry', ['WS-118'], 'Share custom expiration form', '.share-dialog', async env => { await share(env); await env.page.getByRole('combobox', { name: '链接有效期', exact: true }).selectOption('custom'); }), window: true },
  { ...note('share-edit-permission', ['WS-120'], 'Share edit permission explanation', '.share-dialog', async env => { await share(env); await env.page.getByRole('combobox', { name: '分享权限', exact: true }).selectOption('edit'); }), window: true },
  { ...note('share-copy', ['WS-122'], 'Actual copy feedback or manual fallback', '.share-dialog', async env => { await share(env); await button(env.page, '复制链接').click(); }), window: true },
  { id: 'account-menu', sourceIds: ['WS-097'], title: '个人账户菜单', state: 'Open account menu', role: 'owner', path: '/', target: '.account-popup', open: async ({ page }) => { await showMainMenu(page); await button(page, '个人账户').click(); }, window: true, tests: ['tests/e2e/app-main-menu.spec.ts'] },
  { id: 'compact-navigation', sourceIds: ['WS-098'], title: '更多导航', state: 'Open actual compact navigation sheet', role: 'owner', path: '/', target: '.workspace-footer', open: async ({ page }) => { await showMainMenu(page); }, widths: [390, 320, 360, 844, 820], tests: ['tests/e2e/responsive-tabbar.spec.ts'] },
  { id: 'trash-empty', sourceIds: ['WS-107', 'WS-110'], title: '回收站', state: 'Actual empty trash response', role: 'owner', path: '/?view=trash', target: '.trash-workspace', tests: ['tests/e2e/folder-trash.spec.ts'] },
  ...['editor', 'library', 'search', 'backup', 'status', 'plugins', 'account', 'about'].map((section, i): Scene => ({
    ...setting('settings-' + section, [['ST-001'], ['ST-002', 'ST-013', 'ST-014', 'ST-016', 'ST-025', 'ST-028', 'ST-037', 'ST-074'], ['ST-003', 'ST-038'], ['ST-004', 'ST-029', 'ST-034'], ['ST-005'], ['ST-006', 'ST-047'], ['ST-007'], ['ST-008']][i], section, 'Actual settings ' + section, '.settings-workspace'), representative: true,
  })),
  { ...setting('shortcuts', ['ST-009'], 'editor', 'Keyboard operations dialog', dialog('键盘操作'), click('查看快捷键')), window: true, representative: true,
    afterCapture: async ({ page }) => { await page.keyboard.press('Escape'); await expect(page.getByRole('dialog', { name: '键盘操作', exact: true })).toBeHidden(); await expect(button(page, '查看快捷键')).toBeFocused(); return { escape: 'closed', focusReturn: 'trigger' }; } },
  setting('preferences-preview', ['ST-010'], 'editor', 'Expanded preference preview', '[aria-label="编辑器显示预览"]', async ({ page }) => { await page.locator('summary').filter({ hasText: '显示预览' }).click(); }),
  setting('preferences-dirty', ['ST-011'], 'editor', 'Unsaved preference controls', '.settings-workspace', async ({ page }) => { await page.getByRole('switch', { name: '自动换行', exact: true }).click(); await expect(button(page, '取消更改')).toBeEnabled(); }),
  setting('status-details', ['ST-041'], 'status', 'Actual expanded service details', '.settings-workspace', async ({ page }) => { for (const summary of await page.locator('summary').all()) { if (await summary.isVisible()) await summary.click(); } }),
  ...[['password', 'ST-043', 'account', '修改密码'], ['recovery-key', 'ST-030', 'backup', '下载恢复密钥'], ['restore-backup', 'ST-032', 'backup', '从备份恢复'], ['import-files', 'ST-018', 'library', '批量导入'], ['import-portable', 'ST-022', 'library', '导入便携包'], ['export-files', 'ST-024', 'library', '导出资料']].map(([id, sourceId, section, title]): Scene => ({
    ...setting(id, [sourceId], section, title, dialog(title), click(title)), window: true, representative: true })),
  { ...setting('password-errors', ['ST-044'], 'account', 'Original password form validation', dialog('修改密码'), async env => { await click('修改密码')(env); await button(env.page, '更新密码').click(); await expect(env.page.locator('#current-password-error')).toContainText('请输入当前密码'); }), window: true },
  { ...setting('password-discard', ['ST-089'], 'account', 'Actual unsaved password dismissal prompt', dialog('修改密码'), async env => { await click('修改密码')(env); await env.page.getByLabel('当前密码', { exact: true }).fill('fixture-unsaved'); await env.page.keyboard.press('Escape'); await expect(env.page.locator('.settings-discard-prompt')).toBeVisible(); }), window: true },
  ...[['import-preview', 'ST-019'], ['import-review', 'ST-020']].map(([id, sourceId]): Scene => ({
    ...setting(id, [sourceId], 'library', 'Actual import ' + sourceId, dialog('批量导入'), async env => {
      await click('批量导入')(env); const window = env.page.getByRole('dialog', { name: '批量导入', exact: true });
      let submitted = 0;
      env.page.on('request', request => { if (new URL(request.url()).pathname === '/api/manage/import' && request.method() === 'POST') submitted++; });
      const name = 'runtime-' + randomUUID() + '.md';
      await window.getByLabel('选择文件', { exact: true }).setInputFiles({ name, mimeType: 'text/markdown', buffer: Buffer.from('# 隔离导入\n') });
      const preview = env.page.waitForResponse(response => new URL(response.url()).pathname === '/api/manage/import/preview' && response.request().method() === 'POST');
      await window.getByRole('button', { name: '预览导入', exact: true }).click();
      expect((await preview).ok()).toBe(true);
      await expect(window.getByRole('heading', { name: '检查导入预览', exact: true })).toBeVisible();
      await expect(window.getByRole('row').filter({ hasText: name })).toContainText('新建');
      if (sourceId === 'ST-020') {
        await window.getByRole('button', { name: '下一步：确认导入', exact: true }).click();
        await expect(window.getByRole('heading', { name: '确认本次导入', exact: true })).toBeVisible();
        await expect(window.locator('.transfer-review')).toContainText('00-Inbox');
        await expect(window.getByRole('button', { name: '确认导入 1 个文件', exact: true })).toBeEnabled();
      }
      expect(submitted).toBe(0);
    }), window: true })),
  { ...setting('git-connection', ['ST-075'], 'library', 'Manage cloud sync drawer', dialog('管理云端同步'), async ({ page }) => { await page.getByRole('region', { name: '云端同步面板', exact: true }).getByRole('button', { name: /^(管理同步|关联云端仓库)$/ }).click(); }), window: true, representative: true },
  { ...setting('git-credentials', ['ST-076'], 'library', 'HTTPS credential child dialog', dialog('添加凭据'), async ({ page }) => {
    await page.getByRole('region', { name: '云端同步面板', exact: true }).getByRole('button', { name: /^(管理同步|关联云端仓库)$/ }).click(); await button(page, '添加凭据').click();
  }), window: true, representative: true },
  setting('plugin-catalog', ['ST-048'], 'plugins', 'Add plugin catalog', '.plugin-manager', async ({ page }) => { await page.getByRole('tab', { name: '添加插件', exact: true }).click(); }),
  setting('mcp-config', ['ST-049', 'ST-056', 'ST-057', 'ST-059', 'ST-062', 'ST-073'], 'plugins', 'Actual MCP settings and domain policy', '.plugin-settings', mcp),
  setting('mcp-api-guide', ['ST-058', 'ST-064'], 'plugins', 'API key connection guide', '.plugin-settings', async env => { await mcp(env); await click('API Key 接入')(env); }),
  { ...setting('mcp-create-client', ['ST-065'], 'plugins', 'Create API client form', '.mcp-api-client-form, [aria-label="创建 API 客户端"], .api-client-form', async env => { await mcp(env); await click('API Key 接入')(env); await click('创建 API 客户端')(env); }), window: true },
  setting('git-plugin-config', ['ST-050', 'ST-082'], 'plugins', 'Actual Git plugin settings', '.plugin-settings', async ({ page }) => { await configurePlugin(page, 'Git 版本管理'); }),
  { ...setting('plugin-uninstall', ['ST-053'], 'plugins', 'Uninstall confirmation only', dialog('卸载插件'), async env => {
    await mcp(env);
    await env.page.locator('.plugin-settings').getByRole('button', { name: '卸载插件', exact: true }).click();
    const window = env.page.getByRole('dialog', { name: '卸载插件', exact: true });
    await expect(window.getByText('卸载后保留插件配置与数据。', { exact: true })).toBeVisible();
    await expect(window.getByRole('button', { name: '确认卸载', exact: true })).toBeEnabled();
  }), window: true },
  { id: 'login', sourceIds: ['PB-001'], title: '登录', state: 'Empty required fields; submit disabled', role: 'anonymous', path: '/', target: '.login-card', representative: true, tests: ['tests/e2e/login-help.spec.ts'] },
  { id: 'login-help', sourceIds: ['PB-002'], title: '首次使用帮助', state: 'Expanded account source help', role: 'anonymous', path: '/', target: '.login-card', open: async ({ page }) => { await page.getByText('第一次使用或还没有账号？', { exact: true }).click(); }, tests: ['tests/e2e/login-help.spec.ts'] },
  { id: 'session-unavailable', sourceIds: ['PB-005'], title: '登录状态读取失败', state: 'Actual bootstrap transport failure with working retry', role: 'anonymous', path: '/', target: '.share-error', readiness: 'target',
    before: async ({ page }) => { await page.route('**/api/auth/get-session', route => route.abort('connectionfailed'), { times: 1 }); },
    open: async ({ page }) => { await expect(page.getByRole('heading', { name: '暂时无法确认登录状态', exact: true })).toBeVisible(); await expect(button(page, '重试连接')).toBeEnabled(); await expect(page.getByLabel('用户名', { exact: true })).toHaveCount(0); },
    afterCapture: async ({ page }) => { const session = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/get-session'); await button(page, '重试连接').click(); expect((await session).ok()).toBe(true); await expect(page.getByLabel('用户名', { exact: true })).toBeVisible(); return { realSessionRetryReachedLogin: true }; },
    fault: 'Only first auth session network transport aborted; retry continues to the actual anonymous session API and login renderer.', tests: ['tests/e2e/session-bootstrap-retry.spec.ts'] },
  { id: 'share-reader', sourceIds: ['PB-022'], title: '公开只读分享', state: 'Saved public projection', role: 'public-reader', path: fixture => fixture.shares[0], target: '.share-page', representative: true, tests: ['tests/e2e/sharing-permissions.spec.ts'] },
  { id: 'share-missing', sourceIds: ['PB-024'], title: '分享已失效', state: 'Actual 404 capability response', role: 'public-reader', path: '/s/runtime-missing-share', target: '.share-error', tests: ['tests/e2e/sharing-permissions.spec.ts'] },
  { id: 'guest-document', sourceIds: ['PB-026'], title: '访客文档编辑', state: 'Editable capability document mode', role: 'guest-editor', path: fixture => fixture.shares[1], target: '.public-share-editor', open: guestEditor, requires: 'document-editor', representative: true, tests: ['tests/e2e/sharing-permissions.spec.ts'] },
  { id: 'guest-source', sourceIds: ['PB-027'], title: '访客源码', state: 'Editable capability source mode', role: 'guest-editor', path: fixture => fixture.shares[1], target: '.public-share-editor', open: guestSource, tests: ['tests/e2e/sharing-permissions.spec.ts'] },
  { id: 'guest-discard', sourceIds: ['PB-029'], title: '访客未保存离开', state: 'Actual dirty-source leave confirmation', role: 'guest-editor', path: fixture => fixture.shares[1], target: '[role="dialog"]', window: true,
    open: async env => { await guestSource(env); await env.page.locator('.cm-content').fill('# 访客尚未保存\n\n隔离草稿。'); await button(env.page, '返回阅读').click(); }, tests: ['tests/e2e/sharing-permissions.spec.ts'] },
  { id: 'oauth-invalid', sourceIds: ['PB-020'], title: '无效 OAuth', state: 'Actual invalid authorization request', role: 'owner', path: '/oauth/consent', target: '.oauth-consent, .share-error, .login-card', tests: ['tests/e2e/oauth.spec.ts'] },
  { id: 'oauth-consent', sourceIds: ['PB-019'], title: 'OAuth 兼容授权', state: 'Actual legacy scope/directory consent; V2 has its own distinct scene', role: 'owner', path: fixture => fixture.oauthPath ?? '/oauth/consent', target: '.oauth-consent',
    before: async ({ fixture }) => { if (!fixture.oauthPath) throw Error('UNAVAILABLE: real fixture OAuth registration rejected'); },
    open: async ({ page }) => { await expect(page.locator('.oauth-consent .scope-row')).not.toHaveCount(0); await expect(page.locator('.oauth-consent .directory-row')).not.toHaveCount(0); await expect(page.locator('.oauth-consent .domain-permissions')).toHaveCount(0); }, representative: true, tests: ['tests/e2e/oauth.spec.ts'] },
  ...['overview', 'articles', 'taxonomy', 'settings', 'design'].map((section, i): Scene => ({ id: 'blog-' + section, sourceIds: [['PB-030'], ['PB-031'], ['PB-039'], ['PB-040'], ['PB-041', 'PB-046']][i], title: '博客管理 ' + section, state: 'Actual blog ' + section, role: 'owner', path: '/?view=apps&app=blog&appSection=' + section, target: '.blog-workspace', representative: true, tests: ['tests/e2e/blog-admin-content.spec.ts', 'tests/e2e/blog-studio.spec.ts'] })),
  ...[['modules', 'PB-042', '首页模块'], ['collections', 'PB-043', '专题合集'], ['navigation', 'PB-044', '导航与链接'], ['projects', 'PB-045', '项目作品']].map(([id, sourceId, name]): Scene => ({ id: 'blog-design-' + id, sourceIds: [sourceId], title: name, state: 'Actual studio section ' + name, role: 'owner', path: '/?view=apps&app=blog&appSection=design', target: '.blog-studio', open: click(name), tests: ['tests/e2e/blog-studio.spec.ts'] })),
  { id: 'blog-note-picker', sourceIds: ['PB-033'], title: '选择博客笔记', state: 'Actual owner note picker', role: 'owner', path: '/?view=apps&app=blog&appSection=articles', target: dialog('选择一篇笔记'), open: async ({ page }) => { await page.locator('.blog-workspace > header').getByRole('button', { name: '选择笔记', exact: true }).click(); await expect(page.getByRole('dialog', { name: '选择一篇笔记', exact: true })).toBeVisible(); }, window: true, tests: ['tests/e2e/blog-admin-content.spec.ts'] },
  { id: 'blog-article-editor', sourceIds: ['PB-032'], title: '博客发布信息', state: 'Selected actual published fixture article; cover remains a separate frame', role: 'owner', path: '/?view=apps&app=blog&appSection=articles', target: '.blog-workspace',
    open: async ({ page }) => { await page.locator('.blog-post-option').filter({ hasText: '让知识保持可用' }).first().click(); await expect(page.locator('.blog-article-detail')).toBeVisible(); await expect(page.getByLabel('文章标题', { exact: true })).toHaveValue('让知识保持可用'); }, tests: ['tests/e2e/blog-admin-content.spec.ts'] },
  { id: 'blog-article-cover-picker-frame', sourceIds: ['PB-034'], title: '博客原稿附件封面选择', state: 'Actual expanded cover section and loaded attachment picker; availability comes from the source folder', role: 'owner', path: '/?view=apps&app=blog&appSection=articles', target: '.blog-cover-picker',
    open: async ({ page }) => { await page.locator('.blog-post-option').filter({ hasText: '让知识保持可用' }).first().click(); const details = page.locator('.blog-secondary-fields');
      await expect(page.locator('.blog-article-detail')).toBeVisible(); await details.locator('summary').click(); await expect(details).toHaveJSProperty('open', true);
      await details.getByRole('button', { name: '从原稿附件中选择封面', exact: true }).click();
      await expect(details.getByRole('button', { name: '从原稿附件中选择封面', exact: true })).toBeEnabled();
      await expect(details.locator('.blog-cover-assets').getByRole('button', { name: /^选择封面 / }).first()
        .or(details.getByText('这篇笔记还没有图片附件，可在上方上传。', { exact: true }))).toBeVisible();
      await details.locator('.blog-cover-picker').scrollIntoViewIfNeeded(); }, verify: async ({ page }) => ({ loadedOptions: await page.locator('.blog-cover-assets button').count(),
      emptyStateVisible: await page.getByText('这篇笔记还没有图片附件，可在上方上传。', { exact: true }).isVisible() }), tests: ['tests/e2e/blog-admin-content.spec.ts'] },
  ...['journal', 'magazine', 'profile'].map((template, i): Scene => ({ id: 'public-' + template, sourceIds: [['PB-050'], ['PB-051'], ['PB-052']][i], title: '公开博客 ' + template, state: 'Published actual ' + template + ' template', role: 'public-reader', path: '/blog', target: 'body', before: async ({ fixture }) => { await fixture.setTemplate(template); }, representative: true, tests: ['tests/e2e/blog-public-redesign.spec.ts', 'tests/e2e/blog-studio.spec.ts'] })),
  ...[['articles', 'PB-053', '/blog/-/articles'], ['reader', 'PB-054', 'reader'], ['about', 'PB-056', '/blog/about'], ['collections', 'PB-057', '/blog/-/collections'], ['collection', 'PB-058', 'collection'], ['archive', 'PB-059', '/blog/archive']].map(([id, sourceId, path]): Scene => ({ id: 'public-' + id, sourceIds: [sourceId], title: '公开博客 ' + id, state: 'Actual public route with published fixture data', role: 'public-reader', path: fixture => path === 'reader' ? '/blog/' + fixture.publicSlug : path === 'collection' ? '/blog/-/collections/' + fixture.collectionSlug : path, target: 'body', representative: id === 'reader', tests: ['tests/e2e/blog-public-redesign.spec.ts'] })),
  { id: 'private-blog-preview', sourceIds: ['PB-046'], title: '私有博客草稿预览', state: 'Authenticated actual HTML preview', role: 'owner', path: '/api/blog/design/preview', target: 'body', tests: ['tests/e2e/blog-admin-preview.spec.ts'] },
  { id: 'graph', sourceIds: ['WS-085', 'WS-096'], title: '知识图谱', state: 'Actual graph result or truthful empty state', role: 'owner', path: '/?view=apps&app=graph', target: '.graph-workspace', representative: true, tests: ['tests/e2e/knowledge-graph-full.spec.ts'] },
  { id: 'graph-list', sourceIds: ['WS-086'], title: '图谱列表', state: 'Actual graph accessible list', role: 'owner', path: '/?view=apps&app=graph', target: '.graph-workspace', open: async ({ page }) => { await chooseGraphMode(page, '显示方式', '列表'); }, tests: ['tests/e2e/knowledge-graph-full.spec.ts'] },
  { id: 'graph-note-mode', sourceIds: ['WS-106'], title: '笔记图谱', state: 'Actual three uniquely titled fixture notes and stable Cytoscape layout', role: 'owner', path: '/?view=apps&app=graph', target: '.graph-workspace',
    before: graphNoteFixture, open: stableNoteGraph, verify: async ({ page }) => ({ actualStableCytoscapeLayout: graphFixtures.get(page)?.layout,
      fixtureTitles: graphFixtures.get(page)?.titles, stateGate: '3 exact fixture titles; 3 consecutive stable actual position samples; actual fit action' }), tests: ['tests/e2e/knowledge-graph.spec.ts'] },
  ...[['model', 'WS-089', '模型', '模型设置'], ['review', 'WS-090', '审核', '关系审核'], ['views', 'WS-091', '视图', '视图与导出'], ['ask', 'WS-092', '问答', '图谱问答']].map(([id, sourceId, label, title]): Scene => ({ id: 'graph-' + id, sourceIds: [sourceId], title, state: 'Actual graph panel ' + title, role: 'owner', path: '/?view=apps&app=graph', target: dialog(title), open: async ({ page }) => { await openGraphPanel(page, label as '模型' | '审核' | '视图' | '问答'); }, window: true, representative: true, tests: ['tests/e2e/knowledge-graph-full.spec.ts'] })),
  { id: 'graph-filter', sourceIds: ['WS-087'], title: '图谱筛选', state: 'Actual graph filter window', role: 'owner', path: '/?view=apps&app=graph', target: dialog('筛选与路径'), open: click('筛选'), window: true, tests: ['tests/e2e/knowledge-graph.spec.ts'] },
  { id: 'graph-tasks', sourceIds: ['WS-088'], title: '后台分析', state: 'Actual graph task list', role: 'owner', path: '/?view=apps&app=graph', target: dialog('后台分析'), open: async ({ page }) => { await page.getByRole('button', { name: /^后台分析：/ }).click(); }, window: true, tests: ['tests/e2e/knowledge-graph-full.spec.ts'] },
  { id: 'graph-dirty-model', sourceIds: ['WS-095'], title: '图谱放弃修改', state: 'Actual dirty-model close confirmation', role: 'owner', path: '/?view=apps&app=graph', target: dialog('模型设置'), open: async ({ page }) => { await openGraphPanel(page, '模型'); const panel = page.getByRole('dialog', { name: '模型设置', exact: true }); await panel.getByRole('switch', { name: '自动分析内容变化' }).click(); await panel.getByRole('button', { name: '关闭模型设置', exact: true }).click(); await expect(panel).toContainText('有未保存的更改'); }, window: true, tests: ['tests/e2e/knowledge-graph-full.spec.ts'] },
];

// Primary diagrams are created through the same UI as existing browser tests.
// Each independent scene owns a new real native resource; no vendor panel is synthesized.
async function primary(env: SceneEnv, name = '新建白板') {
  const kind = name === '新建脑图' ? '脑图' : name === '新建流程图' ? '流程图' : '白板';
  // MindElixir fits the initial map when it mounts. Create at the requested
  // viewport so the primary screenshot is an initial view, not a desktop pan.
  if (kind !== '脑图') await env.page.setViewportSize({ width: 1440, height: 1000 });
  const created = await openPrimaryDiagram(env, kind);
  if (kind === '脑图') await expect(created.workspace.locator('me-root me-tpc')).toBeVisible({ timeout: 45000 });
  if (kind === '流程图') await expect(created.workspace.locator('.diagram-flow-source .cm-content')).toBeVisible({ timeout: 45000 });
  await expect(created.workspace.getByRole('status')).toContainText('已保存', { timeout: 45000 });
  await closeSidebar(env.page);
  await env.page.setViewportSize({ width: env.variant.width, height: env.variant.height });
  return created;
}
async function drawSavedRectangle(env: SceneEnv) {
  const created = await primary(env);
  await env.page.setViewportSize({ width: 1440, height: 1000 });
  const canvas = created.workspace.locator('canvas.interactive'); await expect(canvas).toBeVisible();
  const box = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: 200, y: 180 } }); await env.page.keyboard.press('r');
  await env.page.mouse.move(box.x + box.width * .55, box.y + box.height * .4); await env.page.mouse.down();
  await env.page.mouse.move(box.x + box.width * .55 + 110, box.y + box.height * .4 + 85, { steps: 8 }); await env.page.mouse.up();
  await expect(created.workspace.getByRole('status')).toContainText('未保存');
  await created.workspace.getByRole('button', { name: '保存图形', exact: true }).click();
  await expect(created.workspace.getByRole('status')).toContainText('已保存', { timeout: 45000 });
  const resource = await env.fixture.api('/api/notes/' + created.id + '/diagram');
  if (resource.preview?.state !== 'ready' || !resource.source?.content) throw Error('Saved rectangle did not produce an actual ready preview/source');
  const scene = JSON.parse(resource.source.content);
  if (!scene.elements?.some((element: any) => element.type === 'rectangle' && !element.isDeleted)) throw Error('Actual native saved source has no rectangle');
  await env.page.setViewportSize({ width: env.variant.width, height: env.variant.height });
  return created;
}
for (const [id, sourceId, name] of [['whiteboard', 'WS-068', '新建白板'], ['mindmap', 'WS-069', '新建脑图'], ['flowchart', 'WS-070', '新建流程图']]) {
  scenes.push({ id, sourceIds: [sourceId], title: name, state: 'Actual newly created primary diagram', role: 'owner', path: '/', target: '[data-testid="diagram-document-workspace"]', open: async env => { await primary(env, name); }, representative: true, tests: ['tests/e2e/diagram-document-chrome.spec.ts'] });
}
for (const [id, sourceId, name] of [['diagram-source', 'WS-072', 'Markdown 源码'], ['diagram-png', 'WS-073', 'PNG 预览'], ['diagram-read', 'WS-074', '阅读'], ['diagram-more', 'WS-075', '更多操作']]) {
  scenes.push({ id, sourceIds: [sourceId], title: name, state: id === 'diagram-png' ? 'Actual saved nonempty rectangle PNG preview; native source checked' : 'Actual primary diagram ' + name,
    role: 'owner', path: '/', target: '[data-testid="diagram-document-workspace"]', open: async env => {
      const { workspace } = id === 'diagram-png' ? await drawSavedRectangle(env) : await primary(env);
      await workspace.getByRole('button', { name, exact: true }).click();
      if (id === 'diagram-source') { await expect(workspace.getByRole('button', { name: 'Markdown 源码', exact: true })).toHaveAttribute('aria-pressed', 'true'); await expect(workspace.locator('.cm-content')).toContainText('dooknow:primary:start'); await expect(workspace.locator('.cm-content')).toHaveAttribute('contenteditable', 'true'); }
      if (id === 'diagram-read') { await expect(workspace.getByRole('button', { name: '阅读', exact: true })).toHaveAttribute('aria-pressed', 'true'); await expect(workspace.locator('.diagram-reading')).toBeVisible(); await expect(workspace.locator('canvas.interactive')).toHaveCount(0); }
      if (id === 'diagram-png' || id === 'diagram-read') {
        const image = workspace.locator(id === 'diagram-png' ? '.diagram-pg img' : '.diagram-reading img');
        await expect(image).toBeVisible(); await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
      }
      if (id === 'diagram-png') await expect(workspace.getByRole('button', { name: 'PNG 预览', exact: true })).toHaveAttribute('aria-pressed', 'true');
      if (id === 'diagram-more') await expect(env.page.getByRole('dialog', { name: '图形文档操作', exact: true })).toBeVisible();
    }, tests: ['tests/e2e/diagram-document-chrome.spec.ts', 'tests/e2e/diagram-editor-offline-export.spec.ts'] });
}
for (const [id, runtimeId, kind] of [['vendor-find', 'RTD-005', 'find'], ['vendor-library', 'RTD-010', 'library'], ['vendor-menu', 'RTD-003', 'menu']]) {
  scenes.push({ id, sourceIds: [runtimeId, 'WS-068'], title: 'Native whiteboard ' + kind, state: 'Actual Excalidraw ' + kind, role: 'owner', path: '/',
    target: kind === 'find' ? '.excalidraw .sidebar' : kind === 'library' ? '.excalidraw .sidebar:visible' : '.excalidraw .dropdown-menu',
    open: async env => { await primary(env); const native = env.page.getByTestId('diagram-document-workspace').locator('.excalidraw'); await expect(native.locator('canvas.interactive')).toBeVisible({ timeout: 30000 });
      if (kind === 'library') {
        const checkbox = native.getByRole('checkbox', { name: '素材库', exact: true });
        const trigger = native.locator('label.sidebar-trigger__label-element').filter({ has: env.page.getByRole('checkbox', { name: '素材库', exact: true }) });
        await expect(trigger).toBeVisible(); await trigger.click(); await expect(checkbox).toBeChecked();
        await expect(native.getByRole('link', { name: '浏览素材库', exact: true })).toBeVisible();
        await expect(native.locator('.sidebar:visible')).toContainText('尚未添加任何项目');
      }
      else { await native.getByTestId('main-menu-trigger').click(); if (kind === 'find') { const find = native.getByTestId('search-menu-button'); await find.scrollIntoViewIfNeeded(); await find.click(); await expect(native.getByRole('textbox', { name: 'Find text on canvas...', exact: true })).toBeVisible(); } }
    }, window: true, representative: true, tests: ['tests/e2e/platform-shared-ui.spec.ts'] });
}

scenes.push({ id: 'large-file', sourceIds: ['WS-049'], title: '大文件片段编辑', state: 'Actual >2MiB original loaded as fragment', role: 'owner', path: '/', target: '.large-workspace',
  open: async ({ page, fixture }) => { const name = 'runtime-large-' + randomUUID() + '.md'; await writeFile(resolve(fixture.knowledgeRoot, '00-Inbox', name), '# 隔离大文件\nFIRST\n' + 'unchanged line\n'.repeat(160000) + 'UNLOADED_SENTINEL'); await page.goto('/?folder=00-Inbox'); await page.locator('.folder-view').getByRole('button', { name, exact: true }).click();
    await expect(page.locator('.large-editor .cm-content')).toContainText('FIRST', { timeout: 60000 });
    await expect(page.locator('.large-editor .cm-content')).not.toContainText('UNLOADED_SENTINEL');
    await expect(page.locator('.large-range')).toContainText(/第 1–\d+ 行/); await expect(page.locator('.large-range')).toContainText('已保存');
    await expect(page.getByRole('button', { name: '保存片段', exact: true })).toBeEnabled();
  }, representative: true, tests: ['tests/e2e/large-files.spec.ts'] });

scenes.push({ ...note('export-reading-html', ['WS-124'], 'Actual downloaded standalone reading HTML; owner shell is trigger evidence only', 'body', async ({ page }) => { await showRead(page); await expect(page.locator('.preview-panel')).toContainText('仅用于最终界面取证'); }), representative: true, evidenceKind: 'downloaded-html',
  afterCapture: async ({ page }) => { const downloaded = page.waitForEvent('download'); await button(page, '导出 HTML').click(); const artifact = await downloaded; return { downloadName: artifact.suggestedFilename(), temporaryDownloadPath: await artifact.path(), needsArtifactCapture: true }; }, tests: ['tests/e2e/document-complete-download.spec.ts'] });

export { closeSidebar };
