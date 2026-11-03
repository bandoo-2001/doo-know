import { expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

/** Exercise the bundled owner UI, so preparations work with both Vite and release assets. */
export async function exportOwnerWhiteboardPng(page: Page, noteId: string): Promise<Buffer> {
  await page.goto('/?note=' + noteId);
  const workspace = page.getByTestId('whiteboard-workspace');
  await expect(workspace.locator('canvas.interactive')).toBeVisible({ timeout: 30000 });
  const exporting = workspace.getByRole('button', { name: '导出 PNG', exact: true });
  await expect(exporting).toBeEnabled();
  const downloading = page.waitForEvent('download');
  await exporting.click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/\.png$/);
  const bytes = await readFile((await download.path())!);
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect(bytes.readUInt32BE(16)).toBeGreaterThan(10);
  expect(bytes.readUInt32BE(20)).toBeGreaterThan(10);
  return bytes;
}
