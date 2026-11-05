/** Supplemental real workspace recipes. Imported by the root-owned runner only.
 * No recipe starts a browser/server. Every seeded note/asset is fixture-owned.
 * Important-state strings deliberately cover only branches asserted below. */
import { expect, type Page, type Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { writeFile, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { showSidebar, closeSidebar, configurePlugin } from '../../tests/support/settings-navigation';
import { showSource, showRead } from '../../tests/support/editor-navigation';
import { clickNoteAction, selectHistoryVersion } from '../../tests/support/note-actions';
import { chooseGraphMode } from '../../tests/support/graph-navigation';
import { notificationPlans, reminderEventId } from '../../packages/core/to-doo/notifications';
import type { Scene, SceneEnv } from './model';
import { registerSceneCleanup } from './lifecycle';

const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const modal = (name: string) => (page: Page) => page.getByRole('dialog', { name, exact: true });
// Naive preset=card displays its title in the real card header; that title is
// not a reliable accessible dialog name. Keep Ant/native named dialogs separate.
const card = (name: string) => (page: Page) => page.locator('.n-card:visible').filter({
  has: page.locator('.n-card-header__main').filter({ hasText: name }),
});
const local = new WeakMap<Page, Record<string, any>>();
const releases = new WeakMap<Page, (() => void)[]>();
function values(env: SceneEnv) { let value = local.get(env.page); if (!value) { value = {}; local.set(env.page, value); } return value; }
async function release(env: SceneEnv) { for (const done of releases.get(env.page) ?? []) done(); releases.delete(env.page); return { transportReleased: true }; }
async function hold(env: SceneEnv, pattern: string, accept: (route: Route) => boolean = () => true) {
  let finish!: () => void;
  const gate = new Promise<void>(done => { finish = done; });
  registerSceneCleanup(env.page, finish);
  releases.set(env.page, [...(releases.get(env.page) ?? []), finish]);
  await env.page.route(pattern, async route => { if (!accept(route)) return route.continue(); const response = await route.fetch(); await gate; await route.fulfill({ response }); });
}
function recipe(id: string, ids: string[], state: string, target: Scene['target'], open: NonNullable<Scene['open']>, extra: Partial<Scene> = {}): Scene {
  return { id: 'ws-extra-' + id, sourceIds: ids, title: state, state, role: 'owner', path: '/', readiness: 'target', target, open,
    representative: ['context-menu', 'draft-recovery', 'save-conflict', 'latest-source', 'diagram-close', 'embedded-primary', 'graph-inspector-mobile', 'graph-inspector-desktop', 'trash-purge-confirm', 'trash-rename', 'global-reminder-host', 'opaque-copy', 'custom-text-color'].includes(id),
    afterCapture: release, tests: ['tests/e2e/platform-workspace-unification.spec.ts'], ...extra };
}
export async function createWorkspaceNote(env: SceneEnv, content = '# 隔离取证\n\n原文保持可恢复。\n', folderPath = '00-Inbox') {
  return env.fixture.api('/api/notes', 'POST', { folderPath, fileName: 'capture-' + randomUUID() + '.md', content, requestId: randomUUID() });
}
async function openNote(env: SceneEnv, content?: string) {
  const note = await createWorkspaceNote(env, content); values(env).note = note;
  await env.page.goto('/?note=' + note.id); await closeSidebar(env.page); await showSource(env.page);
  await expect(env.page.locator('.cm-content').first()).toBeVisible(); return note;
}
async function rich(env: SceneEnv, content?: string) {
  const note = await openNote(env, content); await button(env.page, '文档编辑').click();
  await expect(env.page.getByRole('textbox', { name: '文档正文', exact: true })).toBeVisible(); return note;
}
async function dirty(env: SceneEnv) { await env.page.locator('.cm-content').first().fill('# 尚未保存\n\n本地草稿取证。\n'); }
async function save(env: SceneEnv) { await env.page.locator('.note-header .toolbar').getByRole('button', { name: '保存', exact: true }).click(); }
async function isolatedFile(env: SceneEnv, bytes: string) {
  const root = await realpath(dirname(env.fixture.knowledgeRoot));
  if (dirname(root) !== await realpath(tmpdir()) || !basename(root).startsWith('dooknow-browser-')) throw Error('Fixture filesystem must be isolated /tmp/dooknow-browser-*');
  const fileName = 'capture-large-' + randomUUID() + '.md';
  await writeFile(join(env.fixture.knowledgeRoot, '00-Inbox', fileName), bytes); return fileName;
}
async function large(env: SceneEnv, metadata = false) {
  const name = await isolatedFile(env, '# Large capture\n' + 'whole source remains on server\n'.repeat(metadata ? 800000 : 110000));
  await env.page.goto('/?folder=00-Inbox');
  const identified = env.page.waitForResponse(response => /\/api\/notes\/[^/]+\/meta$/.test(new URL(response.url()).pathname)).then(async response => { expect(response.ok()).toBe(true); return response.json(); });
  // Standalone capture has no Playwright test.info()/case budget. The real
  // application follows its accepted read receipts; await its actual editor.
  await env.page.locator('.folder-entry-open').filter({ hasText: name }).click();
  const note = await identified; values(env).note = note;
  await expect(env.page.locator('.large-workspace')).toBeVisible();
  if (!metadata) await expect(env.page.locator('.large-editor .cm-content')).toBeVisible({ timeout: 60000 });
  else await expect(env.page.getByText('文件超过 20 MiB，当前仅显示元数据。', { exact: true })).toBeVisible();
  return note;
}
async function creation(env: SceneEnv, label: string) {
  await env.page.goto('/'); await showSidebar(env.page); await button(env.page, '创建与导入').click();
  await env.page.getByRole('dialog', { name: '创建与导入', exact: true }).getByRole('button', { name: label, exact: true }).click();
}
export async function openPrimaryDiagram(env: SceneEnv, kind: '白板' | '脑图' | '流程图' = '白板') {
  await creation(env, '新建' + kind);
  const dialog = env.page.getByRole('dialog', { name: '新建' + kind, exact: true });
  await dialog.getByLabel('文件名', { exact: true }).fill('capture-primary-' + randomUUID());
  await dialog.getByRole('button', { name: '创建', exact: true }).click();
  const workspace = env.page.getByTestId('diagram-document-workspace');
  await expect(workspace).toBeVisible({ timeout: 45000 }); await expect(workspace.getByRole('status')).toContainText('已保存', { timeout: 45000 });
  if (kind === '白板') await expect(workspace.locator('canvas.interactive')).toBeVisible({ timeout: 45000 });
  if (kind === '脑图') {
    const canvas = workspace.locator('.map-container');
    await expect.poll(() => canvas.evaluate(element => {
      const box = element.getBoundingClientRect();
      const nodes = [...element.querySelectorAll('me-tpc')];
      return nodes.length >= 2 && nodes.every(node => {
        const bounds = node.getBoundingClientRect();
        return bounds.width > 0 && bounds.height > 0 && bounds.left >= box.left - 1 &&
          bounds.right <= box.right + 1 && bounds.top >= box.top - 1 && bounds.bottom <= box.bottom + 1;
      });
    }), { timeout: 30000 }).toBe(true);
  }
  const id = new URL(env.page.url()).searchParams.get('note')!; values(env).boardId = id;
  return { workspace, id };
}
async function inline(env: SceneEnv, filled = false) {
  const { id, workspace } = await openPrimaryDiagram(env);
  if (filled) {
    const canvas = workspace.locator('canvas.interactive'); await canvas.scrollIntoViewIfNeeded();
    const box = (await canvas.boundingBox())!, viewport = env.page.viewportSize()!;
    const x = Math.max(box.x + 20, Math.min(box.x + box.width * .5, viewport.width - 96));
    const y = Math.max(box.y + 30, Math.min(box.y + box.height * .4, viewport.height - 120));
    await env.page.mouse.click(x, y); await env.page.keyboard.press('r');
    await env.page.mouse.move(x, y); await env.page.mouse.down();
    await env.page.mouse.move(x + 64, y + 48, { steps: 8 }); await env.page.mouse.up();
    await workspace.getByRole('button', { name: '保存图形', exact: true }).click();
    await expect.poll(async () => {
      const saved = await env.fixture.api('/api/notes/' + id + '/diagram');
      return saved.preview?.state === 'ready' && JSON.parse(saved.source.content ?? '{}').elements?.some((element: { type: string; isDeleted?: boolean }) => element.type === 'rectangle' && !element.isDeleted);
    }, { timeout: 30000 }).toBe(true);
    await expect(workspace.getByRole('status')).toContainText('已保存');
  }
  const resource = await env.fixture.api('/api/notes/' + id + '/diagram');
  const elements = JSON.parse(resource.source.content).elements.filter((element: { isDeleted?: boolean }) => !element.isDeleted);
  if (filled) expect(elements.some((element: { type: string }) => element.type === 'rectangle')).toBe(true);
  else expect(elements).toHaveLength(0);
  values(env).inlineResource = { id, sourceHash: resource.source.hash, previewHash: resource.preview?.hash, filled };
  const note = await openNote(env, '# 引用主白板\n\n```excalidraw\n' + id + '\n```\n\n保留父正文。\n');
  await showRead(env.page); const figure = env.page.locator('.diagram-card'); await expect(figure).toBeVisible();
  if (filled) await expect(figure.locator('.diagram-image svg, .diagram-image img').first()).toBeVisible({ timeout: 30000 });
  else await expect(figure.locator('.diagram-state')).toContainText('空白画布，随时开始设计');
  await expect(figure.getByRole('button', { name: '编辑设计', exact: true })).toBeEnabled();
  return note;
}
async function embedded(env: SceneEnv, fail = false, filled = false) {
  await inline(env, filled); await env.page.locator('.diagram-card').getByRole('button', { name: '编辑设计', exact: true }).click();
  const workspace = env.page.getByTestId('diagram-document-workspace'); await expect(workspace).toBeVisible();
  await expect(workspace.locator('canvas.interactive')).toBeVisible({ timeout: 30000 });
  await expect(workspace.getByRole('status')).toContainText('已保存');
  if (fail) {
    const source = workspace.getByRole('button', { name: 'Markdown 源码', exact: true });
    await source.click(); await expect(source).toHaveAttribute('aria-pressed', 'true');
    await expect(workspace.locator('.cm-content')).toContainText('dooknow:primary:start');
    await expect(workspace.locator('.cm-content')).toHaveAttribute('contenteditable', 'true');
    await env.page.route('**/api/diagram-documents/prepare', route => route.abort('failed'));
    await workspace.locator('.cm-content').click(); await env.page.keyboard.press('ControlOrMeta+End'); await env.page.keyboard.insertText('\n\n未保存的完整主图说明。\n');
    await workspace.getByRole('button', { name: '保存图形', exact: true }).click();
    await expect(workspace.getByRole('status')).toContainText('保存未完成');
  }
  return workspace;
}
async function history(env: SceneEnv) {
  let note = await createWorkspaceNote(env, '# 历史原文\n\n第一版取证正文。\n');
  note = await env.fixture.api('/api/notes/' + note.id, 'PUT', { content: '# 当前原文\n\n第二版取证正文。\n', expectedModifiedAt: note.modifiedAt, requestId: randomUUID() });
  values(env).note = note; await env.page.goto('/?note=' + note.id); await closeSidebar(env.page);
  await clickNoteAction(env.page, '历史版本'); await expect(env.page.locator('.note-history-dialog')).toBeVisible();
  await selectHistoryVersion(env.page, 0); return note;
}
async function trashNote(env: SceneEnv) {
  const note = await createWorkspaceNote(env); await env.fixture.api('/api/notes/' + note.id, 'DELETE', { noteId: note.id, expectedModifiedAt: note.modifiedAt, requestId: randomUUID() });
  values(env).note = note; await env.page.goto('/?view=trash');
  const item = env.page.locator('.trash-item').filter({ hasText: note.relativePath }); await expect(item).toBeVisible(); return item;
}
async function conflict(env: SceneEnv) {
  const note = await openNote(env); await dirty(env);
  await env.fixture.api('/api/notes/' + note.id, 'PUT', { content: '# 最新服务器版本\n\n冲突仍保留两份内容。\n', expectedModifiedAt: note.modifiedAt, requestId: randomUUID() });
  await save(env); await expect(card('原文件已更新')(env.page)).toBeVisible(); await expect(card('原文件已更新')(env.page).locator('.version-box time')).toHaveCount(2);
}
const png = { name: 'capture-image.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN9sAAAAASUVORK5CYII=', 'base64') };
async function image(env: SceneEnv) {
  await rich(env); const chooser = env.page.waitForEvent('filechooser');
  await env.page.getByRole('toolbar', { name: '正文格式', exact: true }).getByRole('button', { name: '上传附件', exact: true }).click();
  await (await chooser).setFiles(png); const image = env.page.locator('.tiptap img').last();
  await expect(image).toHaveAttribute('data-dooknow-image-src', /^\/api\/assets\//);
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
  await image.click(); return image;
}
async function recovered(env: SceneEnv) {
  await openNote(env); await dirty(env); await expect(env.page.locator('.local-draft-status')).toContainText('本地草稿已暂存', { timeout: 15000 });
  await env.page.reload(); await expect(env.page.locator('.draft-recovery')).toContainText('原文基准未变化'); await expect(env.page.locator('.cm-content').first()).toHaveAttribute('contenteditable', 'false');
}

export const workspaceScenes: Scene[] = [
  recipe('context-menu', ['WS-005'], 'Actual note row context actions', '.tree-context-menu', async env => {
    const note = await createWorkspaceNote(env); await env.page.goto('/?folder=00-Inbox');
    await env.page.locator('.folder-entry-open').filter({ hasText: note.relativePath.split('/').at(-1)!.replace(/\.md$/, '') }).click({ button: 'right' });
    await expect(env.page.getByRole('menuitem', { name: '创建副本', exact: true })).toBeVisible();
  }, { window: true, importantStates: { 'WS-005': ['Selected-row menu open'] }, tests: ['tests/e2e/tree-actions.spec.ts'] }),
  recipe('tree-unavailable', ['WS-010'], 'Tree transport failure with actual retry landing', '.workspace-empty', async env => {
    await env.page.route('**/api/tree', route => route.abort('failed')); await env.page.reload();
    await expect(env.page.getByRole('heading', { name: '暂时无法打开目录', exact: true })).toBeVisible();
  }, { fault: 'Abort real /api/tree transport; no fake DOM/tree response', importantStates: { 'WS-010': ['Tree unavailable landing'] }, tests: ['tests/e2e/http-workspace-startup.spec.ts'] }),
  recipe('unfinished-primary', ['WS-016'], 'Unfinished creation offered after PNG failure and reload', modal('新建白板'), async env => {
    await env.page.addInitScript(() => { HTMLCanvasElement.prototype.toBlob = function(callback) { callback(null); }; });
    await env.page.reload(); await creation(env, '新建白板');
    const dialog = env.page.getByRole('dialog', { name: '新建白板', exact: true }); await dialog.getByLabel('文件名', { exact: true }).fill('capture-pending-' + randomUUID());
    await dialog.getByRole('button', { name: '创建', exact: true }).click(); await expect(dialog.getByRole('alert')).toContainText('PNG');
    await env.page.reload(); await creation(env, '新建白板'); await expect(button(env.page, '恢复未完成图形')).toBeVisible();
  }, { window: true, fault: 'Existing diagram creation PNG-null fixture; render API only', importantStates: { 'WS-016': ['Pending path'] }, tests: ['tests/e2e/diagram-desktop-session.spec.ts'] }),
  recipe('move-reference-review', ['WS-018'], 'Actual cross-folder relative-reference review rejection', '.move-reference-help', async env => {
    const destination = 'capture-destination-' + randomUUID();
    await env.fixture.api('/api/folders', 'POST', { parent: '00-Inbox', name: destination });
    // The journal legitimately rewrites an ordinary relative link. A long,
    // reference-free document exercises the actual bounded cross-directory scan.
    await large(env);
    await clickNoteAction(env.page, '移动或重命名');
    const dialog = card('移动或重命名笔记')(env.page);
    await dialog.locator('.directory-select .ant-select-selector').click();
    await dialog.getByRole('combobox', { name: '目标目录', exact: true }).fill(destination);
    await env.page.locator('.directory-tree-popup:visible').getByTitle(destination, { exact: true }).click();
    await dialog.getByRole('button', { name: '确认移动', exact: true }).click();
    await expect(dialog.locator('.move-reference-help')).toContainText('本次没有移动笔记');
  }, { window: true, importantStates: { 'WS-018': ['Parameters retained; no move completed', 'Relative image/attachment/note-link instructions'] }, tests: ['tests/note-links.test.ts'] }),
  recipe('folder-trash-confirm', ['WS-021'], 'Actual folder removal confirmation without sending deletion', (page) => page.getByRole('dialog').filter({ hasText: '文件夹移入回收站' }), async env => {
    const name = 'capture-folder-' + randomUUID(); await env.fixture.api('/api/folders', 'POST', { parent: '00-Inbox', name });
    await env.page.goto('/?folder=00-Inbox'); await env.page.locator('.folder-entry-open').filter({ hasText: name }).click({ button: 'right' });
    await env.page.getByRole('menuitem', { name: '移入回收站', exact: true }).click();
    await expect(env.page.getByRole('dialog').filter({ hasText: '文件夹移入回收站' })).toContainText(name);
  }, { window: true, importantStates: { 'WS-021': ['Affected folder path'] }, tests: ['tests/e2e/folder-trash.spec.ts'] }),
  recipe('custom-text-color', ['WS-033'], 'Expanded invalid custom HEX retains current selection', '.palette-custom', async env => {
    await rich(env); await env.page.locator('.tiptap p').first().click(); await button(env.page, '文字颜色').click(); await button(env.page, '自定义颜色').click();
    await env.page.getByLabel('HEX 色值', { exact: true }).fill('invalid'); await expect(env.page.locator('.palette-color-error')).toBeVisible();
  }, { requires: 'document-editor', window: true, importantStates: { 'WS-033': ['Valid/invalid HEX', 'Custom expanded focus state'] }, tests: ['tests/e2e/text-style.spec.ts'] }),
  recipe('image-context', ['WS-035'], 'Actual uploaded image selected with settings', '.document-image-tools', async env => { await image(env); await expect(env.page.getByRole('group', { name: '图片设置', exact: true })).toBeVisible(); }, { requires: 'document-editor', importantStates: { 'WS-035': ['Selected image'] }, tests: ['tests/e2e/document-editor-controls.spec.ts'] }),
  recipe('link-context', ['WS-036'], 'Actual selected link and URL actions', '.document-link-tools', async env => { await rich(env, '# 链接取证\n\n[参考链接](https://example.invalid/reference)\n'); await env.page.locator('.tiptap a').click(); await expect(env.page.getByRole('group', { name: '链接操作', exact: true })).toContainText('example.invalid'); }, { requires: 'document-editor', importantStates: { 'WS-036': ['URL shown'] }, tests: ['tests/e2e/document-editor-controls.spec.ts'] }),
  recipe('image-preview', ['WS-038'], 'Real uploaded image preview with zoom slider', card('图片预览'), async env => { await image(env); await button(env.page, '预览图片').click(); await expect(env.page.getByLabel('图片缩放', { exact: true })).toBeVisible(); }, { window: true, requires: 'document-editor', importantStates: { 'WS-038': ['Scaled image canvas'] }, tests: ['tests/e2e/document-editor-controls.spec.ts'] }),
  ...(['copy', 'delete', 'card'] as const).map(kind => recipe('opaque-' + kind, kind === 'copy' ? ['WS-039'] : kind === 'delete' ? ['WS-040'] : ['WS-104'], 'Preserved original ' + kind, kind === 'copy' ? card('复制保留原文') : kind === 'delete' ? card('删除保留内容？') : '.opaque-source-card', async env => {
    await rich(env, '# 保留原文\n\n正文。\n\n:::custom\n必须逐字保留的未知块。\n:::\n'); await expect(env.page.locator('.opaque-source-card')).toBeVisible();
    if (kind !== 'card') {
      await env.page.locator('.opaque-source-card').getByRole('button', { name: kind === 'copy' ? '复制原文' : '删除此内容', exact: true }).click();
      if (kind === 'copy') expect(await card('复制保留原文')(env.page).getByRole('textbox', { name: '保留块原文', exact: true }).inputValue()).toContain('必须逐字保留的未知块。');
      else await expect(card('删除保留内容？')(env.page)).toContainText('将移除此块原文');
    }
  }, { requires: 'document-editor', window: kind !== 'card', importantStates: kind === 'copy' ? { 'WS-039': ['Unsupported content preserved verbatim'] } : kind === 'delete' ? { 'WS-040': ['Explicit original-content deletion warning'] } : { 'WS-104': ['Plain original-preserved card when no preview'] }, tests: ['tests/editor-opaque-source.test.ts'] })),
  recipe('unsupported-paste', ['WS-041'], 'Actual unsupported clipboard conversion decision', card('粘贴内容'), async env => {
    await rich(env); await env.page.locator('.tiptap').click();
    await env.page.evaluate(async () => navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob(['Merged clipboard text must survive.'], { type: 'text/plain' }), 'text/html': new Blob(['<table><tr><td colspan="2">Merged clipboard text must survive.</td></tr></table>'], { type: 'text/html' }) })]));
    await env.page.keyboard.press('ControlOrMeta+V'); await expect(card('粘贴内容')(env.page)).toContainText('合并或复杂单元格');
  }, { requires: 'document-editor', window: true, importantStates: { 'WS-041': ['Conversion reason displayed'] }, tests: ['tests/editor-clipboard.test.ts'] }),
  recipe('docked-outline', ['WS-048'], 'Actual document outline container or popup fallback', (page) => page.getByRole('navigation', { name: '本文章节', exact: true }).filter({ visible: true }), async env => {
    await openNote(env, '# 第一章\n\n## 第二节\n\n正文。\n');
    const outline = env.page.getByRole('navigation', { name: '本文章节', exact: true }); if (!await outline.isVisible()) await button(env.page, '章节目录').click(); await expect(outline).toContainText('第二节');
  }, { importantStates: { 'WS-048': ['Heading tree'] }, tests: ['tests/e2e/document-outline-folding.spec.ts'] }),
  recipe('metadata-only', ['WS-050'], 'Real >20MiB source metadata without fragment editor', '.large-workspace', async env => { await large(env, true); await expect(env.page.locator('.large-editor')).toHaveCount(0); }, { importantStates: { 'WS-050': ['File >20MiB: metadata displayed, fragment editor absent'] }, tests: ['tests/e2e/large-files.spec.ts'] }),
  recipe('fragment-preview', ['WS-051'], 'Loaded bounded fragment preview, never whole file', '.large-workspace', async env => { await large(env); await button(env.page, '预览当前片段').click(); await expect(env.page.locator('.large-preview')).toContainText('Large capture'); }, { importantStates: { 'WS-051': ['Safe rendered current fragment', 'Preview does not imply whole-file render'] }, tests: ['tests/e2e/large-files.spec.ts'] }),
  recipe('file-operation', ['WS-052'], 'Real asynchronous file operation receipt/progress', '.operation-status', async env => {
    await large(env); await env.page.locator('.large-editor .cm-content').fill('# Operation capture\n未保存片段。\n'); await button(env.page, '保存片段').click();
    await expect(env.page.locator('.operation-status')).toBeVisible({ timeout: 30000 });
  }, { tests: ['tests/e2e/large-files.spec.ts'], fault: 'No fabricated operation status: capture actual worker receipt only; state variants remain unclaimed' }),
  recipe('large-leave', ['WS-053'], 'Dirty large-fragment navigation with failed save retained', card('片段尚未保存'), async env => {
    const note = await large(env); await env.page.locator('.large-editor .cm-content').fill('# Unsaved fragment\n保留片段。\n');
    await button(env.page, '下一片段').click(); await env.page.route('**/api/notes/' + note.id + '/patch', route => route.abort('failed'));
    await card('片段尚未保存')(env.page).getByRole('button', { name: '保存', exact: true }).click(); await expect(card('片段尚未保存')(env.page)).toBeVisible();
  }, { window: true, fault: 'Abort only the real selected fragment patch transport', importantStates: { 'WS-053': ['Save error keeps fragment'] }, tests: ['tests/e2e/local-drafts.spec.ts'] }),
  recipe('draft-recovery', ['WS-054'], 'Actual browser-local full-note recovery offer', '.draft-recovery', recovered, { importantStates: { 'WS-054': ['Full note baseline unchanged/changed', 'Editor inert/read-only until decision'] }, tests: ['tests/e2e/local-drafts.spec.ts'] }),
  recipe('draft-copy-fallback', ['WS-055'], 'Recovery copy uses actual clipboard-unavailable fallback', '.draft-recovery', async env => {
    await recovered(env); await env.page.context().clearPermissions();
    await env.page.evaluate("Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new DOMException('Fixture clipboard unavailable', 'NotAllowedError')) } })");
    await button(env.page, '复制恢复文本').click(); await expect(env.page.locator('.draft-recovery-copy')).toContainText('请在下方文本框中选择并复制恢复文本'); await expect(env.page.getByRole('textbox', { name: '本地草稿恢复文本', exact: true })).toHaveValue('# 尚未保存\n\n本地草稿取证。\n');
  }, { fault: 'Clipboard capability rejection only, as existing fallback test; no DOM replacement', importantStates: { 'WS-055': ['Clipboard unavailable manual copy'] }, tests: ['tests/e2e/local-drafts.spec.ts'] }),
  recipe('save-conflict', ['WS-056'], 'Actual server CAS rejection preserves both versions', card('原文件已更新'), conflict, { window: true, importantStates: { 'WS-056': ['Opened/current version timestamps'] }, tests: ['tests/e2e/save-recovery.spec.ts'] }),
  recipe('latest-source', ['WS-057'], 'Latest saved source opened from real CAS conflict', card('最新已保存原文'), async env => { await conflict(env); await button(env.page, '查看最新版本').click(); await expect(card('最新已保存原文')(env.page)).toContainText('最新服务器版本'); }, { window: true, tests: ['tests/e2e/save-recovery.spec.ts'] }),
  recipe('unsaved-leave', ['WS-058'], 'Actual dirty-note navigation decision', card('当前笔记尚未保存'), async env => { await openNote(env); await dirty(env); await button(env.page, '返回笔记本').click(); await expect(card('当前笔记尚未保存')(env.page)).toBeVisible(); }, { window: true, tests: ['tests/e2e/workspace-lifecycle.spec.ts'] }),
  recipe('draft-timestamp', ['WS-059'], 'Unsaved source with durable browser-only draft timestamp', '.note-workspace', async env => { await openNote(env); await dirty(env); await expect(env.page.locator('.local-draft-status')).toContainText('原文仍需手动保存', { timeout: 15000 }); }, { importantStates: { 'WS-059': ['Browser-only draft timestamp'] }, tests: ['tests/e2e/local-drafts.spec.ts'] }),
  recipe('editor-bundle-failed', ['WS-060'], 'Real editor module transport rejected with content preserved', '.editor-warning', async env => {
    const note = await createWorkspaceNote(env); await env.page.route('**/*', route => route.request().resourceType() === 'script' && /(?:MarkdownEditor|DocumentEditor)/.test(route.request().url()) ? route.abort('failed') : route.continue());
    await env.page.goto('/?note=' + note.id); await expect(env.page.locator('.editor-warning')).toContainText('内容已保留');
  }, { fault: 'Actual lazy editor module transport abort; development module/chunk filenames must match frozen runtime', importantStates: { 'WS-060': ['Editor unavailable warning preserves content'] }, tests: ['tests/e2e/editor-mode-switch.spec.ts'] }),
  recipe('attachment-queue-failure', ['WS-061'], 'Real upload queue failure retains retry controls', '.batch-upload-panel', async env => {
    await openNote(env); await env.page.route('**/api/notes/*/assets*', route => route.request().method() === 'POST' ? route.abort('failed') : route.continue());
    const chooser = env.page.waitForEvent('filechooser');
    await env.page.getByRole('toolbar', { name: '正文格式', exact: true }).getByRole('button', { name: '上传附件', exact: true }).click();
    await (await chooser).setFiles([png, { ...png, name: 'capture-image-two.png' }]);
    await expect(env.page.locator('.batch-upload-panel')).toBeVisible(); await expect(env.page.locator('.batch-upload-panel')).toContainText(/失败|重试/);
  }, { fault: 'Abort only actual upload POSTs after input files chosen', importantStates: { 'WS-061': ['Retryable failure'] }, tests: ['tests/e2e/editor-async-ownership.spec.ts'] }),
  recipe('temporary-media', ['WS-062'], 'Actual browser-owned blob requires materialization before portable export', card('保存临时媒体后导出'), async env => {
    await openNote(env); const url = await env.page.evaluate(base64 => URL.createObjectURL(new Blob([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], { type: 'image/png' })), png.buffer.toString('base64'));
    await env.page.locator('.cm-content').first().fill('# 临时浏览器媒体\n\n![当前浏览器图片](' + url + ')\n'); await save(env); await expect(env.page.locator('.save-state').first()).toContainText('已保存');
    await clickNoteAction(env.page, '下载完整文档'); await expect(card('保存临时媒体后导出')(env.page)).toBeVisible();
  }, { window: true, fault: 'Browser-owned blob URL in real Markdown; no materialization clicked', tests: ['tests/e2e/diagram-portability.spec.ts'] }),
  recipe('diagram-save-needs', ['WS-063'], 'Actual new Mermaid block requests preview decision before save', modal('保存图形预览'), async env => {
    await openNote(env); await env.page.locator('.cm-content').first().fill('# 图形预览取证\n\n```mermaid\nflowchart TD\nA[开始] --> B[完成]\n```\n'); await save(env);
    await expect(env.page.getByRole('dialog', { name: '保存图形预览', exact: true })).toContainText('新增图形');
  }, { window: true, importantStates: { 'WS-063': ['Kind/reason/line need list'] }, tests: ['tests/diagram-save-dialog.test.ts'] }),
  recipe('history-original', ['WS-065'], 'Actual selected historical source tab', '.note-history-dialog', async env => { await history(env); await env.page.getByRole('tab', { name: '历史原文', exact: true }).click(); await expect(env.page.locator('.note-history-source')).toContainText('第一版取证正文'); }, { window: true, importantStates: { 'WS-065': ['Complete historical original'] }, tests: ['tests/e2e/note-history.spec.ts'] }),
  recipe('git-history-source', ['WS-066'], 'Git source with real plugin availability or missing-repository warning', '.note-history-dialog', async env => {
    await configurePlugin(env.page, 'Git 版本管理'); const enable = env.page.locator('.plugin-settings').getByRole('button', { name: '启用插件', exact: true }); if (await enable.isVisible()) await enable.click();
    await history(env); await env.page.getByRole('tab', { name: 'Git 提交', exact: true }).click(); await expect(env.page.getByText('正在加载 Git 提交…', { exact: true })).toBeHidden({ timeout: 30000 }); await expect(env.page.locator('.note-history-git-list, .note-history-dialog [role=alert], .note-history-empty:visible').last()).toBeVisible();
  }, { window: true, tests: ['tests/e2e/unified-note-history.spec.ts'] }),
  recipe('history-restore-confirm', ['WS-067'], 'Real historical restore replacement warning before mutation', '.note-history-dialog', async env => { await history(env); await button(env.page, '恢复此版本').click(); await expect(env.page.locator('.note-history-dialog')).toContainText('替换当前已保存内容'); }, { window: true, importantStates: { 'WS-067': ['Explicit replacement warning'] }, tests: ['tests/e2e/note-history.spec.ts'] }),
  recipe('embedded-primary', ['WS-071'], 'Verified empty primary whiteboard enters the real embedded editor and preserves parent note', '[data-testid=diagram-document-workspace].embedded', async env => { const workspace = await embedded(env); await expect(button(env.page, '返回笔记')).toBeVisible(); await expect(workspace.locator('.document-breadcrumb, .share-button, button[aria-label=历史版本]')).toHaveCount(0); }, { importantStates: { 'WS-071': ['Full-screen fixed overlay z1600', 'No standalone breadcrumb/history/share buttons'] }, tests: ['tests/e2e/platform-workspace-unification.spec.ts'] }),
  recipe('diagram-save-failure', ['WS-076'], 'Failed prepare retains full source and last complete preview', '[data-testid=diagram-document-workspace].embedded', async env => { const workspace = await embedded(env, true); await expect(workspace.locator('.cm-content')).toContainText('未保存的完整主图说明'); }, { fault: 'Abort actual diagram prepare only after real primary creation/reading', importantStates: { 'WS-076': ['Error retains source and last saved preview'] }, tests: ['tests/e2e/platform-workspace-unification.spec.ts'] }),
  recipe('diagram-close', ['WS-077'], 'Actual failed-save close decision, with three recovery actions', modal('保留图形草稿'), async env => { const workspace = await embedded(env, true); await workspace.getByRole('button', { name: '返回笔记', exact: true }).click(); await expect(env.page.getByRole('dialog', { name: '保留图形草稿', exact: true })).toBeVisible(); }, { window: true, fault: 'Same real failed prepare as regression; do not claim obsolete 100vmax-scrim branch', tests: ['tests/e2e/platform-workspace-unification.spec.ts'] }),
  ...(['card', 'expanded', 'source'] as const).map(kind => recipe('inline-' + kind, kind === 'card' ? ['WS-078'] : kind === 'expanded' ? ['WS-079'] : ['WS-080'], 'Verified empty referenced primary whiteboard ' + kind, '.diagram-card', async env => {
    await inline(env); if (kind === 'expanded') await env.page.locator('.diagram-card').getByRole('button', { name: '放大', exact: true }).click();
    if (kind === 'source') { await env.page.locator('.diagram-card').getByRole('button', { name: '源码', exact: true }).click(); await expect(env.page.locator('.diagram-source')).toContainText('excalidraw'); }
  }, { window: kind === 'expanded', importantStates: kind === 'card' ? { 'WS-078': ['Empty valid canvas'] } : kind === 'expanded' ? undefined : { 'WS-080': ['Referenced whiteboard resolved source'] }, tests: ['tests/e2e/diagram-portability.spec.ts'] })),
  ...(['card', 'expanded', 'source'] as const).map(kind => recipe('inline-filled-' + kind, [kind === 'card' ? 'WS-078' : kind === 'expanded' ? 'WS-079' : 'WS-080'], 'Actual saved rectangle rendered through referenced inline primary ' + kind, '.diagram-card', async env => {
    await inline(env, true); const figure = env.page.locator('.diagram-card');
    if (kind === 'expanded') { await figure.getByRole('button', { name: '放大', exact: true }).click(); await expect(figure).toHaveClass(/is-expanded/); await expect(figure.locator('.diagram-image svg, .diagram-image img').first()).toBeVisible(); }
    if (kind === 'source') { await figure.getByRole('button', { name: '源码', exact: true }).click(); await expect(figure.locator('.diagram-source')).toContainText('rectangle'); }
  }, { window: kind === 'expanded', importantStates: kind === 'expanded' ? { 'WS-079': ['Expanded preview/source'] } : kind === 'source' ? { 'WS-080': ['Referenced whiteboard resolved source'] } : undefined, tests: ['tests/e2e/diagram-document-chrome.spec.ts', 'tests/e2e/diagram-portability.spec.ts'] })),
  recipe('embedded-primary-filled', ['WS-071'], 'Actual saved rectangle reference opens the filled embedded primary editor', '[data-testid=diagram-document-workspace].embedded', async env => {
    const workspace = await embedded(env, false, true); await expect(workspace.locator('canvas.interactive')).toBeVisible(); await expect(workspace.getByRole('button', { name: '返回笔记', exact: true })).toBeVisible();
  }, { tests: ['tests/e2e/diagram-desktop-session.spec.ts'] }),
  ...(['menu', 'help'] as const).map(kind => recipe('mindmap-' + kind, [kind === 'menu' ? 'WS-081' : 'WS-082'], 'Actual MindElixir ' + kind, kind === 'menu' ? '.mindmap-node-menu:not([hidden])' : '.mindmap-shortcuts:not([hidden])', async env => {
    const { workspace } = await openPrimaryDiagram(env, '脑图'); await expect(workspace.locator('me-root me-tpc')).toBeVisible(); await workspace.locator('me-root me-tpc').click(); await button(env.page, kind === 'menu' ? '脑图节点操作' : '脑图快捷键').click();
  }, { window: true, tests: ['tests/e2e/mindmap-adapter.spec.ts'] })),
  ...(['mobile', 'desktop'] as const).map(kind => recipe('graph-inspector-' + kind, [kind === 'mobile' ? 'WS-093' : 'WS-094'], 'Authorized note node selected in actual graph inspector', '.graph-inspector:visible', async env => {
    const note = await createWorkspaceNote(env, '# Capture graph ' + randomUUID() + '\n\n来源笔记可以打开和局部探索。\n');
    await env.page.goto('/?view=apps&app=graph'); await closeSidebar(env.page); await chooseGraphMode(env.page, '图谱类型', '笔记'); await chooseGraphMode(env.page, '显示方式', '列表');
    await env.page.getByRole('searchbox', { name: '搜索图谱', exact: true }).fill(note.title);
    const row = env.page.locator('.graph-node-select').filter({ hasText: note.title }); await expect(row).toBeVisible({ timeout: 30000 }); await row.click();
    await expect(env.page.locator('.graph-inspector:visible')).toContainText(note.title); await expect(env.page.locator('.graph-inspector:visible').getByRole('button', { name: '打开原文', exact: true })).toBeVisible();
  }, { widths: kind === 'mobile' ? [320, 390, 360] : [1440], window: kind === 'mobile', importantStates: kind === 'desktop' ? { 'WS-094': ['Note open/focus controls'] } : undefined, tests: ['tests/e2e/knowledge-graph.spec.ts', 'tests/e2e/graph-hosted-navigation.spec.ts'] })),
  recipe('cloud-sync-host', ['WS-100'], 'Actual enabled Git plugin opens Workspace cloud-sync drawer', modal('云端同步'), async env => {
    await configurePlugin(env.page, 'Git 版本管理'); const enable = env.page.locator('.plugin-settings').getByRole('button', { name: '启用插件', exact: true }); if (await enable.isVisible()) await enable.click();
    await env.page.goto('/'); await showSidebar(env.page); await button(env.page, '云端同步').click(); await expect(env.page.getByRole('dialog', { name: '云端同步', exact: true })).toBeVisible();
  }, { window: true, importantStates: { 'WS-100': ['Only if gitAvailable'] }, tests: ['tests/e2e/z-git-remote.spec.ts'], fault: 'No external Git connection/init/network mutation; uses actual plugin enable/config UI only' }),
  recipe('note-task-capture', ['WS-101'], 'Unsaved note source snapshot in actual linked-task form', card('从资料创建任务'), async env => {
    await openNote(env); await dirty(env); await button(env.page, '更多操作').click(); await env.page.locator('.note-action-menu').getByRole('button', { name: '创建关联任务', exact: true }).click();
    await expect(card('从资料创建任务')(env.page)).toContainText('尚未保存的笔记内容');
  }, { window: true, importantStates: { 'WS-101': ['Saved versus unsaved source snapshot explanation'] }, tests: ['tests/e2e/to-doo-capture-polish.spec.ts'] }),
  recipe('trash-purge-confirm', ['WS-108'], 'Frozen actual trash selection and typed-confirmation validation', modal('永久移除回收站文件'), async env => {
    const item = await trashNote(env); await item.getByRole('button', { name: '永久移除文件', exact: true }).click();
    const dialog = env.page.getByRole('dialog', { name: '永久移除回收站文件', exact: true }); await dialog.getByLabel('输入“永久移除”确认本次所选文件', { exact: true }).fill('错误确认');
    await dialog.getByRole('button', { name: /^永久移除这/ }).click(); await expect(dialog.locator('#trash-purge-error')).toBeVisible();
  }, { window: true, importantStates: { 'WS-108': ['Frozen affected paths list', 'Invalid phrase inline error'] }, tests: ['tests/trash-workspace.test.ts'] }),
  recipe('trash-rename', ['WS-109'], 'Actual note restore rename form with invalid-name feedback', '.trash-workspace', async env => {
    const item = await trashNote(env); await item.getByRole('button', { name: '更换文件名', exact: true }).click();
    await item.getByRole('textbox').fill('../invalid.md'); await item.getByRole('button', { name: '恢复并打开', exact: true }).click();
    await expect(item.locator('.field-error')).toBeVisible();
  }, { importantStates: { 'WS-109': ['Invalid name inline error'] }, tests: ['tests/e2e/folder-trash.spec.ts'] }),
  recipe('trash-request-uncertain', ['WS-111'], 'Real restore request transport loss pauses new mutations', '.trash-workspace', async env => {
    const item = await trashNote(env); await env.page.route('**/api/manage/trash/restore', route => route.abort('failed'));
    await item.getByRole('button', { name: '恢复并打开', exact: true }).click(); await expect(button(env.page, '按原请求核对结果')).toBeVisible();
    await expect(env.page.locator('.trash-search button').first()).toBeDisabled();
  }, { fault: 'Abort actual restore POST before delivery; immutable pending request kept by UI', importantStates: { 'WS-111': ['Pending banner pauses new restore/purge and page selection', 'Network/server/OPERATION_OUTCOME_UNKNOWN retains request'] }, tests: ['tests/trash-workspace.test.ts'] }),
  recipe('trash-partial-results', ['WS-112'], 'Actual two-item restore produces real success and name-conflict results', '.operation-results', async env => {
    const notes = [await createWorkspaceNote(env), await createWorkspaceNote(env)];
    for (const note of notes) await env.fixture.api('/api/notes/' + note.id, 'DELETE', { noteId: note.id, expectedModifiedAt: note.modifiedAt, requestId: randomUUID() });
    const name = notes[1].relativePath.split('/').at(-1); await env.fixture.api('/api/notes', 'POST', { folderPath: '00-Inbox', fileName: name, content: '# 新占位\n', requestId: randomUUID() });
    await env.page.goto('/?view=trash');
    for (const note of notes) await env.page.locator('.trash-item').filter({ hasText: note.relativePath }).getByRole('checkbox').check();
    await button(env.page, '恢复所选').click();
    // A prior real worker/maintenance lease may return WORKSPACE_BUSY. Use only
    // the UI's immutable original-request check, never submit a new selection.
    await expect.poll(async () => {
      if (await env.page.locator('.operation-results').isVisible()) return true;
      const check = button(env.page, '按原请求核对结果');
      if (await check.isVisible() && await check.isEnabled()) await check.click();
      return env.page.locator('.operation-results').isVisible();
    }, { timeout: 45000, intervals: [250, 500, 1000] }).toBe(true);
    await expect(env.page.locator('.operation-results li')).toHaveCount(2);
    await expect(env.page.locator('.operation-results')).toContainText(/失败|冲突|占用/); await expect(env.page.locator('.operation-results .result-success')).toBeVisible();
  }, { importantStates: { 'WS-112': ['Partial success/failure per original path', 'Named failure reason'] }, tests: ['tests/trash-workspace.test.ts', 'tests/e2e/folder-trash.spec.ts'] }),
  recipe('full-note-path', ['WS-113'], 'Actual complete deep ancestry popup and first-folder focus', modal('完整笔记路径'), async env => {
    let parent = '00-Inbox'; const names = ['capture-ancestry-' + randomUUID(), '深层目录'];
    for (const name of names) { await env.fixture.api('/api/folders', 'POST', { parent, name }); parent += '/' + name; }
    const note = await createWorkspaceNote(env, '# 完整路径\n', parent); await env.page.goto('/?note=' + note.id); await closeSidebar(env.page); await button(env.page, '展开完整路径').click();
    const popup = env.page.getByRole('dialog', { name: '完整笔记路径', exact: true }); await expect(popup).toContainText(names[0]); await expect(popup.getByRole('button').first()).toBeFocused();
  }, { window: true, importantStates: { 'WS-113': ['Deep paths show every ancestor basename+full path', 'Focus first folder button on open'] }, tests: ['tests/e2e/document-breadcrumb.spec.ts'] }),
  recipe('share-expired', ['WS-116'], 'Real persisted expired owner share, no capability link row', '.share-dialog', async env => {
    const note = await createWorkspaceNote(env); await env.fixture.api('/api/notes/' + note.id + '/share', 'POST', { permission: 'view', expiresAt: new Date(Date.now() + 3600000).toISOString() });
    const root = await realpath(dirname(env.fixture.dataRoot)); if (dirname(root) !== await realpath(tmpdir()) || !basename(root).startsWith('dooknow-browser-')) throw Error('Refusing nonisolated share expiry fixture');
    const db = new Database(resolve(env.fixture.dataRoot, 'app.sqlite'), { fileMustExist: true, timeout: 30000 });
    try { const changed = db.prepare('UPDATE shares SET expires_at=? WHERE note_id=?').run(Date.now() - 60000, note.id); if (changed.changes !== 1) throw Error('Owned share fixture not found'); } finally { db.close(); }
    await env.page.goto('/?note=' + note.id); await button(env.page, '分享').click(); await expect(env.page.locator('.share-dialog')).toContainText('分享已到期'); await expect(env.page.locator('.share-link')).toHaveCount(0);
  }, { window: true, fault: 'Existing server-validated active share is made expired in guarded temporary DB; only this newly owned note row changes', importantStates: { 'WS-116': ['分享已到期 badge', 'No copy/link row because enabled=false', 'Reset/revoke buttons absent'] }, tests: ['tests/share-options.test.ts'] }),
  recipe('share-edit-unsupported', ['WS-119'], 'Actual primary whiteboard owner share cannot enable public editing', '.share-dialog', async env => {
    const { workspace, id } = await openPrimaryDiagram(env); await workspace.getByRole('button', { name: '分享', exact: true }).click();
    const status = await env.fixture.api('/api/notes/' + id + '/share'); expect(status.editSupported).toBe(false);
    await expect(env.page.locator('.share-dialog')).toContainText('图形分享暂不支持公开编辑');
    const permissions = env.page.locator('.share-dialog select[aria-label="分享权限"]');
    await expect(permissions).toHaveValue('view');
    const disabled = await permissions.locator('option[value="edit"]').evaluate((option: HTMLOptionElement) => option.disabled);
    if (!disabled) throw Error('REAL_UI_BLOCKER: owner share API rejects editing but the rendered edit option is enabled');
  }, { window: true, importantStates: { 'WS-119': ['Primary diagram cannot publicly edit'] }, tests: ['tests/shares-permissions-security.test.ts'] }),
  recipe('share-submit-busy', ['WS-121'], 'Real share mutation is busy while its committed response is held', '.share-dialog', async env => {
    await openNote(env); await button(env.page, '分享').click(); await hold(env, '**/api/notes/*/share', route => route.request().method() === 'POST');
    await env.page.locator('.share-dialog').getByRole('button', { name: '生成分享链接', exact: true }).click(); await expect(env.page.locator('.share-dialog select').first()).toBeDisabled();
  }, { window: true, fault: 'Fetch real successful share mutation then hold delivery until afterCapture, preserving actual busy state', importantStates: { 'WS-121': ['shareBusy action spinner and disabled form inputs/buttons'] }, tests: ['tests/share-options.test.ts'] }),
  recipe('global-reminder-host', ['WS-123'], 'Actual reminder event shown over a non-ToDoo note host', '.reminder-stack', async env => {
    const at = new Date(Date.now() - 60000).toISOString(), title = '隔离取证提醒 ' + randomUUID();
    const saved = await env.fixture.api('/api/to-doo/commands', 'POST', { requestId: randomUUID(), action: 'create_task', payload: { title, reminders: [{ id: randomUUID(), anchor: 'absolute', at }] } });
    const snapshot = await env.fixture.api('/api/to-doo/state?kinds=task,occurrence,habit,habitEntry,anniversary&limit=1000');
    const plan = notificationPlans(snapshot, new Date()).find(item => item.sourceId === saved.ids[0]); if (!plan) throw Error('Real reminder plan not generated');
    const id = reminderEventId(plan); values(env).reminderId = id;
    try { await env.fixture.api('/api/to-doo/reminders/' + id); } catch {
      try { await env.fixture.api('/api/to-doo/commands', 'POST', { requestId: randomUUID(), action: 'save_entity', payload: { kind: 'reminderEvent', entity: { ...plan, id, firstRaisedAt: new Date().toISOString() } } }); } catch { /* Scheduler can win creation; require the real event below. */ }
    }
    const card = await env.fixture.api('/api/to-doo/reminders/' + id); if (card.event.id !== id) throw Error('Wrong reminder fixture');
    await env.page.goto('/?note=' + env.fixture.noteId); await expect(env.page.locator('.reminder-stack .reminder-card')).toBeVisible({ timeout: 20000 }); await expect(env.page.locator('.reminder-stack')).toContainText(title);
  }, { importantStates: { 'WS-123': ['Global card visible while outside ToDoo'] }, afterCapture: async env => {
    const id = values(env).reminderId, card = await env.fixture.api('/api/to-doo/reminders/' + id);
    if (['unread', 'snoozed'].includes(card.event.userState)) await env.fixture.api('/api/to-doo/reminders/' + id + '/action', 'POST', { action: 'read', expectedRevision: card.event.revision, requestId: randomUUID() });
    return { ownFixtureReminderRetired: true, interiorUnchanged: true };
  }, tests: ['tests/e2e/to-doo-reminders.spec.ts'] }),
];
