import { test, expect } from '../support/browser-test';
import { readFile } from 'node:fs/promises';
test.use({ actionTimeout: 7000 });

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

test('账户页面保留摘要，密码表单按需打开并在取消后清空', async ({ page }) => {
  await page.goto('/?view=settings&section=account');
  await expect(page.getByRole('heading', { name: '当前账户', exact: true })).toBeVisible();
  await expect(page.getByLabel('当前密码', { exact: true })).toHaveCount(0);
  const open = page.getByRole('button', { name: '修改密码', exact: true });
  await open.click();
  const dialog = page.getByRole('dialog', { name: '修改密码', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('当前密码', { exact: true }).fill('not-a-real-password');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await dialog.getByRole('button', { name: '放弃更改', exact: true }).click();
  await expect(dialog).toBeHidden();
  await open.click();
  await expect(dialog.getByLabel('当前密码', { exact: true })).toHaveValue('');
  await expect(dialog.getByLabel('新密码', { exact: true })).toHaveValue('');
});

test('恢复密钥和备份恢复仅显示入口，任务记录始终留在页面', async ({ page }) => {
  await page.goto('/?view=settings&section=backup');
  await expect(page.getByLabel('当前密码', { exact: true })).toHaveCount(0);
  await expect(page.locator('#restore-backup-file')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '任务与结果', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '下载恢复密钥', exact: true }).click();
  const key = page.getByRole('dialog', { name: '下载恢复密钥', exact: true });
  await expect(key).toBeVisible();
  await expect(key.getByLabel('当前密码', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(key).toBeHidden();
  await page.getByRole('button', { name: '从备份恢复', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '从备份恢复', exact: true })).toBeVisible();
});

test('导入导出表单按需打开，关闭不会隐藏任务与结果', async ({ page }) => {
  await page.goto('/?view=settings&section=library');
  await expect(page.locator('#import-files')).toHaveCount(0);
  await page.getByRole('button', { name: '批量导入', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '批量导入', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('#import-files')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('heading', { name: '任务与结果', exact: true })).toBeVisible();
});

test('键盘说明按需打开，Escape 关闭并返回触发按钮', async ({ page }) => {
  await page.goto('/?view=settings&section=editor');
  const open = page.getByRole('button', { name: '查看快捷键', exact: true });
  await open.click();
  const dialog = page.getByRole('dialog', { name: '键盘操作', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Ctrl');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(open).toBeFocused();
});

test('密码校验只在弹窗中展示，Escape 询问后可以继续编辑并在放弃后恢复焦点', async ({ page }) => {
  await page.goto('/?view=settings&section=account');
  const open = page.getByRole('button', { name: '修改密码', exact: true });
  await open.click();
  const dialog = page.getByRole('dialog', { name: '修改密码', exact: true });
  let posts = 0;
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      new URL(request.url()).pathname === '/api/auth/change-password'
    )
      posts++;
  });
  await dialog.getByRole('button', { name: '更新密码', exact: true }).click();
  await expect(dialog.getByLabel('当前密码', { exact: true })).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  await expect(dialog.locator('#current-password-error')).toHaveText('请输入当前密码');
  await expect(dialog.locator('#confirm-password-error')).toHaveText('两次输入的新密码不一致');
  expect(posts).toBe(0);
  await dialog.getByLabel('当前密码', { exact: true }).fill('not-a-real-password');
  await dialog.getByLabel('新密码', { exact: true }).fill('Disposable-Unapplied-Password-1!');
  await dialog.getByLabel('确认新密码', { exact: true }).fill('Disposable-Unapplied-Password-1!');
  const rejected = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/auth/change-password' &&
      response.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: '更新密码', exact: true }).click();
  expect((await rejected).ok()).toBe(false);
  await expect(dialog.locator('.ant-alert-error')).toBeVisible();
  await expect(
    page
      .locator('.settings-workspace')
      .filter({ has: page.getByRole('heading', { name: '当前账户', exact: true }) })
      .locator('.ant-alert-error'),
  ).toHaveCount(0);
  expect(posts).toBe(1);
  await page.keyboard.press('Escape');
  await expect(dialog.getByRole('alert').filter({ hasText: '有未保存的更改' })).toBeVisible();
  await dialog.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(dialog.getByLabel('当前密码', { exact: true })).toHaveValue('not-a-real-password');
  await page.keyboard.press('Escape');
  await dialog.getByRole('button', { name: '放弃更改', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(open).toBeFocused();
  await open.click();
  for (const label of ['当前密码', '新密码', '确认新密码'])
    await expect(dialog.getByLabel(label, { exact: true })).toHaveValue('');
  await expect(dialog.locator('.ant-alert-error')).toHaveCount(0);
});

test('恢复密钥验证失败留在弹窗且立即清除密码，重新打开不保留错误', async ({ page }) => {
  await page.goto('/?view=settings&section=backup');
  const open = page.getByRole('button', { name: '下载恢复密钥', exact: true });
  await open.click();
  const dialog = page.getByRole('dialog', { name: '下载恢复密钥', exact: true });
  await dialog.getByRole('button', { name: '验证密码并下载密钥', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('请输入当前密码以下载恢复密钥。');
  await dialog.getByLabel('当前密码', { exact: true }).fill('not-a-real-password');
  const rejected = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/manage/backups/key',
  );
  await dialog.getByRole('button', { name: '验证密码并下载密钥', exact: true }).click();
  expect((await rejected).status()).toBe(403);
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(dialog.getByLabel('当前密码', { exact: true })).toHaveValue('');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(open).toBeFocused();
  await open.click();
  await expect(dialog.getByLabel('当前密码', { exact: true })).toHaveValue('');
  await expect(dialog.getByRole('alert')).toHaveCount(0);
});

test('导入预览与确认步骤不提交任务，最终确认后任务仍可在页面查看', async ({ page }) => {
  await page.goto('/?view=settings&section=library');
  let imports = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/manage/import')
      imports++;
  });
  await page.getByRole('button', { name: '批量导入', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '批量导入', exact: true });
  const name = `overlay-import-${crypto.randomUUID()}.md`;
  await dialog.getByLabel('选择文件', { exact: true }).setInputFiles({
    name,
    mimeType: 'text/markdown',
    buffer: Buffer.from('# Overlay import fixture\n'),
  });
  const previewResponse = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/manage/import/preview',
  );
  await dialog.getByRole('button', { name: '预览导入', exact: true }).click();
  expect((await previewResponse).ok()).toBe(true);
  await expect(dialog.getByRole('heading', { name: '检查导入预览', exact: true })).toBeVisible();
  await expect(dialog.getByRole('row').filter({ hasText: name })).toContainText('新建');
  expect(imports).toBe(0);
  await dialog.getByRole('button', { name: '下一步：确认导入', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: '确认本次导入', exact: true })).toBeVisible();
  await expect(dialog.locator('.transfer-review')).toContainText('00-Inbox');
  expect(imports).toBe(0);
  const submitted = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/manage/import' &&
      response.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: '确认导入 1 个文件', exact: true }).click();
  const response = await submitted;
  expect(response.status()).toBe(202);
  const task = await response.json();
  expect(response.request().postDataJSON()).toMatchObject({
    folderPath: '00-Inbox',
    collision: 'skip',
    requestId: expect.any(String),
    entries: [{ path: name, encoding: 'utf8', content: '# Overlay import fixture\n' }],
  });
  await expect(dialog).toBeHidden();
  expect(imports).toBe(1);
  const tasks = page
    .locator('section.settings-card')
    .filter({ has: page.getByRole('heading', { name: '任务与结果', exact: true }) });
  await expect(tasks).toBeVisible();
  await expect(tasks.getByRole('listitem').filter({ hasText: task.id })).toBeVisible();
  await page.getByRole('button', { name: '批量导入', exact: true }).click();
  await expect(dialog.getByLabel('选择文件', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '预览导入', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(tasks.getByRole('listitem').filter({ hasText: task.id })).toBeVisible();
});

