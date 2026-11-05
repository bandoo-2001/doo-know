import { test as base, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

type Slot = {
  id: string;
  libraryParent: string;
  gitRemoteURL: string;
  api: (path: string, method?: string, data?: unknown) => Promise<any>;
};
const test = base.extend<{ slot: Slot; setupMode: string }>({
  setupMode: ['empty', { option: true }],
  slot: async ({ page, context, request, setupMode }, use) => {
    const config = JSON.parse(await readFile('.local/setup-feedback-config.json', 'utf8'));
    const controlHeaders = {
      authorization: 'Bearer ' + config.controlToken,
      origin: config.origin,
    };
    const allocated = await request.post(config.controlPath, {
      headers: controlHeaders,
      data: { mode: setupMode },
    });
    expect(allocated.status()).toBe(201);
    const value = await allocated.json();
    await context.setExtraHTTPHeaders(value.headers);
    await context.addCookies(value.cookies);
    const csrf = await (await page.request.get('/api/security/csrf')).json();
    const api = async (path: string, method = 'GET', data?: unknown) => {
      const response = await page.request.fetch(path, {
        method,
        data,
        headers: { origin: config.origin, 'x-csrf-token': csrf.token },
      });
      expect(response.ok(), path + ':' + response.status()).toBe(true);
      return response.status() === 204 ? null : response.json();
    };
    try {
      await use({ ...value, api });
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      const closed = await request.delete(config.controlPath + '/' + value.id, {
        headers: controlHeaders,
      });
      expect(closed.ok()).toBe(true);
    }
  },
});
const button = (page: Page, text: string) => page.getByRole('button', { name: text, exact: true });
async function source(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '准备你的知识库', exact: true })).toBeVisible();
}
async function remote(page: Page, slot: Slot, name: string) {
  await source(page);
  await button(page, '从 GitHub／Gitee 导入').click();
  await page.getByLabel('仓库克隆地址', { exact: true }).fill(slot.gitRemoteURL);
  await page.getByLabel('导入后的知识库名称', { exact: true }).fill(name);
  await page.getByLabel('导入保存位置（选填）', { exact: true }).fill(slot.libraryParent);
}
async function features(page: Page, slot: Slot) {
  await source(page);
  await page.getByText('高级设置', { exact: true }).click();
  await page.getByLabel('保存到哪个文件夹', { exact: true }).fill(slot.libraryParent);
  await page.getByLabel('知识库名称', { exact: true }).fill('feedback-' + randomUUID().slice(0, 8));
  await button(page, '确认并继续').click();
  await expect(page.getByRole('heading', { name: '选择需要的功能', exact: true })).toBeVisible();
}
async function ready(page: Page, slot: Slot) {
  await features(page, slot);
  await button(page, '暂时跳过').click();
  await expect(page.getByRole('heading', { name: '知识库准备好了', exact: true })).toBeVisible();
}
async function visibleFeedback(page: Page, target: ReturnType<Page['locator']>) {
  await expect(target).toBeVisible();
  let metrics: unknown;
  try {
    await expect
      .poll(
        async () =>
          (metrics = await target.evaluate((element) => {
            const box = element.getBoundingClientRect();
            return {
              inViewport: box.top >= 0 && box.bottom <= innerHeight,
              focused:
                element === document.activeElement || element.contains(document.activeElement),
              top: Math.round(box.top),
              bottom: Math.round(box.bottom),
              active:
                document.activeElement?.getAttribute('aria-label') ||
                document.activeElement?.tagName,
              tabIndex: (element as HTMLElement).tabIndex,
            };
          })),
      )
      .toMatchObject({ inViewport: true, focused: true });
  } catch (error) {
    await test.info().attach('feedback-viewport.json', {
      body: JSON.stringify(metrics),
      contentType: 'application/json',
    });
    await page.screenshot({ path: test.info().outputPath('feedback-failure.png') });
    throw error;
  }
}

