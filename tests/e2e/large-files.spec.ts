import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
test('large document loads a fragment and saving preserves the unloaded tail', async ({
  page,
  context,
}, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const config = JSON.parse(await readFile('.local/e2e-config.json', 'utf8')),
    name = `大文件-${info.project.name}.md`,
    path = join(config.knowledgeRoot, '00-Inbox', name);
  const original = '# Large\nFIRST\n' + 'unchanged line\n'.repeat(160000) + 'UNLOADED_SENTINEL';
  await writeFile(path, original);
  const fullReads: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'GET' && /\/api\/notes\/[^/?]+$/.test(r.url())) fullReads.push(r.url());
  });
  await page.goto('/');
  await page.getByRole('button', { name: '00-Inbox', exact: true }).first().click();
  await page.locator('.folder-view').getByRole('button', { name, exact: true }).click();
  await expect(page.getByText('大文件模式', { exact: true })).toBeVisible();
  await expect(page.locator('.large-workspace .cm-content')).toContainText('FIRST');
  expect(fullReads).toEqual([]);
  await page.locator('.large-workspace .cm-content').fill('# Large\nCHANGED\n');
  await page.getByRole('button', { name: '保存片段', exact: true }).click();
  await expect(page.getByText('片段已保存', { exact: true })).toBeVisible();
  const updated = await readFile(path, 'utf8');
  expect(updated).toContain('CHANGED');
  expect(updated.endsWith('UNLOADED_SENTINEL')).toBe(true);
  expect(updated.length).toBeGreaterThan(2 * 1024 * 1024);
});