test('上传恢复被明确拒绝时保留两个文件并使用相同请求编号重试', async ({ page }) => {
  const { generateKeyPairSync } = await import('node:crypto');
  const key = generateKeyPairSync('x25519').privateKey.export({ format: 'pem', type: 'pkcs8' });
  await page.goto('/?view=settings&section=backup');
  await page.getByRole('button', { name: '从备份恢复', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '从备份恢复', exact: true });
  await dialog.getByLabel('加密备份（最多 128 MiB）', { exact: true }).setInputFiles({
    name: 'disposable-invalid-backup.dkb',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('disposable invalid backup'),
  });
  await dialog.getByLabel('恢复私钥（最多 16 KiB）', { exact: true }).setInputFiles({
    name: 'disposable-recovery.pem',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from(key),
  });
  await dialog.getByRole('button', { name: '下一步：确认恢复', exact: true }).click();
  // Chromium omits multipart file bodies from Request.postDataBuffer(). Read the
  // actual FormData before passing it unchanged to the browser's native fetch.
  await page.evaluate(() => {
    const originalFetch = window.fetch.bind(window);
    const requestIds: string[] = [];
    (window as typeof window & { restoreRequestIds: string[] }).restoreRequestIds = requestIds;
    window.fetch = (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (
        new URL(url, location.href).pathname === '/api/manage/restores/upload' &&
        init?.body instanceof FormData
      )
        requestIds.push(String(init.body.get('requestId')));
      return originalFetch(input, init);
    };
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    const rejected = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/manage/restores/upload' &&
        response.request().method() === 'POST',
    );
    await dialog.getByRole('button', { name: '上传并恢复独立副本', exact: true }).click();
    const response = await rejected;
    expect(response.status()).toBe(400);
    await expect(
      dialog.getByRole('alert').filter({ hasText: '仅支持 DooKnow 加密备份' }),
    ).toBeVisible();
    await expect(dialog.getByRole('region', { name: '恢复摘要', exact: true })).toContainText(
      'disposable-invalid-backup.dkb',
    );
    await dialog.getByRole('button', { name: '上一步', exact: true }).click();
    for (const [selector, filename] of [
      ['#restore-backup-file', 'disposable-invalid-backup.dkb'],
      ['#restore-key-file', 'disposable-recovery.pem'],
    ])
      expect(
        await dialog
          .locator(selector)
          .evaluate((input: HTMLInputElement) => input.files?.[0]?.name),
      ).toBe(filename);
    await dialog.getByRole('button', { name: '下一步：确认恢复', exact: true }).click();
  }
  const requestIds = await page.evaluate(
    () => (window as typeof window & { restoreRequestIds: string[] }).restoreRequestIds,
  );
  expect(requestIds).toHaveLength(2);
  expect(requestIds[0]).toMatch(/^[a-f0-9-]{36}$/);
  expect(requestIds[1]).toBe(requestIds[0]);
});

