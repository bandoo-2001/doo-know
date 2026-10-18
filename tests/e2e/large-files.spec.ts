import { test, expect } from '../support/browser-test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
test('resends an undelivered patch with its original ID and immutable payload', async ({
  page,
  context,
}, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const config = JSON.parse(await readFile('.local/e2e-config.json', 'utf8')),
    name = `未送达-${info.project.name}.md`,
    path = join(config.knowledgeRoot, '00-Inbox', name);
  const original = '# Original\nFIRST\n' + 'unchanged line\n'.repeat(160000) + 'UNLOADED_SENTINEL';
  await writeFile(path, original);
  await page.goto('/');
  await page.getByRole('button', { name: '00-Inbox', exact: true }).first().click();
  await page.locator('.folder-view').getByRole('button', { name, exact: true }).click();
  await expect(page.locator('.large-workspace .cm-content')).toContainText('FIRST');
  await page.locator('.large-workspace .cm-content').fill('# Retry\nUNCHANGED_REQUEST_ID\n');
  const payloads: any[] = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && /\/notes\/[^/]+\/patch$/.test(req.url()))
      payloads.push(req.postDataJSON());
  });
  await page.route(/\/api\/notes\/[^/]+\/patch$/, (route) => route.abort('failed'), { times: 1 });
  await page.getByRole('button', { name: '保存片段', exact: true }).click();
  await expect(page.getByRole('button', { name: '核对保存结果', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '核对保存结果', exact: true }).click();
  await expect(page.getByText('片段已保存', { exact: true })).toBeVisible();
  expect(payloads).toHaveLength(2);
  expect(payloads[1]).toEqual(payloads[0]);
  const saved = await readFile(path, 'utf8');
  expect(saved).toContain('UNCHANGED_REQUEST_ID');
  expect(saved.endsWith('UNLOADED_SENTINEL')).toBe(true);
});
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
  await page.getByRole('button', { name: '预览当前片段', exact: true }).click();
  await expect(page.locator('.large-preview')).toContainText('CHANGED');
  await expect(page.locator('.large-preview')).not.toContainText('UNLOADED_SENTINEL');
  await page.getByRole('button', { name: '关闭片段预览', exact: true }).click();
  await page.getByRole('button', { name: '保存片段', exact: true }).click();
  await expect(page.getByText('片段已保存', { exact: true })).toBeVisible();
  const updated = await readFile(path, 'utf8');
  expect(updated).toContain('CHANGED');
  expect(updated.endsWith('UNLOADED_SENTINEL')).toBe(true);
  expect(updated.length).toBeGreaterThan(2 * 1024 * 1024);
  await page.getByRole('button', { name: '下一片段', exact: true }).click();
  await expect(page.locator('.large-workspace p').filter({ hasText: /第 \d+/ })).not.toContainText(
    '第 1–',
  );
  const beforeRange = await page
    .locator('.large-workspace p')
    .filter({ hasText: /第 \d+/ })
    .innerText();
  const line = Number(beforeRange.match(/^第 (\d+)/)![1]);
  expect(line).toBeGreaterThan(1);
  await page.locator('.large-workspace .cm-content').fill('SECOND_PAGE_EDIT\n');
  await page.route(
    /\/api\/notes\/[^/]+\/patch$/,
    async (route) => {
      await route.fetch();
      await route.abort('failed');
    },
    { times: 1 },
  );
  await page.getByRole('button', { name: '保存片段', exact: true }).click();
  await expect(page.getByRole('button', { name: '核对保存结果', exact: true })).toBeVisible();
  await expect(page.locator('.large-workspace .cm-content')).toHaveAttribute(
    'contenteditable',
    'false',
  );
  await page.getByRole('button', { name: '核对保存结果', exact: true }).click();
  await expect(page.getByText('片段已保存', { exact: true })).toBeVisible();
  await expect(page.locator('.large-workspace p').filter({ hasText: /第 \d+/ })).toContainText(
    '第 ' + line + '–',
  );
  expect((await readFile(path, 'utf8')).endsWith('UNLOADED_SENTINEL')).toBe(true);
  await page.getByRole('button', { name: '历史版本', exact: true }).click();
  await page.getByRole('button', { name: '恢复此版本', exact: true }).last().click();
  await expect(page.locator('.large-workspace .cm-content')).toContainText('FIRST');
  expect((await readFile(path, 'utf8')).endsWith('UNLOADED_SENTINEL')).toBe(true);
});
