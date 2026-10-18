import { clickNoteAction } from '../support/note-actions';
import { test, expect } from '../support/browser-test';
import { testPassword } from '../support/credentials.js';
test('login and two-column workspace with manual Markdown editing', async ({ page }, info) => {
  await page.goto('/');
  for (const path of ['apps/server/auth.ts', 'packages/core/db.ts', '.local/e2e-cookies.json']) {
    expect((await page.request.get('/@fs/' + process.cwd() + '/' + path)).status()).toBe(403);
  }
  await page.getByLabel('用户名', { exact: true }).waitFor();
  await page.screenshot({
    path: `test-results/${info.project.name}-login.png`,
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByLabel('用户名', { exact: true }).fill('owner');
  await page.getByLabel('密码', { exact: true }).fill(testPassword);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(
    page.locator('.sidebar').getByRole('button', { name: '新建笔记', exact: true }),
  ).toBeVisible();
  const search = await page.getByPlaceholder('搜索笔记与目录').boundingBox();
  const create = await page
    .locator('.sidebar')
    .getByRole('button', { name: '新建笔记', exact: true })
    .boundingBox();
  expect(
    Math.abs(search!.y + search!.height / 2 - create!.y - create!.height / 2),
  ).toBeLessThanOrEqual(2);
  expect(search!.x + search!.width).toBeLessThan(create!.x);
  expect(create!.width).toBeLessThanOrEqual(40);
  await expect(page.getByRole('button', { name: '全部笔记', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '选择一篇笔记', exact: true })).toBeVisible();
  await expect(page.locator('.folder-view')).toHaveCount(0);
  await page.getByRole('button', { name: '方法', exact: true }).click();
  await expect(page.locator('.folder-view')).toBeVisible();
  if (info.project.name === 'mobile') await page.getByRole('button', { name: '打开侧栏' }).click();
  await page.getByRole('button', { name: '入门指南.md', exact: true }).first().click();
  await expect(page.locator('.cm-editor')).toBeVisible();
  await page.locator('.cm-content').fill(`# 网页修改\n\n手动保存验收 ${info.project.name}`);
  await expect(page.locator('.save-state')).toContainText('未保存');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.locator('.save-state')).toContainText('已保存');
  await page.getByRole('button', { name: '预览', exact: true }).click();
  await expect(page.locator('.markdown').getByRole('heading', { name: '网页修改' })).toBeVisible();
  await page.screenshot({
    path: `test-results/${info.project.name}-editor.png`,
    fullPage: true,
    animations: 'disabled',
  });
});

test('returns to an unselected workspace when a root note is deleted', async ({
  page,
  context,
}) => {
  const { readFile, writeFile, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { knowledgeRoot } = JSON.parse(await readFile('.local/e2e-config.json', 'utf8'));
  const fileName = 'README.md';
  const file = join(knowledgeRoot, fileName);
  await writeFile(file, '# 根目录笔记\n\n删除后回到未选择笔记的状态。', { flag: 'wx' });
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  try {
    await page.goto('/');
    await page.locator('.tree-scroll').getByRole('button', { name: fileName, exact: true }).click();
    await expect(page.locator('.cm-content')).toBeVisible();
    await clickNoteAction(page, '删除笔记');
    await page.getByRole('button', { name: '移入回收站', exact: true }).click();
    await expect(page.getByRole('heading', { name: '选择一篇笔记', exact: true })).toBeVisible();
    await expect(page.locator('.folder-view')).toHaveCount(0);
  } finally {
    await rm(file, { force: true });
  }
});

test.describe('authenticated feature acceptance', () => {
  let cookies: any[] = [];
  test.beforeAll(async () => {
    const { readFile } = await import('node:fs/promises');
    cookies = JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8'));
  });
  test.beforeEach(async ({ context, page }) => {
    await context.addCookies(cookies);
    await page.goto('/');
    await expect(page.locator('.sidebar .brand')).toContainText('DooKnow');
  });
  async function headers(page: any) {
    const csrf = await page.request.get('/api/security/csrf');
    return { origin: 'http://127.0.0.1:4179', 'x-csrf-token': (await csrf.json()).token };
  }
  async function newNote(page: any, title: string) {
    const h = await headers(page);
    const r = await page.request.post('/api/notes', {
      headers: h,
      data: {
        folderPath: '00-Inbox',
        fileName: title + '.md',
        content: '# ' + title + '\n\n## 整理方法\n\n- 收集想法\n- 按主题整理\n\n> 让知识慢慢积累。',
      },
    });
    expect(r.status()).toBe(201);
    await page.locator('.sidebar').getByRole('button', { name: '刷新目录' }).click();
    await page
      .getByRole('button', { name: title + '.md', exact: true })
      .first()
      .click();
    return { n: await r.json(), h };
  }
  test('conflict cancellation, another external change and explicit overwrite', async ({
    page,
  }, info) => {
    const { n, h } = await newNote(page, '冲突验收-' + info.project.name);
    const original = n.content;
    await page.locator('.cm-content').fill('# 保留编辑\n\n我的修改');
    const { readFile, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { knowledgeRoot } = JSON.parse(await readFile('.local/e2e-config.json', 'utf8'));
    expect(await readFile(join(knowledgeRoot, n.relativePath), 'utf8')).toBe(original);
    await writeFile(join(knowledgeRoot, n.relativePath), '# 外部第一次修改');
    await page.locator('.toolbar').getByRole('button', { name: /^保存/ }).click();
    await expect(page.getByText('原文件已更新', { exact: true })).toBeVisible();
    await expect(page.locator('.n-modal')).toHaveCSS('opacity', '1');
    await page.screenshot({
      path: `test-results/${info.project.name}-conflict.png`,
      fullPage: true,
      animations: 'disabled',
    });
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await expect(page.locator('.cm-content')).toContainText('我的修改');
    expect(await readFile(join(knowledgeRoot, n.relativePath), 'utf8')).toBe('# 外部第一次修改');
    await page.locator('.toolbar').getByRole('button', { name: /^保存/ }).click();
    await expect(page.getByText('原文件已更新', { exact: true })).toBeVisible();
    await writeFile(join(knowledgeRoot, n.relativePath), '# 外部第二次修改');
    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes('/api/notes/') && r.request().method() === 'PUT' && r.status() === 409,
      ),
      page.getByRole('button', { name: '确定覆盖', exact: true }).click(),
    ]);
    await expect(page.getByText('原文件已更新', { exact: true })).toBeVisible();
    expect(await readFile(join(knowledgeRoot, n.relativePath), 'utf8')).toBe('# 外部第二次修改');
    await page.getByRole('button', { name: '确定覆盖', exact: true }).click();
    await expect(page.locator('.save-state')).toContainText('已保存');
    expect(await readFile(join(knowledgeRoot, n.relativePath), 'utf8')).toContain('我的修改');
    const second = await page.context().newPage();
    await second.goto('/');
    await second
      .getByRole('button', { name: n.relativePath.split('/').at(-1), exact: true })
      .first()
      .click();
    await second.locator('.cm-content').fill('# 第二个标签页');
    await second.locator('.toolbar').getByRole('button', { name: /^保存/ }).click();
    await expect(second.locator('.save-state')).toContainText('已保存');
    await page.locator('.cm-content').fill('# 第一标签页的新修改');
    await page.locator('.toolbar').getByRole('button', { name: /^保存/ }).click();
    await expect(page.getByText('原文件已更新', { exact: true })).toBeVisible();
    await second.close();
  });
  test('live share, clipboard, upload, preview and guest isolation', async ({
    page,
    browser,
  }, info) => {
    const { n, h } = await newNote(page, '搭建自己的知识库-' + info.project.name);
    await page.getByRole('button', { name: '分屏', exact: true }).click();
    await page.screenshot({
      path: `test-results/${info.project.name}-split.png`,
      fullPage: true,
      animations: 'disabled',
    });
    await page.getByRole('button', { name: '分享', exact: true }).click();
    await page.getByRole('button', { name: '生成分享链接', exact: true }).click();
    const input = page.getByRole('textbox', { name: '公开链接' });
    await expect(input).not.toHaveValue('');
    const shareUrl = await input.inputValue();
    await page.screenshot({
      path: `test-results/${info.project.name}-share.png`,
      fullPage: true,
      animations: 'disabled',
      mask: [input],
      maskColor: '#eaf5ff',
    });
    if (info.project.name === 'desktop') {
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
      await page.getByRole('button', { name: '复制链接' }).click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(shareUrl);
    }
    await page.getByRole('button', { name: '完成', exact: true }).click();
    await expect(page.getByText('已分享，保存后的修改将同步公开')).toBeVisible();
    const guest = await browser.newContext();
    const reader = await guest.newPage();
    await reader.goto(shareUrl);
    await expect(reader.locator('.reader-title')).toContainText('搭建自己的知识库');
    expect(await reader.locator('.sidebar').count()).toBe(0);
    await reader.screenshot({
      path: `test-results/${info.project.name}-reader.png`,
      fullPage: true,
      animations: 'disabled',
    });
    expect((await guest.request.get('http://127.0.0.1:4179/api/tree')).status()).toBe(401);
    await page.locator('.cm-content').fill('# 网页保存实时更新\n\n新的内容');
    await reader.reload();
    await expect(reader.locator('.reader-title')).not.toContainText('网页保存实时更新');
    await page.locator('.toolbar').getByRole('button', { name: /^保存/ }).click();
    await expect(page.locator('.save-state')).toContainText('已保存');
    await reader.reload();
    await expect(reader.locator('.reader-title')).toContainText('网页保存实时更新');
    const { readFile, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { knowledgeRoot } = JSON.parse(await readFile('.local/e2e-config.json', 'utf8'));
    await writeFile(join(knowledgeRoot, n.relativePath), '# 本地更新也公开');
    await reader.reload();
    await expect(reader.locator('.reader-title')).toContainText('本地更新也公开');
    await page.locator('input[type=file]').setInputFiles({
      name: '示例.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=',
        'base64',
      ),
    });
    await expect(page.locator('.cm-content')).toContainText('示例.png');
    await page.locator('.toolbar').getByRole('button', { name: /^保存/ }).click();
    await page.getByRole('button', { name: '确定覆盖', exact: true }).click();
    await expect(page.locator('.save-state')).toContainText('已保存');
    await expect(page.locator('.markdown img')).toBeVisible();
    await reader.reload();
    await expect(reader.locator('.markdown img')).toBeVisible();
    await page.getByRole('button', { name: '分享', exact: true }).click();
    await page.getByRole('button', { name: '重置链接', exact: true }).click();
    await expect(input).not.toHaveValue(shareUrl);
    await reader.reload();
    await expect(reader.getByRole('heading', { name: '分享不存在或已取消' })).toBeVisible();
    const reset = await input.inputValue();
    await page.getByRole('button', { name: '取消分享', exact: true }).click();
    await expect(page.getByRole('button', { name: '生成分享链接', exact: true })).toBeVisible();
    await reader.goto(reset);
    await expect(reader.getByRole('heading', { name: '分享不存在或已取消' })).toBeVisible();
    await guest.close();
  });
  test('nested tree, directory layout, search, unsaved guard and recovery', async ({
    page,
  }, info) => {
    const { n, h } = await newNote(page, '组织与恢复-' + info.project.name);
    await page.locator('.cm-content').fill('# 尚未保存的想法');
    if (info.project.name === 'mobile')
      await page.getByRole('button', { name: '打开侧栏' }).click();
    await page
      .locator('.tree-scroll')
      .getByRole('button', { name: '00-Inbox', exact: true })
      .click();
    await expect(page.getByText('当前笔记尚未保存', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await expect(page.locator('.cm-content')).toContainText('尚未保存的想法');
    if (info.project.name === 'mobile')
      await page.getByRole('button', { name: '关闭侧栏' }).click();
    await page.locator('.toolbar').getByRole('button', { name: /^保存/ }).click();
    await expect(page.locator('.save-state')).toContainText('已保存');
    await clickNoteAction(page, '历史版本');
    await page.getByRole('button', { name: '恢复此版本' }).first().click();
    await expect(page.locator('.cm-content')).toContainText('整理方法');
    if (info.project.name === 'mobile')
      await page.getByRole('button', { name: '打开侧栏' }).click();
    await page.getByRole('button', { name: '方法', exact: true }).click();
    await expect(page.locator('.folder-view')).toBeVisible();
    await page.screenshot({
      path: `test-results/${info.project.name}-folder.png`,
      fullPage: true,
      animations: 'disabled',
    });
    const box = await page.locator('.main-content').boundingBox();
    const sidebar = await page.locator('.sidebar').boundingBox();
    if (info.project.name === 'desktop') expect(box!.x).toBe(sidebar!.width);
    else expect(box!.x).toBe(0);
    expect(box!.x + box!.width).toBe(page.viewportSize()!.width);
    expect(box!.y + box!.height).toBeCloseTo(page.viewportSize()!.height, 0);
    if (info.project.name === 'mobile')
      await page.getByRole('button', { name: '打开侧栏' }).click();
    await page.getByPlaceholder('搜索笔记与目录').fill('组织与恢复-' + info.project.name);
    const matchingNote = page.locator('.search-result').filter({ hasText: n.relativePath });
    await expect(matchingNote).toHaveCount(1);
    await matchingNote.click();
    await clickNoteAction(page, '删除笔记');
    await page.getByRole('button', { name: '移入回收站', exact: true }).click();
    if (info.project.name === 'mobile')
      await page.getByRole('button', { name: '打开侧栏' }).click();
    if (!(await page.getByRole('button', { name: '回收站', exact: true }).isVisible()))
      await page.getByRole('button', { name: '个人账户', exact: true }).click();
    await page.getByRole('button', { name: '回收站', exact: true }).click();
    const deleted = page.locator('.utility-row').filter({ hasText: n.relativePath });
    await deleted.getByRole('button', { name: '恢复', exact: true }).click();
    await expect(deleted).toHaveCount(0);
  });
});

test.describe('write failure and reauthentication', () => {
  test('keeps draft on failed write and lost session, then writes after login', async ({
    page,
    context,
  }, info) => {
    const { readFile, rename, writeFile, unlink } = await import('node:fs/promises');
    const { join } = await import('node:path');
    await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
    await page.goto('/');
    await expect(page.locator('.sidebar .brand')).toContainText('DooKnow');
    await page.locator('.sidebar').getByRole('button', { name: '新建笔记', exact: true }).click();
    await page
      .getByRole('textbox', { name: '文件名', exact: true })
      .fill('故障与会话-' + info.project.name);
    await page.getByRole('button', { name: '创建', exact: true }).click();
    await expect(page.locator('.cm-editor')).toBeVisible();
    await page.locator('.cm-content').fill('# 草稿不会丢失\n\n保留当前编辑');
    const cfg = JSON.parse(await readFile('.local/e2e-config.json', 'utf8')),
      history = join(cfg.dataRoot, 'history'),
      held = history + '-held';
    await rename(history, held);
    try {
      await writeFile(history, 'BLOCK_HISTORY');
      await page.locator('.toolbar').getByRole('button', { name: /^保存/ }).click();
      await expect(page.getByText('操作失败，内容未标记为保存')).toBeVisible();
      await expect(page.locator('.save-state')).toContainText('未保存');
      await expect(page.locator('.cm-content')).toContainText('保留当前编辑');
    } finally {
      await unlink(history);
      await rename(held, history);
    }
    await context.clearCookies();
    await page.locator('.toolbar').getByRole('button', { name: /^保存/ }).click();
    await expect(page.getByRole('heading', { name: '登录已失效' })).toBeVisible();
    await page.getByLabel('用户名', { exact: true }).fill('owner');
    await page.getByLabel('密码', { exact: true }).fill(testPassword);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: '登录已失效' })).toHaveCount(0);
    await expect(page.locator('.cm-content')).toContainText('保留当前编辑');
    await page.locator('.toolbar').getByRole('button', { name: /^保存/ }).click();
    await expect(page.locator('.save-state')).toContainText('已保存');
    expect(
      await readFile(
        join(cfg.knowledgeRoot, '00-Inbox/故障与会话-' + info.project.name + '.md'),
        'utf8',
      ),
    ).toContain('保留当前编辑');
  });
});