test('Git rejection becomes visible and focused from the bottom of the actual long import form', async ({
  page,
  slot,
}, info) => {
  await remote(page, slot, 'personal');
  await button(page, '导入并继续').click();
  const feedback = page
    .locator('.git-remote-panel [role="alert"]')
    .filter({ hasText: '目标文件夹已经存在' });
  await visibleFeedback(page, feedback);
  await page.screenshot({ path: info.outputPath('git-rejection.png'), fullPage: false });
});

test.describe('accepted clone receipt', () => {
  test.use({ setupMode: 'git-delayed' });
  test('lost response offers the actual reconcile CTA without issuing another clone', async ({
    page,
    slot,
  }, info) => {
    let posts = 0;
    await remote(page, slot, 'unknown-' + randomUUID().slice(0, 8));
    await page.route('**/api/platform/git/jobs', async (route) => {
      if (route.request().method() === 'POST') {
        posts++;
        await route.fetch();
        await route.abort('failed');
      } else await route.continue();
    });
    await button(page, '导入并继续').click();
    const feedback = page.locator('.remote-job').filter({ hasText: '请求结果尚未确认' });
    await visibleFeedback(page, feedback);
    const reconcile = button(page, '核对导入结果');
    await expect(reconcile).toBeVisible();
    await page.screenshot({ path: info.outputPath('unknown-receipt.png'), fullPage: false });
    await reconcile.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('unknown-receipt-action.png'), fullPage: false });
    await reconcile.click();
    await expect(button(page, '取消当前任务')).toBeVisible();
    expect(posts).toBe(1);
  });
  test('resumed clone shows its real receipt identity and makes missing source details explicit', async ({
    page,
    slot,
  }, info) => {
    await remote(page, slot, 'resumed-' + randomUUID().slice(0, 8));
    await button(page, '导入并继续').click();
    await expect(button(page, '取消当前任务')).toBeVisible();
    const before = await slot.api('/api/platform/git/status'),
      accepted = before.jobs.find((job: any) => job.kind === 'clone');
    expect(accepted).toBeTruthy();
    await page.reload();
    await button(page, '从 GitHub／Gitee 导入').click();
    await expect(button(page, '取消当前任务')).toBeVisible();
    const receipt = page.locator('.remote-job[role="status"]');
    await expect(receipt).toContainText(accepted.id);
    await visibleFeedback(page, receipt);
    await expect(page.locator('.git-remote-panel')).toContainText(
      '仓库地址和知识库名称未包含在任务回执中',
    );
    await expect(page.getByLabel('导入后的知识库名称', { exact: true })).toHaveCount(0);
    const after = await slot.api('/api/platform/git/status');
    expect(after.jobs.find((job: any) => job.id === accepted.id)?.status).toMatch(
      /^(queued|running)$/,
    );
    await page.screenshot({ path: info.outputPath('resumed-clone.png'), fullPage: false });
  });
});

test('failed optional registry blocks unsupported installs and recovers only after a real successful retry', async ({
  page,
  slot,
}, info) => {
  let fail = true,
    installs = 0;
  await page.route('**/api/platform/plugins', (route) =>
    fail ? route.abort('failed') : route.continue(),
  );
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      new URL(request.url()).pathname === '/api/platform/plugin-installations'
    )
      installs++;
  });
  await features(page, slot);
  await expect(page.getByRole('alert')).toContainText('暂时无法读取可选功能');
  await expect(button(page, '添加连接设置')).toBeDisabled();
  await expect(button(page, '添加版本记录')).toBeDisabled();
  await expect(page.locator('.feature-state').filter({ hasText: '尚未确认可用性' })).toHaveCount(2);
  await expect(page.getByText('暂未提供此功能，可以稍后再设置', { exact: true })).toHaveCount(0);
  await expect(button(page, '暂时跳过')).toBeEnabled();
  expect(installs).toBe(0);
  await page.screenshot({ path: info.outputPath('registry-unavailable.png'), fullPage: false });
  fail = false;
  await button(page, '重新读取可选功能').click();
  await expect(button(page, '添加连接设置')).toBeEnabled();
  expect(installs).toBe(0);
});