test('Git 连接草稿在取消凭据编辑后保留，凭据秘密不会再次出现', async ({ page }) => {
  await page.goto('/?view=settings&section=library');
  const panel = page.getByRole('region', { name: '云端同步面板', exact: true });
  await panel.getByRole('button', { name: /^(管理同步|关联云端仓库)$/ }).click();
  const connection = page.getByRole('dialog', { name: '管理云端同步', exact: true });
  await connection
    .getByLabel('仓库克隆地址', { exact: true })
    .fill('https://github.com/disposable-fixture/overlay.git');
  await connection.getByLabel('云端分支（选填）', { exact: true }).fill('overlay-draft');
  let mutations = 0;
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      /\/api\/platform\/git\/(credentials|jobs)$/.test(new URL(request.url()).pathname)
    )
      mutations++;
  });
  await connection.getByRole('button', { name: '添加凭据', exact: true }).click();
  const credential = page.getByRole('dialog', { name: '添加凭据', exact: true });
  await credential.getByLabel('凭据名称', { exact: true }).fill('Unsaved overlay fixture');
  await credential.getByLabel('访问令牌', { exact: true }).fill('disposable-not-a-real-secret');
  await credential.getByRole('button', { name: '取消编辑凭据', exact: true }).click();
  await credential.getByRole('button', { name: '放弃修改', exact: true }).click();
  await expect(connection).toBeVisible();
  await expect(connection.getByLabel('仓库克隆地址', { exact: true })).toHaveValue(
    'https://github.com/disposable-fixture/overlay.git',
  );
  await expect(connection.getByLabel('云端分支（选填）', { exact: true })).toHaveValue(
    'overlay-draft',
  );
  await expect(page.getByLabel('访问令牌', { exact: true })).toHaveCount(0);
  await connection.getByRole('button', { name: '添加凭据', exact: true }).click();
  await expect(credential.getByLabel('访问令牌', { exact: true })).toHaveValue('');
  await credential.getByRole('button', { name: '取消编辑凭据', exact: true }).click();
  await expect(connection).toBeVisible();
  expect(mutations).toBe(0);
});