test('late save and open responses never replace another note', async ({ page, context }, info) => {
  const { readFile } = await import('node:fs/promises'),
    { join } = await import('node:path');
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.goto('/');
  await expect(page.locator('.sidebar .brand')).toContainText('DooKnow');
  const csrf = await page.request.get('/api/security/csrf'),
    h = { origin: 'http://127.0.0.1:4179', 'x-csrf-token': (await csrf.json()).token };
  const create = async (label: string) => {
    const r = await page.request.post('/api/notes', {
      headers: h,
      data: {
        folderPath: '00-Inbox',
        fileName: label + '.md',
        content: '# ' + label + '\n\n原文 ' + label,
      },
    });
    expect(r.status()).toBe(201);
    return r.json();
  };
  const a = await create('迟到A-' + info.project.name),
    b = await create('迟到B-' + info.project.name);
  await page.locator('.sidebar').getByRole('button', { name: '刷新目录' }).click();
  await page
    .getByRole('button', { name: a.relativePath.split('/').at(-1), exact: true })
    .first()
    .click();
  let release!: () => void, started!: () => void;
  const held = new Promise<void>((r) => (release = r)),
    captured = new Promise<void>((r) => (started = r));
  await page.route(`**/api/notes/${a.id}`, async (route) => {
    if (route.request().method() === 'PUT') {
      const response = await route.fetch();
      started();
      await held;
      await route.fulfill({ response });
    } else await route.continue();
  });
  await page.locator('.cm-content').fill('# 迟到A\n\n原文 迟到A\n\n并发保存验收');
  await page.locator('.toolbar').getByRole('button', { name: /^保存/ }).click();
  await captured;
  if (info.project.name === 'mobile') await page.getByRole('button', { name: '打开侧栏' }).click();
  await page
    .getByRole('button', { name: b.relativePath.split('/').at(-1), exact: true })
    .first()
    .click();
  await expect(page.getByText('当前笔记尚未保存', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '放弃修改', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('迟到B');
  release();
  await expect(page.locator('.toolbar button').last()).not.toHaveClass(/loading/);
  await expect(page.locator('.cm-content')).toContainText('迟到B');
  await expect(page.locator('.cm-content')).toContainText('原文 迟到B');
  await page.locator('.cm-content').fill('# B 的新内容');
  await page.locator('.toolbar').getByRole('button', { name: /^保存/ }).click();
  await expect(page.locator('.save-state')).toContainText('已保存');
  const cfg = JSON.parse(await readFile('.local/e2e-config.json', 'utf8'));
  expect(await readFile(join(cfg.knowledgeRoot, a.relativePath), 'utf8')).toContain('原文 迟到A');
  expect(await readFile(join(cfg.knowledgeRoot, a.relativePath), 'utf8')).toContain('并发保存验收');
  expect(await readFile(join(cfg.knowledgeRoot, b.relativePath), 'utf8')).toBe('# B 的新内容');
  await page.unroute(`**/api/notes/${a.id}`);
  let releaseOpen!: () => void, openStarted!: () => void;
  const holdOpen = new Promise<void>((r) => (releaseOpen = r)),
    opening = new Promise<void>((r) => (openStarted = r));
  await page.route(`**/api/notes/${a.id}`, async (route) => {
    const response = await route.fetch();
    openStarted();
    await holdOpen;
    await route.fulfill({ response });
  });
  if (info.project.name === 'mobile') await page.getByRole('button', { name: '打开侧栏' }).click();
  await page
    .getByRole('button', { name: a.relativePath.split('/').at(-1), exact: true })
    .first()
    .click();
  await opening;
  await page
    .getByRole('button', { name: b.relativePath.split('/').at(-1), exact: true })
    .first()
    .click();
  await expect(page.locator('.cm-content')).toContainText('B 的新内容');
  releaseOpen();
  await page.waitForResponse((r) => r.url().endsWith('/' + a.id));
  await expect(page.locator('.cm-content')).toContainText('B 的新内容');
});