test('file receipt distinguishes one-byte-over-limit and tiny nonempty files, and only the selected finish action spins', async ({
  page,
  slot,
}, info) => {
  await ready(page, slot);
  await page.getByText('导入已有资料', { exact: true }).click();
  const input = page.getByLabel('选择 Markdown 文件', { exact: true });
  await input.setInputFiles({
    name: 'one-over.md',
    mimeType: 'text/markdown',
    buffer: Buffer.alloc(262145, 65),
  });
  await button(page, '确认导入').click();
  await expect(page.locator('.setup-import [role="alert"]')).toContainText('256 KiB');
  await expect(page.locator('.import-selection')).toContainText('262145 字节');
  await page.locator('.setup-import').scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('one-byte-over-limit.png'), fullPage: false });
  await input.setInputFiles({
    name: 'tiny.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# hi\n'),
  });
  await expect(page.locator('.import-selection')).toContainText('5 字节');
  await page.screenshot({ path: info.outputPath('tiny-file.png'), fullPage: false });
  let release!: () => void;
  const held = new Promise<void>((done) => {
    release = done;
  });
  await page.route('**/api/platform/setup/finish', async (route) => {
    await held;
    await route.continue().catch(() => {});
  });
  try {
    await button(page, '进入工作区').click();
    const actions = page.locator('.start-actions');
    await expect(actions.locator('button:disabled')).toHaveCount(2);
    await expect(
      actions.locator('button').filter({ hasText: '进入工作区' }).locator('.ant-btn-loading-icon'),
    ).toBeVisible();
    await expect(
      actions
        .locator('button')
        .filter({ hasText: '创建第一篇笔记' })
        .locator('.ant-btn-loading-icon'),
    ).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('finish-and-file-size.png'), fullPage: false });
  } finally {
    release();
  }
});

test.describe('unavailable source presentation', () => {
  test.use({ setupMode: 'source-unavailable' });
  test('the real unavailable-source state retains its primary recheck action', async ({
    page,
    slot,
  }, info) => {
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: '暂时无法打开知识库', exact: true }),
    ).toBeVisible();
    await expect(button(page, '重新检查')).toBeEnabled();
    const before = await slot.api('/api/platform/status');
    expect(before.phase).toMatch(/^(source_unavailable|configuration_error)$/);
    await page.screenshot({
      path: info.outputPath('unavailable-source-primary.png'),
      fullPage: false,
    });
    await button(page, '重新检查').click();
    const after = await slot.api('/api/platform/status');
    expect(after.phase).toBe(before.phase);
  });
});

