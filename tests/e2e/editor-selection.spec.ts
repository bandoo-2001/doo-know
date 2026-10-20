import { test, expect } from '../support/browser-test';
import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';

test.use({ sourceEditorPreference: true });

// Sample the rendered pixels above the glyphs: a styled selection layer can
// exist in the DOM while an opaque active-line background still hides it.
async function blueContrast(page: Page, rect: { x: number; y: number }) {
  const png = await page.screenshot({
    clip: { x: Math.ceil(rect.x) + 4, y: Math.ceil(rect.y) + 1, width: 6, height: 1 },
    animations: 'disabled',
  });
  return page.evaluate(async (base64) => {
    const bitmap = await createImageBitmap(
      new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], { type: 'image/png' }),
    );
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d')!;
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let contrast = 0;
    for (let i = 0; i < pixels.length; i += 4) contrast += pixels[i + 2] - pixels[i];
    return contrast / (pixels.length / 4);
  }, png.toString('base64'));
}

test('text selections remain visibly blue on the active line and after focusing the toolbar', async ({
  page,
  context,
}, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.goto('/');
  await expect(page.locator('.sidebar .brand')).toBeVisible();
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const text = '选中这段文字检查高亮';
  const original = `# 选区验收\n\n${text}\n\n下一段文字`;
  const response = await page.request.post('/api/notes', {
    headers: { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token },
    data: {
      folderPath: '00-Inbox',
      fileName: `selection-${crypto.randomUUID()}.md`,
      content: original,
      requestId: crypto.randomUUID(),
    },
  });
  expect(response.status()).toBe(201);
  const note = await response.json();
  await page.goto('/?note=' + note.id);
  const editor = page.locator('.cm-content');
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press('ControlOrMeta+Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe(text);
  const rect = await page.evaluate(() => {
    const box = getSelection()!.getRangeAt(0).getClientRects()[0];
    return { x: box.x, y: box.y };
  });
  await expect.poll(() => blueContrast(page, rect)).toBeGreaterThan(15);
  const format = page.getByRole('combobox', { name: '段落格式', exact: true });
  await format.focus();
  await expect(format).toBeFocused();
  await expect.poll(() => blueContrast(page, rect)).toBeGreaterThan(15);
  await page.screenshot({ path: info.outputPath('visible-selection.png'), animations: 'disabled' });

  // Formatting still operates on that selection after the toolbar takes focus.
  await page.getByRole('button', { name: '加粗', exact: true }).click();
  await expect(editor).toContainText(`**${text}**`);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(editor).not.toContainText('**');
  expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).toBe(original);
});
