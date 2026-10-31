import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { test, expect } from '../support/browser-test';
test('owner uploads a complete extracted directory and reopens its durable import receipt', async ({
  page,
  context,
}, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const directory = info.outputPath('whole-package');
  await mkdir(join(directory, 'notes'), { recursive: true });
  const content = '# Desktop directory import\n';
  await writeFile(join(directory, 'notes/from-browser.md'), content);
  await writeFile(
    join(directory, 'dooknow-portable.json'),
    JSON.stringify({
      format: 'dooknow-portable',
      version: 1,
      files: [
        {
          path: 'notes/from-browser.md',
          kind: 'document',
          sizeBytes: Buffer.byteLength(content),
          sha256: createHash('sha256').update(content).digest('hex'),
        },
      ],
      selected: ['notes/from-browser.md'],
    }),
  );
  const calls: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/api/')) calls.push(new URL(r.url()).pathname);
  });
  await page.goto('/?view=settings&section=library');
  await page.getByRole('button', { name: '导入便携包', exact: true }).click();
  await page.locator('#portable-directory').setInputFiles(directory);
  await page.locator('#portable-archive-folder').fill('00-Inbox/browser-whole-' + Date.now());
  await page.getByRole('button', { name: '导入整包', exact: true }).click();
  await expect(page.getByText('导入完成：1 篇笔记，0 个附件。')).toBeVisible();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.reload();
  const receipts = page.getByRole('region', { name: '便携任务与结果' });
  await expect(receipts).toContainText('已完成');
  await expect(receipts).toContainText('notes/from-browser.md');
  expect(calls).toContain('/api/portable-deliveries/import-directory');
  expect(calls).not.toContain('/api/manage/import');
  await page.screenshot({
    path: info.outputPath('portable-directory-reopened.png'),
    animations: 'disabled',
  });
});