test('窄且低的深色视窗保留弹窗边界、可滚动内容与清晰文字', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 460 });
  await page.goto('/?view=settings&section=account');
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.getByRole('button', { name: '修改密码', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '修改密码', exact: true });
  await expect(dialog).toBeVisible();
  const box = (await dialog.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(361);
  expect(box.y + box.height).toBeLessThanOrEqual(461);
  await expect(dialog.getByRole('button', { name: '更新密码', exact: true })).toBeInViewport();
  const mutedColor = await dialog
    .locator('.settings-overlay-heading p')
    .evaluate((element) => getComputedStyle(element).color);
  expect(mutedColor).not.toMatch(/^rgba?\(0,\s*0,\s*0(?:,|\))/);
  const passwordIcons = dialog.locator('.ant-input-password-icon');
  await expect(passwordIcons).toHaveCount(3);
  for (const icon of await passwordIcons.all()) await expect(icon).toHaveCSS('color', mutedColor);
  const layout = await dialog.evaluate((element) => {
    const body = element.querySelector('.settings-overlay-body') as HTMLElement;
    const labels = Array.from(
      element.querySelectorAll(
        'h2, label, .settings-overlay-heading p, button.ant-btn-primary, input',
      ),
    );
    const rgb = (color: string) => color.match(/[\d.]+/g)!.map(Number);
    const luminance = (color: string) => {
      const [r, g, b] = rgb(color)
        .slice(0, 3)
        .map((n) => {
          const value = n / 255;
          return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    return {
      scrollable:
        body.scrollHeight > body.clientHeight && getComputedStyle(body).overflowY === 'auto',
      contrasts: labels.map((node) => {
        let parent: Element | null = node;
        let background = '';
        while (parent) {
          background = getComputedStyle(parent).backgroundColor;
          const channels = rgb(background);
          if (channels.length < 4 || channels[3] > 0) break;
          parent = parent.parentElement;
        }
        const foreground = luminance(getComputedStyle(node).color),
          back = luminance(background);
        return {
          tag: node.tagName,
          ratio: (Math.max(foreground, back) + 0.05) / (Math.min(foreground, back) + 0.05),
        };
      }),
    };
  });
  expect(layout.scrollable).toBe(true);
  for (const item of layout.contrasts)
    expect(item.ratio, `${item.tag} dark contrast`).toBeGreaterThanOrEqual(4.5);
  await dialog.getByLabel('确认新密码', { exact: true }).scrollIntoViewIfNeeded();
  await expect(dialog.getByLabel('确认新密码', { exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('工作区 Git 返回保存仅确认一次，取消保留凭据草稿，放弃后回到未保存笔记', async ({ page }) => {
  const { configurePlugin, returnToNotes, showSidebar } =
    await import('../support/settings-navigation');
  await page.goto('/');
  await configurePlugin(page, 'Git 版本管理');
  const enable = page
    .locator('.plugin-settings')
    .getByRole('button', { name: '启用插件', exact: true });
  if (await enable.isVisible()) await enable.click();
  await returnToNotes(page);
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const original = '# Return to save fixture\n';
  const response = await page.request.post('/api/notes', {
    headers: { origin: new URL(page.url()).origin, 'x-csrf-token': csrf.token },
    data: {
      folderPath: '00-Inbox',
      fileName: `overlay-return-${crypto.randomUUID()}.md`,
      content: original,
      requestId: crypto.randomUUID(),
    },
  });
  expect(response.status()).toBe(201);
  const note = await response.json();
  await page.goto('/?note=' + note.id);
  await page.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
  const editor = page.locator('.cm-content');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('Unapplied note draft');
  await showSidebar(page);
  await page.getByRole('button', { name: '云端同步', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '云端同步', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: /^(管理同步|关联云端仓库)$/ }).click();
  await dialog
    .getByLabel('仓库克隆地址', { exact: true })
    .fill('https://github.com/disposable-fixture/return-save.git');
  await dialog.getByLabel('云端分支（选填）', { exact: true }).fill('return-save-draft');
  await dialog.getByRole('button', { name: '添加凭据', exact: true }).click();
  const token = dialog.getByLabel('访问令牌', { exact: true });
  await token.fill('disposable-unsaved-token');
  const returnSave = dialog.getByRole('button', { name: '返回笔记保存', exact: true });
  await returnSave.click();
  const prompt = dialog.getByRole('alert').filter({ hasText: '有尚未保存的修改，确定放弃吗？' });
  await expect(prompt).toHaveCount(1);
  await expect(prompt).toBeVisible();
  await expect(dialog.locator('.settings-discard-prompt')).toHaveCount(0);
  await prompt.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(token).toHaveValue('disposable-unsaved-token');
  // Preserve an already-open parent discard prompt while the child workflow
  // confirms its own draft cleanup and requests return to the note.
  await dialog.getByRole('button', { name: '关闭云端同步', exact: true }).click();
  await expect(dialog.locator('.settings-discard-prompt')).toBeVisible();
  await returnSave.click();
  await expect(prompt).toBeVisible();
  await prompt.getByRole('button', { name: '放弃修改', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('有未保存的更改', { exact: true })).toHaveCount(0);
  await expect(editor).toBeVisible();
  await expect(editor).toContainText('Unapplied note draft');
  await expect(page).toHaveURL(new RegExp('note=' + note.id));
  expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).toBe(original);
});
