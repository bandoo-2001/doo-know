import { test, expect } from '@playwright/test';
import type {} from './harness';
test('presentation exports override native embedScene without changing the authoritative scene', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForFunction(() => !!window.pngPrivacy);
  const output = await page.evaluate(() => window.pngPrivacy());
  const png = Buffer.from(output.png);
  const types: string[] = [];
  for (let offset = 8; offset + 12 <= png.length; offset += png.readUInt32BE(offset) + 12)
    types.push(png.subarray(offset + 4, offset + 8).toString('ascii'));
  expect(output.unchanged).toBe(true);
  expect(types).not.toContain('tEXt');
  expect(types).not.toContain('zTXt');
  expect(types).not.toContain('iTXt');
  expect(output.svg).not.toContain('payload-type:application/vnd.excalidraw+json');
  expect(output.svg.match(/<metadata[^>]*>([\s\S]*?)<\/metadata>/)?.[1] ?? '').toBe('');
});
