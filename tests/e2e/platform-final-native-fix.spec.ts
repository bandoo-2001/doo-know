import { readFile, writeFile } from 'node:fs/promises';
import type { Locator, Page, TestInfo } from '@playwright/test';
import { test, expect } from '../support/browser-test';
import { closeSidebar, showSidebar } from '../support/settings-navigation';

test.setTimeout(90000);
test.beforeEach(async ({ context }) => context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8'))));

async function createBoard(page: Page, info?: TestInfo) {
  await page.goto('/'); await showSidebar(page);
  await page.getByRole('button', { name: '创建与导入', exact: true }).click();
  await page.getByRole('button', { name: '新建白板', exact: true }).click();
  const form = page.getByRole('dialog', { name: '新建白板', exact: true });
  await form.getByLabel('文件名', { exact: true }).fill('final-native-' + crypto.randomUUID());
  if (info) await page.screenshot({ path: info.outputPath('new-whiteboard-document-form.png'), animations: 'disabled' });
  await form.getByRole('button', { name: '创建', exact: true }).click();
  const workspace = page.getByTestId('diagram-document-workspace');
  await expect(workspace.locator('.excalidraw canvas.interactive')).toBeVisible({ timeout: 45000 });
  await expect(workspace.getByRole('status')).toContainText('已保存', { timeout: 45000 });
  await closeSidebar(page);
  const id = new URL(page.url()).searchParams.get('note')!;
  const scene = async () => JSON.parse((await (await page.request.get('/api/notes/' + id + '/diagram')).json()).source.content);
  return { workspace, native: workspace.locator('.excalidraw'), scene };
}
async function reachable(page: Page, target: Locator, info: TestInfo, label: string) {
  // Native scroll only: never force the pointer through fixed owner navigation.
  await target.scrollIntoViewIfNeeded();
  try {
    await expect.poll(() => target.evaluate(element => {
      const r = element.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      const nav = document.querySelector<HTMLElement>('.workspace-tabbar');
      const bottom = nav && getComputedStyle(nav).display !== 'none' ? nav.getBoundingClientRect().top : innerHeight;
      return r.top >= 0 && r.bottom <= bottom + 1 && (hit === element || !!hit && element.contains(hit));
    })).toBe(true);
  } finally {
    await page.screenshot({ path: info.outputPath(label + '.png'), animations: 'disabled' });
    await writeFile(info.outputPath(label + '-geometry.json'), JSON.stringify(await target.evaluate(element => {
      const r = element.getBoundingClientRect(), nav = document.querySelector('.workspace-tabbar');
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { x: r.x, y: r.y, width: r.width, height: r.height, navTop: nav?.getBoundingClientRect().top,
        centerHit: hit === element || !!hit && element.contains(hit), hit: hit?.outerHTML.slice(0, 300) };
    }), null, 2));
  }
}

// Non-text SVG controls need 3:1 against their rendered surface.
async function readableContrast(control: Locator, info: TestInfo, label: string, minimum = 3) {
  const contrast = () => control.evaluate(element => {
    const style = getComputedStyle(element);
    const rgb = (value: string) => value.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; });
    const luminance = (value: string) => { const [r, g, b] = rgb(value); return .2126 * r + .7152 * g + .0722 * b; };
    const a = luminance(style.color), b = luminance(style.backgroundColor);
    return { foreground: style.color, background: style.backgroundColor, contrast: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
  });
  try { await expect.poll(async () => (await contrast()).contrast).toBeGreaterThanOrEqual(minimum); }
  finally { await writeFile(info.outputPath(label + '-contrast.json'), JSON.stringify(await contrast(), null, 2)); }
}

