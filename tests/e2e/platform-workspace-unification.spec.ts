import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';

test.use({ sourceEditorPreference: true });

for (const width of [320, 390]) {
  test(`diagram close prompt keeps recovery actions reachable and draft intact at ${width}px`, async ({
    page,
    context,
  }) => {
    test.setTimeout(90000);
    await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/');
    await page.getByRole('button', { name: '创建与导入', exact: true }).click();
    await page.getByRole('button', { name: '新建白板', exact: true }).click();
    const create = page.getByRole('dialog', { name: '新建白板', exact: true });
    await create.getByLabel('文件名', { exact: true }).fill('close-prompt-' + crypto.randomUUID());
    await create.getByRole('button', { name: '创建', exact: true }).click();
    const workspace = page.getByTestId('diagram-document-workspace');
    await expect(workspace.locator('canvas.interactive')).toBeVisible({ timeout: 30000 });
    await expect(workspace.getByRole('status')).toContainText('已保存');
    const boardId = new URL(page.url()).searchParams.get('note')!;
    const csrf = await (await page.request.get('/api/security/csrf')).json();
    const parentSource = '# 关闭提示宿主\n\n```excalidraw\n' + boardId + '\n```\n\n父正文保留。\n';
    const response = await page.request.post('/api/notes', {
      headers: { origin: new URL(page.url()).origin, 'x-csrf-token': csrf.token },
      data: {
        folderPath: '00-Inbox',
        fileName: 'close-parent-' + crypto.randomUUID() + '.md',
        content: parentSource,
      },
    });
    expect(response.status(), await response.text()).toBe(201);
    const parent = await response.json();
    await page.goto('/?note=' + parent.id);
    await page.getByRole('button', { name: '阅读', exact: true }).click();
    await page.locator('.preview-panel').getByRole('button', { name: '编辑设计', exact: true }).click();
    await expect(workspace.locator('canvas.interactive')).toBeVisible({ timeout: 30000 });
    await workspace.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
    const editor = workspace.locator('.cm-content');
    await expect(editor).toContainText('dooknow:primary:start');

    // Fault injection models an unavailable save transport, after real creation
    // and resource loading. It leaves the existing close/recovery path in charge
    // instead of replacing the session or synthesizing a prompt in the DOM.
    await page.route('**/api/diagram-documents/prepare', (route) => route.abort('failed'));
    await editor.click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.insertText('\n\n尚未保存的关闭提示草稿。\n');
    await expect(editor).toContainText('尚未保存的关闭提示草稿。');
    await page.setViewportSize({ width, height: 844 });
    await workspace.getByRole('button', { name: '返回笔记', exact: true }).click();
    const prompt = workspace.getByRole('dialog', { name: '保留图形草稿', exact: true });
    await expect(prompt).toBeVisible();
    const bounds = (await prompt.boundingBox())!;
    // A narrow prompt must have room to read all three recovery choices; a
    // 40%-wide strip can leave controls technically on screen but unreadable.
    expect(bounds.width).toBeGreaterThanOrEqual(width - 32);
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);
    for (const name of ['继续编辑', '下载草稿', '放弃修改并返回']) {
      const button = prompt.getByRole('button', { name, exact: true });
      await expect(button).toBeVisible();
      const box = (await button.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(bounds.x);
      expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width);
      expect(box.y).toBeGreaterThanOrEqual(bounds.y);
      expect(box.y + box.height).toBeLessThanOrEqual(bounds.y + bounds.height);
      expect(
        await button.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
        }),
      ).toBe(true);
    }
    await prompt.getByRole('button', { name: '继续编辑', exact: true }).click();
    await expect(prompt).toBeHidden();
    await expect(editor).toContainText('尚未保存的关闭提示草稿。');
    await editor.press('ControlOrMeta+Home');
    await expect(editor).toContainText('dooknow:primary:start');
    await expect(workspace).toBeVisible();
    expect(new URL(page.url()).searchParams.get('note')).toBe(parent.id);
    const original = await page.request.get('/api/notes/' + parent.id);
    expect(original.status()).toBe(200);
    expect((await original.json()).content).toBe(parentSource);
  });
}
