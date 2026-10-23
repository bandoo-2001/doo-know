import { test, expect } from '../support/browser-test';
import { readFile } from 'node:fs/promises';
test.setTimeout(90000);
test.use({ actionTimeout: 7000 });
test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});
async function create(page: import('@playwright/test').Page, fileName: string, content: string) {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const r = await page.request.post('/api/notes', {
    headers: { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token },
    data: { folderPath: '00-Inbox', fileName, content, requestId: crypto.randomUUID() },
  });
  expect(r.status(), await r.text()).toBe(201);
  return r.json();
}
const empty = () =>
  JSON.stringify({
    type: 'excalidraw',
    version: 2,
    elements: [],
    appState: { viewBackgroundColor: '#ffffff' },
    files: {},
  });
async function draw(page: import('@playwright/test').Page) {
  const canvas = page.getByTestId('whiteboard-workspace').locator('canvas.interactive');
  await expect(canvas).toBeVisible({ timeout: 30000 });
  const box = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: box.width * 0.6, y: box.height * 0.4 } });
  await page.keyboard.press('r');
  const x = box.x + box.width * 0.6,
    y = box.y + box.height * 0.5;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + Math.min(100, box.width * 0.2), y + 75, { steps: 8 });
  await page.mouse.up();
}

test('新建白板进入完整设计页，实际绘图保存后刷新可重新读取', async ({ page }, info) => {
  await page.goto('/');
  await page.getByRole('button', { name: '创建与导入', exact: true }).click();
  await page.getByRole('button', { name: '新建白板', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建白板', exact: true });
  await dialog.getByLabel('文件名', { exact: true }).fill('浏览器白板-' + crypto.randomUUID());
  await dialog.getByRole('button', { name: '创建', exact: true }).click();
  const workspace = page.getByTestId('whiteboard-workspace');
  await expect(workspace).toBeVisible();
  const canvas = workspace.locator('canvas.interactive');
  await expect(canvas).toBeVisible({ timeout: 30000 });
  const box = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: Math.min(170, box.width / 3), y: 200 } });
  await page.keyboard.press('r');
  const x = box.x + box.width * 0.6,
    y = box.y + box.height * 0.5;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + Math.min(120, box.width * 0.25), y + 90, { steps: 8 });
  await page.mouse.up();
  await workspace.getByRole('button', { name: '保存白板', exact: true }).click();
  await expect(workspace.locator('.whiteboard-status')).toContainText('已保存');
  const id = new URL(page.url()).searchParams.get('note')!;
  await expect
    .poll(
      async () =>
        JSON.parse((await (await page.request.get('/api/notes/' + id)).json()).content).elements
          .length,
    )
    .toBeGreaterThan(0);
  await page.reload();
  await expect(page.getByTestId('whiteboard-workspace').locator('canvas.interactive')).toBeVisible({
    timeout: 30000,
  });
  await expect(
    page.getByTestId('whiteboard-workspace').locator('.whiteboard-status'),
  ).toContainText('已保存');
});

test('笔记图块进入设计页后返回，保留未保存正文并更新白板预览', async ({ page }) => {
  const board = await create(page, '引用图-' + crypto.randomUUID() + '.excalidraw', empty());
  const content = '# 设计说明\n\n```excalidraw\n' + board.id + '\n```\n\n保留的正文。\n';
  const note = await create(page, '图文笔记-' + crypto.randomUUID() + '.md', content);
  await page.goto('/?note=' + note.id);
  await page.getByRole('button', { name: '文档编辑', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '文档正文', exact: true });
  await editor.locator('p').last().click();
  await page.keyboard.press('End');
  await page.keyboard.type('未保存文字');
  await editor.getByRole('button', { name: '编辑设计', exact: true }).click();
  const workspace = page.getByTestId('whiteboard-workspace');
  await expect(workspace.locator('canvas.interactive')).toBeVisible({ timeout: 30000 });
  await workspace.getByRole('button', { name: '返回笔记', exact: true }).click();
  await expect(workspace).toBeHidden();
  await expect(editor).toContainText('未保存文字');
  expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).toBe(content);
  await page.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText(board.id);
});

test('Mermaid 显示流程图并能转换为独立可编辑白板副本', async ({ page }) => {
  const content = '# 流程\n\n```mermaid\nflowchart TD\nA[开始] --> B[完成]\n```\n';
  const note = await create(page, 'Mermaid-' + crypto.randomUUID() + '.md', content);
  await page.goto('/?note=' + note.id);
  await page.getByRole('button', { name: '阅读', exact: true }).click();
  const diagram = page.locator('.preview-panel .diagram-card');
  await expect(diagram.locator('.diagram-image > svg')).toBeVisible({ timeout: 30000 });
  await expect(diagram.locator('.diagram-image')).toContainText('开始');
  await diagram.getByRole('button', { name: '转换为白板', exact: true }).click();
  await expect(page.getByTestId('whiteboard-workspace').locator('canvas.interactive')).toBeVisible({
    timeout: 30000,
  });
  await page.getByRole('button', { name: '返回笔记', exact: true }).click();
  expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).toBe(content);
});