// Catches the host's hardcoded white neutral-button background in dark theme.
test('more actions remain distinguishable and clickable in dark and light note and diagram chrome', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { workspace } = await createBoard(page, info);
  for (const theme of ['dark', 'light'] as const) {
    await page.evaluate(async theme => { const path = '/preferences.ts'; (await import(path)).setEditorPreferences({ theme }); }, theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const more = workspace.getByRole('button', { name: '更多操作', exact: true });
    await page.screenshot({ path: info.outputPath(theme + '-diagram-more.png'), animations: 'disabled' });
    await readableContrast(more, info, theme + '-diagram-more');
    await more.click(); await expect(page.getByRole('dialog', { name: '图形文档操作', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
  }
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const response = await page.request.post('/api/notes', { headers: { origin: new URL(page.url()).origin, 'x-csrf-token': csrf.token },
    data: { folderPath: '00-Inbox', fileName: 'final-more-' + crypto.randomUUID() + '.md', content: '# 笔记更多操作\n\n保留原文。', requestId: crypto.randomUUID() } });
  expect(response.status()).toBe(201);
  const id = (await response.json()).id;
  // Real isolated fixture share makes the same-source status strip visible.
  expect((await page.request.post('/api/notes/' + id + '/share', {
    headers: { origin: new URL(page.url()).origin, 'x-csrf-token': csrf.token }, data: { permission: 'view', expiresAt: null },
  })).ok()).toBe(true);
  await page.goto('/?note=' + id);
  for (const theme of ['dark', 'light'] as const) {
    await page.evaluate(async theme => { const path = '/preferences.ts'; (await import(path)).setEditorPreferences({ theme }); }, theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const more = page.getByRole('button', { name: '更多操作', exact: true });
    await expect(more).toBeVisible(); await expect(page.locator('.shared-status')).toBeVisible();
    await readableContrast(more, info, theme + '-note-more');
    await readableContrast(page.locator('.shared-status'), info, theme + '-shared-status', 4.5);
    await page.screenshot({ path: info.outputPath(theme + '-note-more.png'), animations: 'disabled' });
    await more.click(); await expect(page.locator('.note-action-menu')).toBeVisible(); await page.keyboard.press('Escape');
  }
});

test('stroke HEX scrolls above navigation and edits a manually saved rectangle in 844x390', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const { workspace, native, scene } = await createBoard(page);
  const radio = native.getByRole('radio', { name: '矩形', exact: true });
  await native.locator('label').filter({ has: page.getByRole('radio', { name: '矩形', exact: true }) }).click();
  await expect(radio).toBeChecked();
  const canvas = native.locator('canvas.interactive'), box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 420, box.y + 60); await page.mouse.down();
  await page.mouse.move(box.x + 540, box.y + 100, { steps: 8 }); await page.mouse.up();
  await workspace.getByRole('button', { name: '保存图形', exact: true }).click();
  await expect.poll(async () => (await scene()).elements.filter((e: { type: string }) => e.type === 'rectangle').length).toBe(1);
  const before = await scene();
  await page.setViewportSize({ width: 844, height: 390 });
  const stroke = native.getByRole('button', { name: '描边', exact: true });
  await expect.poll(async () => await stroke.isVisible() || await native.getByRole('button', { name: '编辑', exact: true }).isVisible()).toBe(true);
  if (!await stroke.isVisible()) await native.getByRole('button', { name: '编辑', exact: true }).click();
  await stroke.click();
  const input = native.getByRole('textbox', { name: '描边', exact: true });
  await expect(input).toBeVisible();
  await reachable(page, input, info, 'stroke-hex-open');
  await input.click(); await expect(input).toBeFocused();
  await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.type('c92a2a'); await page.keyboard.press('Enter');
  await expect(input).toHaveValue('c92a2a'); await page.keyboard.press('Escape');
  await native.getByRole('button', { name: '背景', exact: true }).click();
  const fill = native.getByRole('textbox', { name: '背景', exact: true });
  await reachable(page, fill, info, 'fill-hex-open');
  await fill.click(); await expect(fill).toBeFocused();
  await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.type('d5eadc'); await page.keyboard.press('Enter');
  await expect(fill).toHaveValue('d5eadc'); await page.keyboard.press('Escape');
  await workspace.getByRole('button', { name: '保存图形', exact: true }).click();
  await expect.poll(async () => (await scene()).elements.filter((e: { type: string; isDeleted?: boolean }) => e.type === 'rectangle' && !e.isDeleted).map((e: { strokeColor: string }) => e.strokeColor), { timeout: 30000 }).toEqual(['#c92a2a']);
  expect((await scene()).elements.filter((e: { type: string }) => e.type === 'rectangle').map((e: { backgroundColor: string }) => e.backgroundColor)).toEqual(['#d5eadc']);
  expect((await scene()).appState.viewBackgroundColor).toBe(before.appState.viewBackgroundColor);
  await writeFile(info.outputPath('saved-rectangle.json'), JSON.stringify(await scene(), null, 2));
  await page.screenshot({ path: info.outputPath('stroke-saved.png'), animations: 'disabled' });
});

for (const width of [320, 390]) {
  // Keeps the packaged nontrivial Christmas example, textarea and preview intact.
  test(`native Mermaid preview and insert are scrollable above navigation at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 844 });
    const { workspace, native, scene } = await createBoard(page);
    expect((await scene()).elements).toHaveLength(0);
    await native.getByRole('button', { name: '更多工具', exact: true }).click();
    await native.getByRole('button', { name: 'Mermaid 至 Excalidraw', exact: true }).click();
    const input = page.getByPlaceholder('Write Mermaid diagram defintion here...', { exact: true });
    await expect(input).toHaveValue(/Christmas/);
    const modal = page.locator('.excalidraw-modal-container .Modal').filter({ has: input });
    await expect(modal.locator('.ttd-dialog-output-wrapper')).toBeVisible();
    const insert = modal.getByRole('button', { name: /^插入/ });
    await expect(insert).toBeEnabled({ timeout: 30000 });
    await reachable(page, insert, info, 'mermaid-insert-scrolled');
    await insert.click(); await expect(input).toBeHidden();
    await workspace.getByRole('button', { name: '保存图形', exact: true }).click();
    await expect.poll(async () => (await scene()).elements.filter((e: { type: string }) => e.type === 'text').map((e: { text: string }) => e.text).join('\n'), { timeout: 30000 }).toContain('Christmas');
    expect((await scene()).elements.length).toBeGreaterThan(5);
    await writeFile(info.outputPath('inserted-scene.json'), JSON.stringify(await scene(), null, 2));
    await expect(workspace.getByRole('status')).toContainText('已保存');
    await page.screenshot({ path: info.outputPath('mermaid-inserted-saved.png'), animations: 'disabled' });
  });
}
