import { configurePlugin } from '../support/settings-navigation';
import { test, expect } from '../support/browser-test';
import { readFile } from 'node:fs/promises';

test('keeps note identity, secondary actions and editor preferences usable without losing the draft', async ({
  page,
  context,
}) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.goto('/');
  const csrf = await page.request.get('/api/security/csrf');
  const name = `长文编辑与整理-${test.info().project.name}-${Date.now()}.md`;
  const response = await page.request.post('/api/notes', {
    headers: { origin: 'http://127.0.0.1:4179', 'x-csrf-token': (await csrf.json()).token },
    data: {
      folderPath: '00-Inbox',
      fileName: name,
      content: '# 编辑验收\n\n原文保持不变。',
      requestId: crypto.randomUUID(),
    },
  });
  expect(response.status()).toBe(201);
  const note = await response.json();
  await page.goto('/?note=' + encodeURIComponent(note.id));
  await expect(page.locator('.note-header h1')).toBeVisible();
  await expect(page.locator('.note-header h1')).toContainText(name.replace(/\.md$/, ''));
  await expect(page.locator('.cm-gutters')).toBeHidden();
  await expect(page.getByRole('button', { name: '删除笔记', exact: true })).toBeHidden();
  await expect(page.locator('.toolbar').getByRole('button', { name: /^保存/ })).toBeDisabled();
  await page.locator('.cm-content').fill('# 保留本地草稿\n\n切换显示偏好时也不能丢失。');
  await page.getByRole('button', { name: '更多操作', exact: true }).click();
  await expect(page.getByRole('button', { name: '移动或重命名', exact: true })).toBeFocused();
  await page.getByRole('checkbox', { name: '显示行号', exact: true }).check();
  await expect(page.locator('.cm-gutters')).toBeVisible();
  await expect(page.locator('.cm-content')).toContainText('切换显示偏好时也不能丢失');
  const gutter = await page.locator('.cm-gutters').boundingBox();
  const text = await page.locator('.cm-content').boundingBox();
  expect(text!.x - gutter!.x - gutter!.width).toBeLessThan(40);
  await page.getByRole('button', { name: '历史版本', exact: true }).click();
  await expect(page.locator('.n-modal:visible')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.locator('.n-modal:visible').waitFor({ state: 'hidden' });
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('.cm-content')).toContainText('原文保持不变');
  await page.locator('.cm-content').fill('# 手动保存\n\n只在明确保存后落盘。');
  expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).toContain(
    '原文保持不变',
  );
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.locator('.save-state')).toContainText('已保存');
  if (test.info().project.name === 'mobile')
    await page.getByRole('button', { name: '打开侧栏' }).click();
  let signOuts = 0;
  page.on('request', (r) => {
    if (r.url().includes('/api/auth/sign-out')) signOuts++;
  });
  const account = page.getByRole('button', { name: '个人账户', exact: true });
  await expect(account).toHaveAttribute('aria-expanded', 'false');
  await expect(
    page.locator('.sidebar-footer').getByRole('button', { name: '回收站', exact: true }),
  ).toBeVisible();
  await account.click();
  await expect(account).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('button', { name: '账户设置', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(account).toHaveAttribute('aria-expanded', 'false');
  await expect(account).toBeFocused();
  await account.click();
  await account.click();
  await expect(page.getByRole('button', { name: '账户设置', exact: true })).toBeHidden();
  await expect(
    page.locator('.sidebar-footer').getByRole('button', { name: '设置', exact: true }),
  ).toBeVisible();
  await account.click();
  await page.getByRole('button', { name: '账户设置', exact: true }).click();
  await expect(page.getByRole('heading', { name: '修改密码', exact: true })).toBeVisible();
  expect(signOuts).toBe(0);
  await expect(page.getByRole('button', { name: '退出当前设备', exact: true })).toBeVisible();
});

test('allows keyboard and pointer resizing of the desktop directory and remembers the width', async ({
  page,
  context,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'Mobile uses a drawer');
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const separator = page.getByRole('separator', { name: '调整侧栏宽度' });
  const original = (await page.locator('.sidebar').boundingBox())!.width;
  await separator.focus();
  await page.keyboard.press('ArrowRight');
  expect((await page.locator('.sidebar').boundingBox())!.width).toBeGreaterThan(original);
  const box = (await separator.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + 100);
  await page.mouse.up();
  const resized = (await page.locator('.sidebar').boundingBox())!.width;
  expect(resized).toBeGreaterThan(original + 30);
  await page.reload();
  await expect(page.locator('.sidebar')).toBeVisible();
  expect((await page.locator('.sidebar').boundingBox())!.width).toBeCloseTo(resized, 0);
  await page.setViewportSize({ width: 900, height: 700 });
  const compactWidth = (await page.locator('.sidebar').boundingBox())!.width;
  await separator.focus();
  await page.keyboard.press('ArrowLeft');
  expect((await page.locator('.sidebar').boundingBox())!.width).toBeLessThan(compactWidth);
  await separator.focus();
  await page.keyboard.press('Home');
  await expect(page.locator('.main-content')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('explains invalid plugin input and confirms a successful save without sending invalid data', async ({
  page,
  context,
}) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.goto('/');
  await configurePlugin(page, 'MCP 服务');
  await page.locator('.plugin-advanced > summary').click();
  const input = page.getByRole('textbox', { name: '允许访问的目录', exact: true });
  const original = await input.inputValue();
  let saves = 0;
  page.on('request', (r) => {
    if (r.method() === 'PUT' && r.url().endsWith('/plugins/mcp/config')) saves++;
  });
  await input.fill('{');
  await page.getByRole('button', { name: '保存插件配置', exact: true }).click();
  await expect(page.locator('.plugin-feedback')).toContainText('允许访问的目录格式不正确');
  expect(saves).toBe(0);
  await expect(input).toHaveValue('{');
  await input.fill(original);
  await page.getByRole('button', { name: '保存插件配置', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '插件配置已保存' })).toBeVisible();
  expect(saves).toBe(1);
});