function responseGate() {
  let release!: () => void;
  const pending = new Promise<void>((done) => {
    release = done;
  });
  return { pending, release };
}
async function credentialDialog(page: Page) {
  await button(page, '添加凭据').click();
  const dialog = page.getByRole('dialog', { name: '添加凭据', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('凭据名称', { exact: true })).toBeFocused();
  return dialog;
}
for (const kind of ['save', 'ssh'] as const) {
  test(
    'import credential ' +
      kind +
      ' errors stay in the current modal without scrolling its background',
    async ({ page, slot }, info) => {
      await remote(page, slot, 'modal-' + randomUUID().slice(0, 8));
      const dialog = await credentialDialog(page);
      await dialog.getByLabel('凭据名称', { exact: true }).fill('Disposable credential draft');
      if (kind === 'save') {
        await dialog.getByLabel('仓库用户名', { exact: true }).fill('fixture-user');
        await dialog
          .getByLabel('访问令牌', { exact: true })
          .fill('Disposable-Fixture-Not-A-Real-Token');
        await page.route('**/api/platform/git/credentials', (route) =>
          route.request().method() === 'POST'
            ? route.fulfill({ status: 503, json: { code: 'GIT_NETWORK_FAILED' } })
            : route.continue(),
        );
      } else {
        await dialog.getByLabel('认证方式', { exact: true }).selectOption('ssh');
        await dialog
          .getByLabel('SSH 私钥', { exact: true })
          .fill('Disposable fixture draft, not an SSH key');
        await page.route('**/api/platform/git/jobs', (route) =>
          route.request().method() === 'POST'
            ? route.fulfill({ status: 503, json: { code: 'GIT_NETWORK_FAILED' } })
            : route.continue(),
        );
      }
      const submit = dialog.getByRole('button', {
        name: kind === 'save' ? '保存仓库凭据' : '读取 SSH 主机指纹',
        exact: true,
      });
      await submit.scrollIntoViewIfNeeded();
      const scroll = await page.evaluate(() => scrollY);
      await submit.click();
      const feedback = dialog.getByRole('alert').filter({ hasText: '网络连接失败' });
      await expect(feedback).toBeVisible();
      await expect
        .poll(() =>
          feedback.evaluate(
            (element) =>
              element === document.activeElement || element.contains(document.activeElement),
          ),
        )
        .toBe(true);
      expect(await page.evaluate(() => scrollY)).toBe(scroll);
      await expect(dialog.getByLabel('凭据名称', { exact: true })).toHaveValue(
        'Disposable credential draft',
      );
      await expect(
        dialog.getByLabel(kind === 'save' ? '访问令牌' : 'SSH 私钥', { exact: true }),
      ).toHaveValue(
        kind === 'save'
          ? 'Disposable-Fixture-Not-A-Real-Token'
          : 'Disposable fixture draft, not an SSH key',
      );
      await page.screenshot({
        path: info.outputPath('credential-' + kind + '-error.png'),
        mask: [page.locator('input[type=password],textarea[aria-label="SSH 私钥"]')],
      });
    },
  );
}

test('delayed background status failure cannot reset an active credential input or scroll the page', async ({
  page,
  slot,
}, info) => {
  const gate = responseGate();
  let seen!: () => void;
  const requested = new Promise<void>((done) => {
    seen = done;
  });
  await source(page);
  await page.route(
    '**/api/platform/git/status',
    async (route) => {
      seen();
      await gate.pending;
      await route.fulfill({ status: 503, json: { code: 'SOURCE_UNAVAILABLE' } });
    },
    { times: 1 },
  );
  try {
    await button(page, '从 GitHub／Gitee 导入').click();
    await requested;
    const dialog = await credentialDialog(page);
    const field = dialog.getByLabel('仓库用户名', { exact: true });
    await field.fill('user-keeps-editing');
    await expect(field).toBeFocused();
    const scroll = await page.evaluate(() => scrollY);
    gate.release();
    await expect(dialog.getByRole('alert')).toContainText('原文目录暂时不可用');
    await expect(field).toBeFocused();
    expect(await page.evaluate(() => scrollY)).toBe(scroll);
    await expect(field).toHaveValue('user-keeps-editing');
    await page.screenshot({ path: info.outputPath('background-error-active-modal.png') });
  } finally {
    gate.release();
  }
});

test('real expired owner session keeps the global reauthentication modal focused above import feedback', async ({
  page,
  slot,
}, info) => {
  await remote(page, slot, 'expired-' + randomUUID().slice(0, 8));
  const action = button(page, '测试读取连接');
  await action.scrollIntoViewIfNeeded();
  const scroll = await page.evaluate(() => scrollY);
  await page.context().clearCookies();
  await action.click();
  await expect(page.getByRole('heading', { name: '登录已失效', exact: true })).toBeVisible();
  const password = page.getByLabel('密码', { exact: true });
  await password.focus();
  await expect(password).toBeFocused();
  expect(await page.evaluate(() => scrollY)).toBe(scroll);
  await page.screenshot({
    path: info.outputPath('global-auth-modal.png'),
    mask: [page.locator('input[type=password]')],
  });
});

test('finish locks selected import without a second write and a failed finish preserves the file for later import', async ({
  page,
  slot,
}, info) => {
  await ready(page, slot);
  await page.getByText('导入已有资料', { exact: true }).click();
  const name = 'retained-' + randomUUID() + '.md',
    content = '# Retained after failed finish\n';
  const input = page.getByLabel('选择 Markdown 文件', { exact: true });
  await input.setInputFiles({ name, mimeType: 'text/markdown', buffer: Buffer.from(content) });
  const gate = responseGate();
  let notes = 0,
    folders = 0,
    finishes = 0;
  page.on('request', (request) => {
    if (request.method() !== 'POST') return;
    const path = new URL(request.url()).pathname;
    if (path === '/api/notes') notes++;
    if (path === '/api/folders') folders++;
    if (path === '/api/platform/setup/finish') finishes++;
  });
  await page.route('**/api/platform/setup/finish', async (route) => {
    await gate.pending;
    await route.fulfill({ status: 503, json: { code: 'SOURCE_UNAVAILABLE' } });
  });
  try {
    await button(page, '进入工作区').click();
    await expect(page.locator('.start-actions button:disabled')).toHaveCount(2);
    await expect(input).toBeDisabled();
    await expect(button(page, '确认导入')).toBeDisabled();
    expect(notes).toBe(0);
    expect(folders).toBe(0);
    expect(finishes).toBe(1);
    await page.screenshot({ path: info.outputPath('finish-locks-import.png') });
    await page.locator('.setup-import').scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('finish-locks-import-controls.png') });
    gate.release();
    await expect(page.locator('.setup-error')).toBeVisible();
    await expect(input).toBeEnabled();
    await expect(button(page, '确认导入')).toBeEnabled();
    expect(await input.evaluate((element: HTMLInputElement) => element.files?.[0].name)).toBe(name);
    await button(page, '确认导入').click();
    await expect(page.locator('.setup-import [role=status]')).toContainText(name + ' 已导入');
    expect(notes).toBe(1);
    expect(finishes).toBe(1);
    const current = await slot.api('/api/platform/status');
    expect(await readFile(current.knowledgeRoot + '/40-Resources/' + name, 'utf8')).toBe(content);
    await page.screenshot({ path: info.outputPath('import-after-finish-failure.png') });
  } finally {
    gate.release();
  }
});

