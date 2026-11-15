import { expect, type Locator, type Page } from '@playwright/test';

function sourceEditor(page: Page) {
  return page.locator('.note-editor-host .cm-content').first();
}
function documentEditor(page: Page) {
  return page.locator('.document-editor .ProseMirror').first();
}
function readingPane(page: Page) {
  return page.locator('.preview-panel > .markdown').first();
}

/** Mode controls can live in the note menu; use the visible trigger instead of hidden DOM. */
async function modeControl(page: Page, label: string, fallback: string) {
  await expect(page.locator('.note-header')).toBeVisible();
  const primary = page.getByRole('button', { name: label, exact: true }).first();
  const legacy = page.getByRole('button', { name: fallback, exact: true }).first();
  if (await primary.isVisible()) return { control: primary, legacy: false };
  if (await legacy.isVisible()) return { control: legacy, legacy: true };
  const menu = page.locator('.note-header').getByRole('button', { name: '更多操作', exact: true });
  await expect(menu).toBeVisible();
  if ((await menu.getAttribute('aria-expanded')) !== 'true') await menu.click();
  await expect(primary.or(legacy).first()).toBeVisible();
  return (await primary.isVisible())
    ? { control: primary, legacy: false }
    : { control: legacy, legacy: true };
}
async function selectMode(control: Locator) {
  if ((await control.getAttribute('aria-pressed')) !== 'true') await control.click();
}

/** Request document editing when available; the rollout fallback remains its editable source. */
export async function showDocument(page: Page) {
  if (await documentEditor(page).isVisible()) return;
  const mode = await modeControl(page, '文档编辑', '编辑');
  await selectMode(mode.control);
  await expect(mode.legacy ? sourceEditor(page) : documentEditor(page)).toBeVisible();
}

/** Exercise the visible controls of both the released editor and its rollout fallback. */
export async function showSource(page: Page) {
  if (await sourceEditor(page).isVisible()) return;
  const mode = await modeControl(page, 'Markdown 源码', '编辑');
  await selectMode(mode.control);
  await expect(sourceEditor(page)).toBeVisible();
}
export async function showRead(page: Page) {
  if (
    (await readingPane(page).isVisible()) &&
    !(await sourceEditor(page).isVisible()) &&
    !(await documentEditor(page).isVisible())
  )
    return;
  const mode = await modeControl(page, '阅读', '预览');
  await selectMode(mode.control);
  await expect(readingPane(page)).toBeVisible();
  await expect(sourceEditor(page)).not.toBeVisible();
  await expect(documentEditor(page)).not.toBeVisible();
}
export async function showSplit(page: Page) {
  if ((await sourceEditor(page).isVisible()) && (await readingPane(page).isVisible())) return;
  const mode = await modeControl(page, 'Markdown 源码', '分屏');
  if (mode.legacy) await selectMode(mode.control);
  else {
    await selectMode(mode.control);
    const preview = page.getByRole('checkbox', { name: '同时预览', exact: true });
    if (!(await preview.isVisible())) {
      const menu = page
        .locator('.note-header')
        .getByRole('button', { name: '更多操作', exact: true });
      if ((await menu.getAttribute('aria-expanded')) !== 'true') await menu.click();
    }
    await preview.check();
  }
  await expect(sourceEditor(page)).toBeVisible();
  await expect(readingPane(page)).toBeVisible();
}
