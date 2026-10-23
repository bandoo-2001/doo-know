import { test, expect } from '../support/browser-test';
import { openDocumentNote } from '../support/document-editor';

const safeSvg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80"><rect width="160" height="80" fill="#3b82f6"/><text x="12" y="44" fill="white">SVG 图形</text></svg>';

test('SVG 围栏以安全图形展示，源码切换和源码编辑保留未改动正文', async ({ page, context }) => {
  const content = '# SVG 示例\n\n```svg\n' + safeSvg + '\n```\n\n```text\n普通代码\n```\n';
  const note = await openDocumentNote(page, context, content);
  const diagram = page.locator('.document-diagram .diagram-card');
  await expect(diagram.locator('.diagram-image > img')).toBeVisible();
  await expect(diagram.locator('.diagram-image > svg')).toHaveCount(0);
  await expect(page.locator('.document-code-block')).toHaveCount(1);
  await diagram.getByRole('button', { name: '源码', exact: true }).click();
  expect(await diagram.locator('.diagram-source').textContent()).toBe(safeSvg);
  await diagram.getByRole('button', { name: '预览', exact: true }).click();
  await expect(diagram.locator('.diagram-image > img')).toBeVisible();
  expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).toBe(content);
  await diagram.getByRole('button', { name: '编辑源码', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText(safeSvg);
  expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).toBe(content);
});

test('SVG 外部资源被拒绝，仍能查看和取回准确源码', async ({ page, context }) => {
  const outside: string[] = [];
  await page.route('https://outside.invalid/**', (route) => {
    outside.push(route.request().url());
    return route.abort();
  });
  const unsafe =
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://outside.invalid/pixel"/></svg>';
  const content = '```svg\n' + unsafe + '\n```\n';
  const note = await openDocumentNote(page, context, content);
  const diagram = page.locator('.document-diagram .diagram-card');
  await expect(diagram.getByRole('alert')).toContainText('SVG');
  await expect(diagram.locator('.diagram-image')).toHaveCount(0);
  await diagram.getByRole('button', { name: '源码', exact: true }).click();
  expect(await diagram.locator('.diagram-source').textContent()).toBe(unsafe);
  const downloading = page.waitForEvent('download');
  await diagram.getByRole('button', { name: '下载源码', exact: true }).click();
  expect((await downloading).suggestedFilename()).toBe('diagram.svg');
  expect(outside).toEqual([]);
  expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).toBe(content);
});

test('PNG 生成失败保留 SVG 源码与当前笔记，不报告保存成功', async ({ page, context }) => {
  const content = '```svg\n' + safeSvg + '\n```\n';
  const note = await openDocumentNote(page, context, content);
  const diagram = page.locator('.document-diagram .diagram-card');
  await expect(diagram.locator('.diagram-image > img')).toBeVisible();
  await page.evaluate(() => {
    HTMLCanvasElement.prototype.toBlob = function () {
      throw new DOMException('blocked canvas', 'SecurityError');
    };
  });
  await diagram.getByRole('button', { name: '生成通用预览', exact: true }).click();
  await expect(diagram.getByRole('alert')).toContainText('源码已保留');
  await diagram.getByRole('button', { name: '源码', exact: true }).click();
  expect(await diagram.locator('.diagram-source').textContent()).toBe(safeSvg);
  expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).toBe(content);
});

test('阅读与公开分享只展示图形和源码，不提供通用预览写入操作', async ({ page, context }) => {
  const content = '```svg\n' + safeSvg + '\n```\n';
  const note = await openDocumentNote(page, context, content);
  await page.getByRole('button', { name: '阅读', exact: true }).click();
  await expect(page.locator('.preview-panel .diagram-image > img')).toBeVisible();
  await expect(page.locator('.preview-panel').getByRole('button', { name: '编辑源码', exact: true })).toHaveCount(0);
  await expect(
    page.locator('.preview-panel').getByRole('button', { name: '生成通用预览', exact: true }),
  ).toHaveCount(0);
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const response = await page.request.post('/api/notes/' + note.id + '/share', {
    headers: { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token },
  });
  expect(response.status()).toBe(200);
  const share = await response.json();
  await context.clearCookies();
  await page.goto('/s/' + share.token);
  const diagram = page.locator('.reader-layout .diagram-card');
  await expect(diagram.locator('.diagram-image > img')).toBeVisible();
  await expect(diagram.getByRole('button', { name: '编辑源码', exact: true })).toHaveCount(0);
  await expect(diagram.getByRole('button', { name: '生成通用预览', exact: true })).toHaveCount(0);
  await diagram.getByRole('button', { name: '源码', exact: true }).click();
  expect(await diagram.locator('.diagram-source').textContent()).toBe(safeSvg + '\n');
});
