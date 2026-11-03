import { readFile, mkdir } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';

const artifacts = '.local/diagram-sharing-review';
test.setTimeout(90000);
test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await mkdir(artifacts, { recursive: true });
});

for (const [type, label] of [
  ['whiteboard', '白板'],
  ['flowchart', '流程图'],
  ['mindmap', '脑图'],
] as const) {
  test(`${label}真实保存后匿名分享可加载完整预览，撤销后不可读取`, async ({ page, browser }) => {
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto('/');
    await page.getByRole('button', { name: '创建与导入', exact: true }).click();
    await page.getByRole('button', { name: '新建' + label, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '新建' + label, exact: true });
    const fileName = label + '分享test';
    await dialog.getByLabel('文件名', { exact: true }).fill(fileName);
    await dialog.getByRole('button', { name: '创建', exact: true }).click();
    const workspace = page.getByTestId('diagram-document-workspace');
    await expect(workspace.getByRole('status')).toContainText('已保存');
    const id = new URL(page.url()).searchParams.get('note')!;
    if (type === 'whiteboard') {
      const canvas = workspace.locator('canvas.interactive');
      await expect(canvas).toBeVisible();
      const box = (await canvas.boundingBox())!;
      await canvas.click({ position: { x: 200, y: 200 } });
      await page.keyboard.press('r');
      await page.mouse.move(box.x + 350, box.y + 240);
      await page.mouse.down();
      await page.mouse.move(box.x + 550, box.y + 360, { steps: 8 });
      await page.mouse.up();
      await page.keyboard.press('Escape');
    } else if (type === 'mindmap') {
      const root = workspace.locator('me-root me-tpc');
      await expect(root).toBeVisible();
      await root.click();
      await page.keyboard.press('Tab');
      await workspace.locator('#input-box').fill('分享展示检查');
      await page.keyboard.press('Enter');
    } else {
      await workspace.locator('.cm-content').click();
      await page.keyboard.press('ControlOrMeta+a');
      await page.keyboard.insertText(
        'flowchart TD\nA[开始] --> B{是否完成}\nB -->|是| C[完成]\nB -->|否| A\n',
      );
    }
    await workspace.getByRole('button', { name: '保存图形', exact: true }).click();
    await expect(workspace.getByRole('status')).toContainText('已保存');
    await workspace.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
    await workspace.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.insertText(
      '\n\n这是' + label + 'test 的分享展示检查，图形与说明应完整显示。\n',
    );
    await workspace.getByRole('button', { name: '保存图形', exact: true }).click();
    await expect(workspace.getByRole('status')).toContainText('已保存');
    await workspace.getByRole('button', { name: label, exact: true }).click();
    if (type === 'whiteboard') await expect(workspace.locator('canvas.interactive')).toBeVisible();
    if (type === 'mindmap') await expect(workspace.locator('me-root me-tpc')).toBeVisible();
    await page.screenshot({ path: artifacts + '/' + type + '-editor.png', animations: 'disabled' });
    const origin = new URL(page.url()).origin;
    await workspace.getByRole('button', { name: '分享', exact: true }).click({ timeout: 5000 });
    const sharing = page.locator('.share-dialog');
    await expect(sharing).toBeVisible();
    await expect(sharing.getByLabel('分享权限', { exact: true })).toHaveValue('view');
    await expect(
      sharing.getByRole('checkbox', { name: '允许下载图形原件', exact: true }),
    ).not.toBeChecked();
    await sharing.getByRole('button', { name: '生成分享链接', exact: true }).click();
    await expect(sharing.getByRole('textbox', { name: '公开链接', exact: true })).not.toHaveValue(
      '',
    );
    const share = await (await page.request.get(`/api/notes/${id}/share`)).json();
    await sharing.getByRole('button', { name: '完成', exact: true }).click();
    await expect(workspace.locator('.shared-status')).toContainText('已分享');
    await page.reload();
    await expect(workspace.locator('.shared-status')).toContainText('已分享');
    expect(share.enabled).toBe(true);
    expect(share.editSupported).toBe(false);
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    try {
      const reader = await context.newPage();
      await reader.goto(origin + share.url);
      await expect(reader.locator('.reader-title')).toHaveText(fileName);
      await expect(reader.locator('article')).toContainText('图形与说明应完整显示');
      const image = reader.locator('article img');
      await expect(image).toHaveCount(1);
      await expect(image).toBeVisible();
      await expect
        .poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth))
        .toBeGreaterThan(1);
      await expect(reader.getByRole('button', { name: '编辑笔记', exact: true })).toHaveCount(0);
      await expect(reader.locator('article')).not.toContainText('dooknow:primary:start');
      await reader.screenshot({
        path: artifacts + '/' + type + '-share.png',
        animations: 'disabled',
        fullPage: true,
      });
      await reader.setViewportSize({ width: 390, height: 844 });
      expect(
        await reader.evaluate(() => document.documentElement.scrollWidth - innerWidth),
      ).toBeLessThanOrEqual(1);
      await reader.screenshot({
        path: artifacts + '/' + type + '-share-mobile.png',
        animations: 'disabled',
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      const shareButton = workspace.getByRole('button', { name: '分享', exact: true });
      await expect(shareButton).toBeVisible();
      await shareButton.click();
      await expect(sharing.getByRole('textbox', { name: '公开链接', exact: true })).toHaveValue(
        origin + share.url,
      );
      await sharing.getByRole('button', { name: '取消分享', exact: true }).click();
      await expect(workspace.locator('.shared-status')).toHaveCount(0);
      await sharing.getByRole('button', { name: '完成', exact: true }).click();
      await reader.reload();
      await expect(
        reader.getByRole('heading', { name: '分享不存在或已取消', exact: true }),
      ).toBeVisible();
    } finally {
      await context.close();
    }
  });
}