test('保存已落盘但响应中断时保留草稿，重试使用相同请求编号且不产生重复版本', async ({ page }) => {
  const board = await create(page, '重试白板-' + crypto.randomUUID() + '.excalidraw', empty());
  await page.goto('/?note=' + board.id);
  const requests: any[] = [];
  let interrupted = false;
  await page.route('**/api/notes/' + board.id, async (route) => {
    if (route.request().method() !== 'PUT') {
      await route.continue();
      return;
    }
    requests.push(route.request().postDataJSON());
    if (!interrupted) {
      interrupted = true;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await route.abort('failed');
    } else await route.continue();
  });
  await draw(page);
  const workspace = page.getByTestId('whiteboard-workspace');
  await expect(workspace.getByRole('alert')).toBeVisible({ timeout: 15000 });
  await expect(workspace.getByRole('button', { name: '下载草稿', exact: true })).toBeVisible();
  await workspace.getByRole('button', { name: '重试', exact: true }).click();
  await expect(workspace.locator('.whiteboard-status')).toContainText('已保存');
  expect(requests.length).toBe(2);
  expect(requests[0].requestId).toBe(requests[1].requestId);
  const revisions = await (await page.request.get('/api/notes/' + board.id + '/revisions')).json();
  expect(revisions.items).toHaveLength(1);
});