test('an accepted import locks both finish intents until its real result is received', async ({
  page,
  slot,
}, info) => {
  await ready(page, slot);
  await page.getByText('导入已有资料', { exact: true }).click();
  const name = 'import-first-' + randomUUID() + '.md',
    content = '# Import completes before leaving\n';
  await page
    .getByLabel('选择 Markdown 文件', { exact: true })
    .setInputFiles({ name, mimeType: 'text/markdown', buffer: Buffer.from(content) });
  const gate = responseGate();
  let seen!: () => void;
  const requested = new Promise<void>((done) => {
    seen = done;
  });
  let notes = 0,
    finishes = 0;
  page.on('request', (request) => {
    if (request.method() !== 'POST') return;
    const path = new URL(request.url()).pathname;
    if (path === '/api/notes') notes++;
    if (path === '/api/platform/setup/finish') finishes++;
  });
  await page.route('**/api/notes', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    seen();
    await gate.pending;
    await route.continue();
  });
  try {
    await button(page, '确认导入').click();
    await requested;
    await expect(page.locator('.start-actions button:disabled')).toHaveCount(2);
    await expect(button(page, '上一步')).toBeDisabled();
    expect(notes).toBe(1);
    expect(finishes).toBe(0);
    await page.screenshot({ path: info.outputPath('import-locks-finish.png') });
    gate.release();
    await expect(page.locator('.setup-import [role=status]')).toContainText(name + ' 已导入');
    await expect(button(page, '进入工作区')).toBeEnabled();
    const current = await slot.api('/api/platform/status');
    expect(await readFile(current.knowledgeRoot + '/40-Resources/' + name, 'utf8')).toBe(content);
    await button(page, '进入工作区').click();
    await expect(page.locator('.workspace')).toBeVisible();
    expect(finishes).toBe(1);
    expect(notes).toBe(1);
  } finally {
    gate.release();
  }
});
