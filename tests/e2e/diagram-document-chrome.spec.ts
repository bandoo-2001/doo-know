import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';
import { clickNoteAction } from '../support/note-actions';

test.setTimeout(90000);
test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

for (const [type, label] of [
  ['whiteboard', '白板'],
  ['mindmap', '脑图'],
  ['flowchart', '流程图'],
] as const) {
  test(`${label} 与文档共用页头样式，窄屏可切换视图并下载 Markdown`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto('/');
    const csrf = await (await page.request.get('/api/security/csrf')).json();
    const response = await page.request.post('/api/notes', {
      headers: { origin: new URL(page.url()).origin, 'x-csrf-token': csrf.token },
      data: {
        folderPath: '00-Inbox',
        fileName: `文档${label}test.md`,
        content: '# 文档\n\n正文。\n',
      },
    });
    expect(response.status()).toBe(201);
    const document = await response.json();
    await page.goto('/?note=' + document.id);
    await expect(page.getByRole('textbox', { name: '文档正文', exact: true })).toBeVisible();
    const appearance = (selector: string) =>
      page.locator(selector).evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          height: style.height,
          padding: style.padding,
          background: style.backgroundColor,
          border: style.borderBottomColor,
        };
      });
    const documentTopline = await appearance('.note-topline');
    const documentTools = await appearance('.document-format-row');
    await page.screenshot({
      path: info.outputPath('markdown-reference.png'),
      animations: 'disabled',
    });

    await page.getByRole('button', { name: '创建与导入', exact: true }).click();
    await page.getByRole('button', { name: '新建' + label, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '新建' + label, exact: true });
    const name = `${label}test`;
    await dialog.getByLabel('文件名', { exact: true }).fill(name);
    await dialog.getByRole('button', { name: '创建', exact: true }).click();
    const workspace = page.getByTestId('diagram-document-workspace');
    await expect(workspace.getByRole('status')).toContainText('已保存');
    await page.screenshot({ path: info.outputPath(type + '-desktop.png'), animations: 'disabled' });
    await workspace
      .locator('.note-header')
      .screenshot({ path: info.outputPath(type + '-header.png'), animations: 'disabled' });
    await expect(
      workspace.getByRole('navigation', { name: '笔记路径', exact: true }),
    ).toContainText(name);
    expect(await appearance('.note-topline')).toEqual(documentTopline);
    expect(await appearance('.document-format-row')).toEqual(documentTools);
    await expect(workspace.getByRole('button', { name: '收起侧栏', exact: true })).toBeVisible();
    await workspace.getByRole('button', { name: '收起侧栏', exact: true }).click();
    await expect(workspace.getByRole('button', { name: '展开侧栏', exact: true })).toBeVisible();
    await workspace.getByRole('button', { name: '展开侧栏', exact: true }).click();

    await page.setViewportSize({ width: 390, height: 844 });
    await workspace.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
    await expect(workspace.locator('.cm-content')).toContainText('dooknow:primary:start');
    await workspace.getByRole('button', { name: '阅读', exact: true }).click();
    await expect(workspace.locator('.diagram-reading')).toBeVisible();
    await expect(workspace.locator('.diagram-reading img')).toBeVisible();
    await expect(workspace.getByRole('button', { name: '阅读', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1);
    expect(
      await page.evaluate(() => document.documentElement.scrollHeight - innerHeight),
    ).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath(type + '-mobile.png'), animations: 'disabled' });
    const download = page.waitForEvent('download');
    await clickNoteAction(page, '下载 Markdown');
    expect((await download).suggestedFilename()).toMatch(/\.md$/);
    await workspace.getByRole('button', { name: '更多操作', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '图形文档操作', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: '图形文档操作', exact: true })).toBeHidden();
    await expect(workspace.getByRole('button', { name: '更多操作', exact: true })).toBeFocused();
  });
}