test('外部修改与自动保存冲突时保留磁盘版本，下载草稿后可重新读取', async ({ page }) => {
  const board = await create(page, '冲突白板-' + crypto.randomUUID() + '.excalidraw', empty());
  await page.goto('/?note=' + board.id);
  await expect(page.getByTestId('whiteboard-workspace').locator('canvas.interactive')).toBeVisible({
    timeout: 30000,
  });
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const external = JSON.stringify({
    ...JSON.parse(empty()),
    appState: { viewBackgroundColor: '#fff3bf' },
  });
  const changed = await page.request.put('/api/notes/' + board.id, {
    headers: { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token },
    data: {
      content: external,
      expectedModifiedAt: board.modifiedAt,
      requestId: crypto.randomUUID(),
    },
  });
  expect(changed.status()).toBe(200);
  const externalContent = (await changed.json()).content;
  expect(JSON.parse(externalContent)).toMatchObject(JSON.parse(external));
  await draw(page);
  const workspace = page.getByTestId('whiteboard-workspace');
  await expect(workspace.getByRole('alert')).toContainText('已在其他位置更新', { timeout: 15000 });
  expect((await (await page.request.get('/api/notes/' + board.id)).json()).content).toBe(
    externalContent,
  );
  const download = page.waitForEvent('download');
  await workspace.getByRole('button', { name: '下载草稿', exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/\.excalidraw$/);
  await workspace.getByRole('button', { name: '重新读取', exact: true }).click();
  await expect(workspace.getByRole('alert')).toHaveCount(0);
  await expect(workspace.locator('.whiteboard-status')).toContainText('已保存');
  let writes = 0;
  page.on('request', (request) => {
    if (request.method() === 'PUT' && request.url().endsWith('/api/notes/' + board.id)) writes++;
  });
  await workspace.getByRole('button', { name: '恢复本地草稿', exact: true }).click();
  await expect(workspace.locator('.whiteboard-status')).toContainText('未保存');
  await page.waitForTimeout(1600);
  expect(writes).toBe(0);
  await workspace.getByRole('button', { name: '保存白板', exact: true }).click();
  await expect(workspace.locator('.whiteboard-status')).toContainText('已保存');
  expect(writes).toBe(1);
});

test('分享白板和笔记内引用只读展示且取消分享后无法再读取', async ({ page, context }) => {
  const code = {
    ...JSON.parse(empty()),
    elements: [
      { id: 'title', type: 'text', text: '只读架构', x: 10, y: 20, width: 100, height: 30 },
    ],
  };
  const board = await create(
    page,
    '分享白板-' + crypto.randomUUID() + '.excalidraw',
    JSON.stringify(code),
  );
  const note = await create(
    page,
    '分享说明-' + crypto.randomUUID() + '.md',
    '# 分享说明\n\n```excalidraw\n' + board.id + '\n```\n',
  );
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const headers = { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token };
  const share = await (
    await page.request.post('/api/notes/' + note.id + '/share', { headers })
  ).json();
  await context.clearCookies();
  await page.goto('/s/' + share.token);
  await expect(page.locator('.reader-layout .diagram-image > svg')).toBeVisible({ timeout: 30000 });
  await expect(page.getByRole('button', { name: '编辑设计', exact: true })).toHaveCount(0);
  const asset = '/api/public/shares/' + share.token + '/whiteboards/' + board.id;
  expect((await page.request.get(asset)).status()).toBe(200);
  // Reauthenticate only the API request to revoke the still-open public share.
  const cookies = JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8'));
  const cookie = cookies.map((c: any) => c.name + '=' + c.value).join('; ');
  const token = await (
    await page.request.get('/api/security/csrf', { headers: { cookie } })
  ).json();
  const fresh = await page.request.delete('/api/notes/' + note.id + '/share', {
    headers: { ...headers, cookie, 'x-csrf-token': token.token },
  });
  expect(fresh.status()).toBe(200);
  expect((await page.request.get(asset)).status()).toBe(404);
});

test('浏览器返回先退出嵌入设计页，保留原笔记与未保存正文', async ({ page }) => {
  const board = await create(page, '返回图-' + crypto.randomUUID() + '.excalidraw', empty());
  const note = await create(
    page,
    '返回笔记-' + crypto.randomUUID() + '.md',
    '# 返回测试\n\n```excalidraw\n' + board.id + '\n```\n\n保留正文。\n',
  );
  await page.goto('/?folder=00-Inbox');
  await page
    .locator('.folder-entry-open')
    .filter({ hasText: note.relativePath.split('/').at(-1) })
    .click();
  await page.getByRole('button', { name: '文档编辑', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '文档正文', exact: true });
  await editor.locator('p').last().click();
  await page.keyboard.press('End');
  await page.keyboard.type('返回草稿');
  await editor.getByRole('button', { name: '编辑设计', exact: true }).click();
  const workspace = page.getByTestId('whiteboard-workspace');
  await expect(workspace.locator('canvas.interactive')).toBeVisible({ timeout: 30000 });
  await page.goBack();
  await expect(workspace).toBeHidden();
  await expect(editor).toContainText('返回草稿');
  await expect(page).toHaveURL(new RegExp('note=' + note.id));
});

test('深色主题切换会重新绘制 Mermaid，白板画布和操作栏保持在视窗内', async ({ page }, info) => {
  const externalRequests: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (/^https?:$/.test(url.protocol) && url.origin !== 'http://127.0.0.1:4179')
      externalRequests.push(request.url());
  });
  const note = await create(
    page,
    '主题演示-' + crypto.randomUUID() + '.md',
    '# 系统设计\n\n```mermaid\nflowchart LR\nA[用户请求] --> B{身份验证}\nB -->|通过| C[读取知识库]\nB -->|失败| D[返回提示]\n```\n',
  );
  await page.goto('/?note=' + note.id);
  await page.getByRole('button', { name: '阅读', exact: true }).click();
  const svg = page.locator('.preview-panel .diagram-image > svg');
  await expect(svg).toBeVisible({ timeout: 30000 });
  const first = await svg.getAttribute('id');
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  await expect(svg).not.toHaveAttribute('id', first!);
  await expect(page.locator('.preview-panel .diagram-image')).toContainText('用户请求');
  await page
    .locator('.preview-panel .diagram-card')
    .getByRole('button', { name: '转换为白板', exact: true })
    .click();
  const workspace = page.getByTestId('whiteboard-workspace');
  await expect(workspace.locator('canvas.interactive')).toBeVisible({ timeout: 30000 });
  await expect(workspace.locator('.excalidraw')).toHaveClass(/theme--dark/);
  const bounds = await workspace.locator('.whiteboard-header').boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(await page.evaluate(() => innerWidth));
  await expect(workspace.getByRole('button', { name: '保存白板', exact: true })).toBeInViewport();
  await expect(page.locator('.toast')).toHaveCount(0, { timeout: 6000 });
  await page.screenshot({
    path: '.local/whiteboards/' + info.project.name + '-dark-preview.png',
    animations: 'disabled',
  });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
  });
  await expect(workspace.locator('.excalidraw')).not.toHaveClass(/theme--dark/);
  await page.screenshot({
    path: '.local/whiteboards/' + info.project.name + '-preview.png',
    animations: 'disabled',
  });
  const downloading = page.waitForEvent('download');
  await workspace.getByRole('button', { name: '导出 PNG', exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/\.png$/);
  const png = await readFile((await download.path())!);
  expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect(externalRequests).toEqual([]);
});
