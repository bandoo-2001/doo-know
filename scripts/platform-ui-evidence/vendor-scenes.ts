/** Packaged Excalidraw surfaces opened through the integrated real whiteboard. */
import { expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { closeSidebar, showSidebar } from '../../tests/support/settings-navigation';
import type { Fixture, Scene, SceneEnv } from './model';

const boardIds = new WeakMap<Fixture, string>();
const workspace = (env: SceneEnv) => env.page.getByTestId('diagram-document-workspace');
const native = (env: SceneEnv) => workspace(env).locator('.excalidraw');
const button = (env: SceneEnv, name: string) => native(env).getByRole('button', { name, exact: true });
const boardPath = (fixture: Fixture) => boardIds.has(fixture) ? '/?note=' + boardIds.get(fixture) : '/';

async function createWindow(env: SceneEnv) {
  await expect(env.page.locator('.workspace')).toBeVisible({ timeout: 20000 });
  await showSidebar(env.page);
  await env.page.getByRole('button', { name: '创建与导入', exact: true }).click();
  await env.page.getByRole('dialog', { name: '创建与导入', exact: true }).getByRole('button', { name: '新建白板', exact: true }).click();
  return env.page.getByRole('dialog', { name: '新建白板', exact: true });
}
async function board(env: SceneEnv) {
  if (!boardIds.has(env.fixture)) {
    const desired = { width: env.variant.width, height: env.variant.height };
    await env.page.setViewportSize({ width: 1440, height: 1000 });
    await expect(env.page.getByRole('heading', { name: '选择一篇笔记', exact: true })).toBeVisible({ timeout: 20000 });
    const form = await createWindow(env);
    await form.getByLabel('文件名', { exact: true }).fill('vendor-evidence-' + randomUUID());
    await form.getByRole('button', { name: '创建', exact: true }).click();
    await expect(workspace(env)).toBeVisible({ timeout: 30000 });
    const id = new URL(env.page.url()).searchParams.get('note');
    if (!id) throw Error('Real whiteboard creation did not produce a resource ID');
    boardIds.set(env.fixture, id);
    await env.page.setViewportSize(desired);
  }
  await expect(native(env).locator('canvas.interactive')).toBeVisible({ timeout: 30000 });
  await expect(workspace(env).getByRole('status').first()).toContainText('已保存', { timeout: 30000 });
  await closeSidebar(env.page);
}
async function mainMenu(env: SceneEnv) {
  await native(env).getByTestId('main-menu-trigger').click();
  await expect(native(env).getByTestId('search-menu-button')).toBeVisible();
}
async function library(env: SceneEnv) {
  const checkbox = native(env).getByRole('checkbox', { name: '素材库', exact: true });
  // `has` is relative to each candidate label; do not repeat the native root.
  const label = native(env).locator('label.sidebar-trigger__label-element').filter({
    has: env.page.getByRole('checkbox', { name: '素材库', exact: true }),
  });
  await expect(label).toBeVisible();
  await label.click();
  await expect(checkbox).toBeChecked();
  await expect(native(env).getByRole('link', { name: '浏览素材库', exact: true })).toBeVisible();
  await expect(native(env).locator('.sidebar:visible')).toContainText('尚未添加任何项目');
}
function shapePanel(page: Page) {
  const region = page.locator('.excalidraw').getByRole('region', { name: '选定形状操作', exact: true });
  // Desktop positions the visible 175px-wide Island inside a zero-height
  // semantic section. The mobile sheet has a visible section of its own.
  return region.and(page.locator(':visible')).or(region.locator('.Island:visible')).first();
}
async function shape(env: SceneEnv, label: '矩形' | '箭头' | '文字') {
  const radio = native(env).getByRole('radio', { name: label, exact: true });
  await native(env).locator('label').filter({ has: env.page.getByRole('radio', { name: label, exact: true }) }).click();
  await expect(radio).toBeChecked();
  const panel = shapePanel(env.page);
  const edit = button(env, '编辑');
  // Tool selection and property rendering commit separately in React.
  await expect.poll(async () => await panel.isVisible() || await edit.isVisible(), { timeout: 10000 }).toBe(true);
  if (!await panel.isVisible()) {
    await expect(edit).toBeVisible();
    await edit.click();
  }
  await expect(panel).toBeVisible();
  return panel;
}
async function contextMenu(env: SceneEnv) {
  const canvas = native(env).locator('canvas.interactive');
  const rect = await canvas.boundingBox();
  if (!rect) throw Error('Native interactive canvas has no actual bounds');
  const viewport = env.page.viewportSize()!;
  const x = Math.max(rect.x + 12, Math.min(rect.x + rect.width / 2, viewport.width - 24));
  const y = Math.max(rect.y + 12, Math.min(rect.y + rect.height / 2, viewport.height - 90));
  await env.page.mouse.click(x, y, { button: 'right' });
  await expect(native(env).locator('.context-menu')).toBeVisible();
}
// Vendor Modal creates an independent .excalidraw-modal-container under body.
// Probe its actual card, rather than the full-viewport backdrop or owner shell.
const vendorModal = (page: Page) => page.locator('.excalidraw-modal-container .Modal[role="dialog"]:visible');
const modalWithHeading = (page: Page, title: string) => vendorModal(page).filter({ has: page.getByRole('heading', { name: title, exact: true }) });
const mermaidInput = (page: Page) => page.getByPlaceholder('Write Mermaid diagram defintion here...', { exact: true });
const mermaidModal = (page: Page) => vendorModal(page).filter({ has: mermaidInput(page) });
const popupWithTextbox = (page: Page, label: string) => page.locator('.excalidraw [role="dialog"]:visible').filter({
  has: page.getByRole('textbox', { name: label, exact: true }),
}).last();
async function emptySavedScene(env: SceneEnv) {
  const id = new URL(env.page.url()).searchParams.get('note');
  if (!id) throw Error('Expected the actual saved primary whiteboard route');
  const resource = await env.fixture.api('/api/notes/' + id + '/diagram');
  if (resource.documentType !== 'whiteboard' || resource.source?.format !== 'excalidraw' || typeof resource.source.content !== 'string')
    throw Error('Expected actual owner-readable primary Excalidraw source');
  const parsed = JSON.parse(resource.source.content);
  const elements = parsed.elements?.filter((element: { isDeleted?: boolean }) => !element.isDeleted);
  if (!Array.isArray(elements) || elements.length !== 0) throw Error('Vendor recipe expected an empty saved scene; do not label nonempty data as empty');
  return { savedScene: 'actual-empty-primary-whiteboard', savedElementCount: elements.length,
    sourceHash: resource.source.hash, previewState: resource.preview?.state, sourcePermission: 'authenticated owner' };
}
const scene = (id: string, sourceId: string, title: string, target: Scene['target'], open?: Scene['open'], options: Partial<Scene> = {}): Scene => ({
  id: 'vendor-extra-' + id, sourceIds: [sourceId, 'WS-068'], title, state: title, role: 'owner',
  path: boardPath, readiness: 'target', target, window: true, representative: true,
  open: async env => { await board(env); await open?.(env); },
  tests: ['tests/e2e/platform-shared-ui.spec.ts', 'tests/e2e/diagram-document-chrome.spec.ts'], ...options,
  verify: async env => ({ ...await emptySavedScene(env), ...(options.verify ? { interaction: await options.verify(env) } : {}) }),
});

export const vendorScenes: Scene[] = [
  { id: 'vendor-extra-new-whiteboard', sourceIds: ['RTD-001', 'WS-013'], title: 'Actual new-whiteboard form',
    state: 'Real integrated creation window; no native resource invented', role: 'owner', path: '/',
    target: page => page.getByRole('dialog', { name: '新建白板', exact: true }), window: true,
    open: async env => { const form = await createWindow(env); await expect(form.getByLabel('文件名', { exact: true })).toBeVisible();
      await expect(form.getByRole('combobox', { name: '所在目录', exact: true })).toBeVisible(); },
    tests: ['tests/e2e/diagram-document-chrome.spec.ts'] },
  scene('canvas', 'RTD-002', 'Actual integrated whiteboard canvas and native toolbar', '[data-testid="diagram-document-workspace"]', undefined, { window: false }),
  scene('main-menu', 'RTD-003', 'Actual vendor main menu; application-disabled file entries remain absent', '.excalidraw .dropdown-menu:visible', mainMenu,
    { verify: async env => {
      const labels = await native(env).locator('.dropdown-menu button').allTextContents();
      return { actualLabels: labels.map(label => label.trim()), disabledByHost: ['loadScene', 'saveToActiveFile', 'export', 'saveAsImage'],
        externalLinks: 'enumerated-only-not-opened', nativeFilePickers: 'not-invoked' };
    } }),
  scene('canvas-color', 'RTD-004', 'Actual canvas-background color popup without changing the background', page => page.getByRole('dialog').filter({
    has: page.getByRole('textbox', { name: '画布背景', exact: true }),
  }), async env => { await mainMenu(env); await button(env, '画布背景').click(); await expect(native(env).getByRole('textbox', { name: '画布背景', exact: true })).toBeVisible(); }),
  scene('find', 'RTD-005', 'Actual Find sidebar with usable input and close action', '.excalidraw .sidebar:visible', async env => {
    await mainMenu(env); const find = native(env).getByTestId('search-menu-button'); await find.scrollIntoViewIfNeeded(); await find.click();
    const input = native(env).getByRole('textbox', { name: 'Find text on canvas...', exact: true });
    await expect(input).toBeVisible(); await input.fill('isolated native search'); await expect(input).toBeFocused();
  }, { afterCapture: async env => { await button(env, '关闭').click(); await expect(native(env).getByRole('textbox', { name: 'Find text on canvas...', exact: true })).toBeHidden(); return { actualCloseClick: 'closed-find-sidebar' }; } }),
  scene('help', 'RTD-006', 'Actual vendor help dialog and scrollable shortcut list', page => modalWithHeading(page, '帮助').locator('.Modal__content'),
    async env => { await mainMenu(env); await native(env).locator('.dropdown-menu').getByRole('button', { name: '帮助', exact: true }).click();
      await expect(modalWithHeading(env.page, '帮助')).toBeVisible(); await expect(modalWithHeading(env.page, '帮助')).toContainText('快捷键列表'); },
    { afterCapture: async env => { await env.page.keyboard.press('Escape'); await expect(modalWithHeading(env.page, '帮助')).toBeHidden(); return { action: 'actual-help-dismissed-with-Escape', externalLinks: 'not-opened' }; } }),
  scene('clear-confirm', 'RTD-007', 'Actual clear-canvas confirmation opened and cancelled', page => modalWithHeading(page, '清除画布').locator('.Modal__content'),
    async env => { await mainMenu(env); await button(env, '重置画布').click(); const modal = modalWithHeading(env.page, '清除画布');
      await expect(modal).toContainText(/这将会清除整个画布.*是否要继续/); await expect(modal.getByRole('button', { name: '确定', exact: true })).toBeVisible(); },
    { afterCapture: async env => { const modal = modalWithHeading(env.page, '清除画布'); await modal.getByRole('button', { name: '取消', exact: true }).click(); await expect(modal).toBeHidden(); return { action: 'cancelled-clear-without-mutation' }; } }),
  scene('extra-tools', 'RTD-008', 'Actual vendor extra-tools dropdown', '.excalidraw .App-toolbar__extra-tools-dropdown:visible', async env => {
    await button(env, '更多工具').click(); await expect(button(env, 'Mermaid 至 Excalidraw')).toBeVisible();
  }),
  scene('mermaid-dialog', 'RTD-009', 'Actual Mermaid-to-Excalidraw insertion dialog', page => mermaidModal(page).locator('.Modal__content'),
    async env => { await button(env, '更多工具').click(); await button(env, 'Mermaid 至 Excalidraw').click();
      await expect(mermaidInput(env.page)).toBeVisible(); await expect(mermaidInput(env.page)).toHaveValue(/flowchart/);
      await expect(mermaidModal(env.page).getByRole('button', { name: /^插入/ })).toBeVisible();
  }, { afterCapture: async env => { await env.page.keyboard.press('Escape'); await expect(mermaidModal(env.page)).toBeHidden(); return { insertion: 'not-executed-vendor-example-only' }; } }),
  scene('library', 'RTD-010', 'Actual empty-library sidebar; no external library opened', '.excalidraw .sidebar:visible', library,
    { afterCapture: async env => { await button(env, '关闭').click(); await expect(native(env).getByRole('link', { name: '浏览素材库', exact: true })).toBeHidden(); return { actualCloseClick: 'closed-library-sidebar' }; } }),
  scene('library-menu', 'RTD-011', 'Actual empty-library menu; native Open picker is not invoked', '.excalidraw .library-menu:visible', async env => {
    await library(env); const trigger = native(env).locator('.library-menu-dropdown-container:visible .dropdown-menu-button').last();
    await trigger.scrollIntoViewIfNeeded(); await trigger.click();
    await expect(native(env).getByTestId('lib-dropdown--load')).toBeVisible();
  }),
  scene('canvas-context-menu', 'RTD-012', 'Actual mouse context menu on an empty native canvas', '.excalidraw .context-menu:visible', contextMenu,
    { verify: async env => ({ trigger: 'actual-mouse-right-click-at-each-viewport-not-physical-touch-longpress', labels: await native(env).locator('.context-menu button').allTextContents() }) }),
  scene('stats', 'RTD-013', 'Actual desktop canvas/shape statistics; mobile renderer exception retained', '.excalidraw .exc-stats:visible', async env => {
    await contextMenu(env); const action = native(env).locator('.context-menu').getByTestId('stats').getByRole('button');
    await expect(action).toContainText('Canvas & Shape properties'); await action.click();
    const stats = native(env).locator('.exc-stats');
    if (await native(env).locator('.App-bottom-bar').isVisible() && !await stats.isVisible())
      throw Error('UNAVAILABLE: integrated vendor uses MobileMenu, whose locked source has no Stats renderer; actual context action did not mount stats.');
    await expect(stats.getByRole('heading', { name: '详细统计信息', exact: true })).toBeVisible();
  }),
  scene('rectangle-properties', 'RTD-014', 'Actual selected rectangle-tool properties including mobile Edit sheet', shapePanel,
    async env => { await shape(env, '矩形'); await expect(native(env).getByRole('group', { name: '描边宽度', exact: true })).toBeVisible(); }),
  scene('stroke-color', 'RTD-015', 'Actual stroke color picker without choosing a replacement color', page => popupWithTextbox(page, '描边'),
    async env => { await shape(env, '矩形'); await button(env, '描边').click(); await expect(env.page.getByRole('textbox', { name: '描边', exact: true })).toBeVisible(); }),
  scene('fill-color', 'RTD-016', 'Actual fill color picker without choosing a replacement color', page => popupWithTextbox(page, '背景'),
    async env => { await shape(env, '矩形'); await button(env, '背景').click(); await expect(env.page.getByRole('textbox', { name: '背景', exact: true })).toBeVisible(); }),
  scene('arrow-properties', 'RTD-017', 'Actual selected arrow-tool properties', shapePanel,
    async env => { await shape(env, '箭头'); await expect(native(env).getByRole('group', { name: 'Arrow type', exact: true })).toBeVisible(); }),
  ...[['arrowhead-end', 'RTD-018', 'arrowhead_end'], ['arrowhead-start', 'RTD-019', 'arrowhead_start']].map(([id, sourceId, label]): Scene => scene(id, sourceId,
    'Actual arrow endpoint picker ' + label, page => page.getByRole('dialog', { name: label, exact: true }), async env => {
      await shape(env, '箭头'); await button(env, label).click(); const picker = env.page.getByRole('dialog', { name: label, exact: true }); await expect(picker).toBeVisible();
      await expect(picker.getByRole('button', { name: '无', exact: true })).toBeVisible();
      if (label === 'arrowhead_end' && !await native(env).locator('.App-bottom-bar').isVisible()) {
        const extra = picker.getByRole('button', { name: "Crow's foot (many)", exact: true });
        if (!await extra.isVisible()) await picker.getByText('More options', { exact: true }).click();
        await expect(extra).toBeVisible();
      }
    })),
  scene('text-properties', 'RTD-020', 'Actual selected text-tool font/size/alignment properties', shapePanel,
    async env => { await shape(env, '文字'); await expect(native(env).getByRole('group', { name: '字体', exact: true })).toBeVisible(); }),
  scene('font-picker', 'RTD-021', 'Actual vendor font picker with search; no font selected or added', page => popupWithTextbox(page, 'Quick search'), async env => {
    await shape(env, '文字'); await button(env, 'Show font picker').click(); const picker = popupWithTextbox(env.page, 'Quick search');
    await expect(picker.getByRole('textbox', { name: 'Quick search', exact: true })).toBeVisible(); await expect(picker.getByRole('menu')).toBeVisible();
  }),
  scene('diagram-more', 'RTD-022', 'Actual integrated primary-diagram actions', page => page.getByRole('dialog', { name: '图形文档操作', exact: true }), async env => {
    await workspace(env).getByRole('button', { name: '更多操作', exact: true }).click();
    await expect(env.page.getByRole('dialog', { name: '图形文档操作', exact: true })).toBeVisible();
  }),
  scene('diagram-source', 'RTD-023', 'Actual native primary document Markdown representation', '[data-testid="diagram-document-workspace"]', async env => {
    const source = workspace(env).getByRole('button', { name: 'Markdown 源码', exact: true }); await source.click(); await expect(source).toHaveAttribute('aria-pressed', 'true');
    await expect(workspace(env).locator('.cm-content')).toContainText('dooknow:primary:start'); await expect(workspace(env).locator('.cm-content')).toHaveAttribute('contenteditable', 'true');
  }, { window: false, sourceIds: ['RTD-023', 'WS-072'] }),
  scene('diagram-png', 'RTD-024', 'Actual saved empty-whiteboard PNG projection; nonempty content is covered separately', '[data-testid="diagram-document-workspace"]', async env => {
    await workspace(env).getByRole('button', { name: 'PNG 预览', exact: true }).click();
    const image = workspace(env).locator('img'); await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
  }, { window: false, sourceIds: ['RTD-024', 'WS-073'] }),
  scene('diagram-read', 'RTD-025', 'Actual primary-diagram saved reading projection', '[data-testid="diagram-document-workspace"]', async env => {
    const read = workspace(env).getByRole('button', { name: '阅读', exact: true }); await read.click(); await expect(read).toHaveAttribute('aria-pressed', 'true');
    await expect(workspace(env).locator('.diagram-reading')).toBeVisible();
    const image = workspace(env).locator('.diagram-reading img'); await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
  }, { window: false, sourceIds: ['RTD-025', 'WS-074'] }),
];
