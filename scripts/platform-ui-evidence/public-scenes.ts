import { expect, type Page } from '@playwright/test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { testPassword } from '../../tests/support/credentials';
import type { Fixture, Scene, SceneEnv } from './model';
import { registerSceneCleanup } from './lifecycle';

// Recipes only. No browser/server is created when this module is imported.
// All note/post mutations are UUID data in the capture driver's guarded fixture.
type Data = { note?: any; post?: any; share?: any; title?: string; release?: () => void; [key: string]: any };
const data = new WeakMap<Page, Data>();
const routes = new WeakMap<Fixture, Map<string, string>>();
const state = (env: SceneEnv) => data.get(env.page)!;
const btn = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const inventory = (id: string, ...values: string[]) => ({ [id]: values });
const articlePath = '/?view=apps&app=blog&appSection=articles';
const studioPath = '/?view=apps&app=blog&appSection=design';
const rememberRoute = (env: SceneEnv, id: string, route: string) => {
  if (!routes.has(env.fixture)) routes.set(env.fixture, new Map());
  routes.get(env.fixture)!.set(id, route);
};
const pathFor = (id: string) => (fixture: Fixture) => {
  const route = routes.get(fixture)?.get(id);
  if (!route) throw Error('Missing independently prepared route for ' + id);
  return route;
};
async function createNote(env: SceneEnv, content?: string) {
  const marker = randomUUID(), title = '公开运行取证 ' + marker.slice(0, 8);
  const note = await env.fixture.api('/api/notes', 'POST', { folderPath: '00-Inbox', fileName: 'public-capture-' + marker + '.md',
    content: content ?? '# ' + title + '\n\n独立隔离资料。\n\n## 章节\n\n```js\nconsole.log("capture");\n```\n', requestId: randomUUID() });
  data.set(env.page, { note, title });
  return note;
}
async function createArticle(env: SceneEnv, published = false, content?: string) {
  const note = await createNote(env, content), local = state(env);
  const metadata = { title: local.title, slug: 'capture-' + randomUUID().slice(0, 8), summary: '仅用于真实运行界面核验。', category: '运行取证', tags: ['隔离资料'] };
  const contentValue = (await env.fixture.api('/api/notes/' + note.id)).content;
  const value = published
    ? await env.fixture.api('/api/blog/publish', 'POST', { noteId: note.id, expectedModifiedAt: note.modifiedAt,
      expectedContentHash: createHash('sha256').update(contentValue).digest('hex'), expectedPublicationVersion: 0, metadata, requestId: randomUUID() })
    : await env.fixture.api('/api/blog/posts', 'POST', { sourceNoteId: note.id, metadata, requestId: randomUUID() });
  local.post = value.post ?? value;
  return local.post;
}
async function createShare(env: SceneEnv, id: string, permission: 'view' | 'edit' = 'view', content?: string) {
  const note = await createNote(env, content);
  const share = await env.fixture.api('/api/notes/' + note.id + '/share', 'POST', { permission, expiresAt: null, allowDiagramSource: false });
  state(env).share = share;
  rememberRoute(env, id, new URL(share.url, env.fixture.origin).pathname);
}
async function selectArticle(env: SceneEnv) {
  await env.page.locator('.blog-post-option').filter({ hasText: state(env).title! }).click();
  await expect(env.page.getByLabel('文章标题', { exact: true })).toHaveValue(state(env).title!);
}
async function loginOwner(page: Page) {
  await page.getByLabel('用户名', { exact: true }).fill('owner');
  await page.getByLabel('密码', { exact: true }).fill(testPassword);
  await btn(page, '登录').click();
}
function gate(page: Page) {
  let release!: () => void;
  const pending = new Promise<void>(done => { release = done; });
  registerSceneCleanup(page, release);
  return { pending, release };
}
async function hold(env: SceneEnv, pattern: string | RegExp) {
  const held = gate(env.page);
  await env.page.route(pattern, async route => { await held.pending; await route.continue().catch(() => undefined); });
  data.set(env.page, { ...(data.get(env.page) ?? {}), release: held.release });
}
async function release(env: SceneEnv) { state(env)?.release?.(); }
const chunk = (name: string) => new RegExp('/(?:(?:apps/web/)?components/' + name + '\\.vue(?:\\?|$)|assets/' + name + '-[^/]+\\.js(?:\\?|$))');
const startup = (scene: Scene): Scene => ({ ...scene, readiness: 'target' });
const articleScene = (id: string, sourceIds: string[], title: string, open: NonNullable<Scene['open']>, options: Partial<Scene> & { published?: boolean; content?: string } = {}): Scene => {
  const { published, content, before, ...rest } = options;
  return { id, sourceIds, title, state: title, role: 'owner', path: articlePath, target: '.blog-article-detail',
    tests: ['tests/e2e/blog-polish.spec.ts', 'tests/e2e/blog.spec.ts'],
    before: async env => { await createArticle(env, published, content); await before?.(env); },
    open: async env => { await selectArticle(env); await open(env); }, ...rest };
};
async function guestSource(env: SceneEnv) {
  await btn(env.page, '编辑笔记').click();
  await btn(env.page, 'Markdown 源码').click();
  await expect(env.page.locator('.public-share-editor .cm-content')).toBeVisible();
}
async function crop(env: SceneEnv) {
  const details = env.page.locator('.blog-secondary-fields');
  if (!(await details.evaluate((element: HTMLDetailsElement) => element.open))) await details.locator('summary').click();
  const base64 = await env.page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 480; canvas.height = 300;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#4566c6'; context.fillRect(0, 0, 480, 300);
    context.fillStyle = '#e6e9f1'; context.fillRect(30, 40, 170, 210);
    context.fillStyle = '#272b3a'; context.fillRect(250, 60, 190, 150);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await env.page.getByLabel('选择上传并裁切封面图片', { exact: true }).setInputFiles({ name: 'capture-' + randomUUID() + '.png', mimeType: 'image/png', buffer: Buffer.from(base64, 'base64') });
  const region = env.page.getByRole('region', { name: '上传并裁切封面图片裁切', exact: true });
  await expect(region).toBeVisible();
  await expect.poll(() => region.getByAltText('裁切预览').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(480);
  for (const [label, value] of [['缩放', '3'], ['水平位置', '100'], ['垂直位置', '100']]) { const slider = region.getByLabel(label, { exact: true }); await slider.focus(); await slider.press('End'); await expect(slider).toHaveValue(value); }
}
async function oauth(env: SceneEnv, id: string, scope = 'knowledge:read offline_access') {
  const response = await env.fixture.api('/api/auth/oauth2/register', 'POST', { client_name: '独立授权取证 ' + randomUUID().slice(0, 8),
    redirect_uris: ['https://runtime.invalid/callback'], token_endpoint_auth_method: 'none', scope });
  const path = '/api/auth/oauth2/authorize?' + new URLSearchParams({ client_id: response.client_id, redirect_uri: 'https://runtime.invalid/callback',
    response_type: 'code', scope, resource: env.fixture.origin + '/mcp', state: randomUUID(), code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url') });
  rememberRoute(env, id, path);
}

export const publicScenes: Scene[] = [
  {
    id: 'public-reauth-retained-draft', sourceIds: ['PB-003'], title: '真实401后的紧凑重认证与保留草稿', state: 'Dirty owner save receives401 after browser cookie removal', role: 'owner',
    path: pathFor('public-reauth-retained-draft'), target: '.dialog-card', window: true, representative: true,
    before: async env => { await createNote(env); rememberRoute(env, 'public-reauth-retained-draft', '/?note=' + state(env).note.id); },
    open: async env => {
      await env.page.locator('.cm-content').fill('# 重认证仍保留的UUID草稿 ' + randomUUID());
      await env.context.clearCookies(); await btn(env.page, '保存').click();
      await expect(env.page.getByRole('heading', { name: '登录已失效', exact: true })).toBeVisible();
      await expect(env.page.locator('.cm-content')).toContainText('重认证仍保留');
    },
    afterCapture: async env => { await loginOwner(env.page); await expect(env.page.locator('.login-page.compact')).toHaveCount(0); await expect(env.page.locator('.cm-content')).toContainText('重认证仍保留'); return { sameOwnerDraftRetained: true }; },
    importantStates: inventory('PB-003', 'compact login with retained workspace/draft'), tests: ['tests/e2e/platform-bootstrap.spec.ts', 'tests/e2e/workspace.spec.ts'],
  },
  {
    id: 'public-reauth-signin-error', sourceIds: ['PB-003'], title: '重认证提交忙与实际错误密码', state: 'Real wrong-password sign-in is observed pending then rejected', role: 'owner', path: pathFor('public-reauth-signin-error'), target: '.dialog-card', window: true,
    before: async env => { await createNote(env); rememberRoute(env, 'public-reauth-signin-error', '/?note=' + state(env).note.id); },
    open: async env => { await env.page.locator('.cm-content').fill('# 错误密码期间保留草稿 ' + randomUUID()); await env.context.clearCookies(); await btn(env.page, '保存').click(); await expect(env.page.getByRole('heading', { name: '登录已失效', exact: true })).toBeVisible(); await hold(env, '**/api/auth/sign-in/username'); await env.page.getByLabel('用户名', { exact: true }).fill('owner'); await env.page.getByLabel('密码', { exact: true }).fill('Wrong-Fixture-Password-' + randomUUID()); await btn(env.page, '登录').click(); await expect(env.page.getByLabel('用户名', { exact: true })).toBeDisabled(); await release(env); await expect(env.page.locator('.login-error')).toBeVisible(); await expect(env.page.locator('.cm-content')).toContainText('错误密码期间保留草稿'); },
    importantStates: inventory('PB-003', 'busy and sign-in error'), fault: 'Hold real wrong-password authentication request, then continue to actual server rejection.', tests: ['tests/e2e/platform-bootstrap.spec.ts'] },
  startup({ id: 'public-initial-session-loading', sourceIds: ['PB-004'], title: '实际会话请求挂起的启动反馈', state: 'Owner session fetch held before initial acceptance', role: 'owner', path: '/', target: '[role="status"][aria-label="正在打开知识空间…"]',
    before: env => hold(env, '**/api/auth/get-session'), afterCapture: release,
    importantStates: inventory('PB-004', 'page loading knowledge space'), fault: 'Hold only actual initial GET /api/auth/get-session; release after capture.', tests: ['tests/e2e/motion-loading.spec.ts'] }),
  startup({ id: 'public-login-chunk-loading', sourceIds: ['PB-004'], title: '实际登录模块加载反馈', state: 'Anonymous Login import request held', role: 'anonymous', path: '/', target: '[role="status"][aria-label="正在加载登录…"]',
    before: env => hold(env, chunk('Login')), afterCapture: release,
    importantStates: inventory('PB-004', 'inline/page loading login depending compact'), fault: 'Hold actual Login module request; no renderer DOM is injected.', tests: ['tests/e2e/motion-loading.spec.ts'] }),
  startup({ id: 'public-platform-loading-after-login', sourceIds: ['PB-004'], title: '登录后实际知识库状态加载', state: 'Real sign-in accepted while platform status remains pending', role: 'anonymous', path: '/', target: '[role="status"][aria-label="正在打开知识库…"]',
    before: env => hold(env, '**/api/platform/status'), open: env => loginOwner(env.page), afterCapture: release,
    importantStates: inventory('PB-004', 'platform loading after accepted session'), fault: 'Hold actual platform status after real sign-in.', tests: ['tests/e2e/platform-bootstrap.spec.ts'] }),
  startup({ id: 'public-platform-retry', sourceIds: ['PB-006'], title: '身份保留的知识库状态失败与重试', state: 'One actual platform503 followed by real retry', role: 'owner', path: '/', target: '.share-error',
    before: async env => { await env.page.route('**/api/platform/status', route => route.fulfill({ status: 503, json: { error: 'isolated platform unavailable' } }), { times: 1 }); },
    open: async env => { await expect(env.page.getByRole('heading', { name: '暂时无法打开知识库', exact: true })).toBeVisible(); const session = await (await env.context.request.get('/api/auth/get-session')).json(); expect(session.user.id).toBe(env.fixture.userId); },
    afterCapture: async env => { await btn(env.page, '重新尝试').click(); await expect(env.page.locator('.workspace')).toBeVisible(); return { retryReachedRealWorkspace: true }; },
    importantStates: inventory('PB-006', 'login identity retained'), fault: 'First platform response503; actual accepted session retained and retry reaches real service.', tests: ['tests/e2e/platform-bootstrap.spec.ts'] }),
  startup({ id: 'public-platform-retry-pending', sourceIds: ['PB-006'], title: '知识库错误后的实际重试忙状态', state: 'First platform503 followed by a held real retry request', role: 'owner', path: '/', target: '[role="status"][aria-label="正在打开知识库…"]',
    before: async env => { await env.page.route('**/api/platform/status', route => route.fulfill({ status: 503, json: { error: 'isolated first platform failure' } }), { times: 1 }); },
    open: async env => { await expect(env.page.getByRole('heading', { name: '暂时无法打开知识库', exact: true })).toBeVisible(); await hold(env, '**/api/platform/status'); await btn(env.page, '重新尝试').click(); await expect(env.page.getByRole('status', { name: '正在打开知识库…', exact: true })).toBeVisible(); },
    afterCapture: async env => { await release(env); await expect(env.page.locator('.workspace')).toBeVisible(); return { realRetryPendingThenRecovered: true }; },
    importantStates: inventory('PB-006', 'platform request failure; retry busy'), fault: 'One actual503, then hold/release of the actual retry; no success response is replaced.', tests: ['tests/e2e/platform-bootstrap.spec.ts'] }),
  startup({ id: 'public-platform-logout-failure', sourceIds: ['PB-006'], title: '知识库故障时退出失败提示', state: 'Logout pending is observed before isolated503; existing session remains valid', role: 'owner', path: '/', target: '.share-error',
    before: async env => {
      await env.page.route('**/api/platform/status', route => route.fulfill({ status: 503, json: { error: 'isolated platform unavailable' } }));
      const held = gate(env.page); data.set(env.page, { release: held.release });
      await env.page.route('**/api/auth/sign-out', async route => { await held.pending; await route.fulfill({ status: 503, json: { error: 'isolated logout failed' } }); });
    },
    open: async env => {
      await btn(env.page, '退出并重新登录').click();
      // Naive UI's loading icon contributes a prefix to the accessible name.
      await expect(env.page.locator('.share-error').getByRole('button', { name: /退出并重新登录$/ })).toBeDisabled();
      await expect(env.page.locator('.share-error')).toHaveAttribute('aria-busy', 'true');
      state(env).release!(); await expect(env.page.getByRole('alert')).toContainText('暂时无法退出');
      await expect(btn(env.page, '退出并重新登录')).toBeEnabled();
      const session = await (await env.context.request.get('/api/auth/get-session')).json(); expect(session.user.id).toBe(env.fixture.userId);
    },
    importantStates: inventory('PB-006', 'logout pending; logout failure alert'), fault: 'Platform and sign-out503 only; never actually signs out the shared owner session.', tests: ['tests/e2e/platform-bootstrap.spec.ts'] }),
  startup({ id: 'public-workspace-chunk-error', sourceIds: ['PB-007'], title: '实际工作区模块导入失败', state: 'Workspace import transport rejected by isolated route', role: 'owner', path: '/', target: '[role="alert"].share-error',
    before: async env => { await env.page.route(chunk('Workspace'), route => route.abort('connectionfailed')); },
    open: async env => { await expect(env.page.getByRole('alert')).toContainText('请检查网络连接后重新打开此页面。'); },
    importantStates: inventory('PB-007', 'full-page error tells user to reopen'), fault: 'Abort actual Workspace lazy chunk. Expected import error is part of this fault scene.', tests: ['tests/e2e/startup-latency.spec.ts'] }),
  {
    id: 'public-compact-login-chunk-error', sourceIds: ['PB-007'], title: '重认证登录模块导入失败', state: 'Real expired-save path reaches failed compact Login import', role: 'owner', path: pathFor('public-compact-login-chunk-error'), target: '.dialog-card', window: true,
    before: async env => { await createNote(env); rememberRoute(env, 'public-compact-login-chunk-error', '/?note=' + state(env).note.id); await env.page.route(chunk('Login'), route => route.abort('connectionfailed')); },
    open: async env => { await env.page.locator('.cm-content').fill('# 模块失败时仍保留 ' + randomUUID()); await env.context.clearCookies(); await btn(env.page, '保存').click(); await expect(env.page.locator('.dialog-card [role="alert"]')).toContainText('请检查网络连接，稍后重试登录。'); },
    importantStates: inventory('PB-007', 'compact login error tells user to retry login later'), fault: 'Abort only actual compact Login chunk after real401; no account or DOM replacement.', tests: ['tests/e2e/platform-bootstrap.spec.ts'] },
  {
    id: 'public-oauth-modern', sourceIds: ['PB-018'], title: 'OAuth 业务授权', role: 'owner',
    state: 'Signed isolated V2 read-only policy with its actual knowledge preset; no grant issued',
    path: pathFor('public-oauth-modern'), target: '.oauth-consent .domain-permissions',
    before: async env => {
      const registry = await env.fixture.api('/api/platform/plugins');
      const plugin = registry.installed.find((item: any) => item.id === 'mcp');
      if (!plugin || plugin.state !== 'enabled') throw Error('Dedicated V2 capture requires an enabled isolated MCP plugin');
      const state = await env.fixture.api('/api/platform/mcp/permissions');
      const binding = state.bindings.knowledge;
      if (!binding?.ownerId || !binding.instanceId) throw Error('Actual knowledge permission binding unavailable');
      await env.fixture.api('/api/platform/plugins/mcp/config', 'PUT', {
        configVersion: plugin.configVersion,
        values: { oauthEnabled: true, permissionPolicy: { version: 2, domains: { knowledge: {
          ...binding, enabled: true, actions: ['read'], resources: { mode: 'all' },
        } } } },
      });
      await oauth(env, 'public-oauth-modern');
    },
    open: async ({ page }) => {
      await expect(page.getByRole('combobox', { name: '知识库能力预设', exact: true })).toBeVisible();
      await expect(page.locator('.oauth-consent .scope-row')).toHaveCount(0);
      await expect(page.getByRole('button', { name: '允许访问', exact: true })).toBeEnabled();
    },
    tests: ['tests/domain-permissions.test.ts', 'tests/e2e/oauth.spec.ts'],
  },
  {
    id: 'public-oauth-legacy', sourceIds: ['PB-019'], title: '兼容OAuth目录与操作守卫', state: 'Real signed authorization request with the fixture legacy MCP policy', role: 'owner', path: pathFor('public-oauth-legacy'), target: '.oauth-consent',
    before: async env => {
      await oauth(env, 'public-oauth-legacy');
      // A fresh MCP fixture has no optional permissionPolicy. Do not convert a
      // modern successful policy response into a fabricated legacy success.
      // If the coordinator intentionally configured V2 earlier, use its separate
      // legacy fixture rather than mutating or bypassing that installed policy.
    },
    open: async env => { await expect(env.page.locator('.scope-row')).not.toHaveCount(0); await expect(env.page.locator('.directory-row')).not.toHaveCount(0); await expect(env.page.getByRole('checkbox', { name: '读取所选目录中的资料', exact: true })).toBeChecked(); await expect(env.page.getByRole('checkbox', { name: '保持连接，允许刷新访问令牌', exact: true })).toBeChecked(); },
    verify: async env => { const allow = btn(env.page, '允许访问'); for (const item of await env.page.locator('.directory-row').getByRole('checkbox').all()) await item.uncheck(); await expect(allow).toBeDisabled(); return { emptyResourcesDisableAllow: true, realSignedResponseUsed: true, consentNotSubmitted: true }; },
    importantStates: inventory('PB-019', 'legacy scope checkboxes', 'directory choices shown for knowledge scope or blog publish', 'read/offline defaults only when allowed'),
    tests: ['tests/e2e/oauth.spec.ts'] },
  ...(['pending', 'error'] as const).map((kind): Scene => ({
    id: 'public-oauth-continuation-' + kind, sourceIds: ['PB-021'], title: '登录后继续授权 ' + kind, state: 'Real registered-client login followed by isolated continuation ' + kind, role: 'anonymous', path: pathFor('public-oauth-continuation-' + kind), target: '.share-error', readiness: 'target',
    before: async env => { await oauth(env, 'public-oauth-continuation-' + kind); const held = gate(env.page); data.set(env.page, { release: held.release }); await env.page.route('**/api/platform/mcp/oauth/continue', async route => { if (kind === 'pending') await held.pending; await route.fulfill({ status: 503, json: { error: 'isolated continuation unavailable' } }); }); },
    open: async env => { await loginOwner(env.page); await expect(env.page.getByText(kind === 'pending' ? '正在继续授权…' : '无法继续授权，请回到连接客户端重新发起连接。', { exact: true })).toBeVisible(); },
    afterCapture: release, importantStates: inventory('PB-021', kind === 'pending' ? 'continuing authorization' : 'continuation error with retry'),
    fault: 'Only actual POST continuation is held or fails503 after real sign-in; no validated redirect success is invented.', tests: ['tests/e2e/oauth.spec.ts'] })),
  {
    id: 'public-share-read-failure', sourceIds: ['PB-025'], title: '实际分享读取失败与恢复', state: 'UUID capability full read fails once; retry uses same real link', role: 'public-reader', path: pathFor('public-share-read-failure'), target: '.share-error',
    before: async env => { await createShare(env, 'public-share-read-failure'); await env.page.route('**/api/public/shares/' + state(env).share.token, route => route.fulfill({ status: 503, json: { error: 'isolated read unavailable' } }), { times: 1 }); },
    open: async env => { await expect(env.page.getByRole('heading', { name: '暂时无法读取分享笔记', exact: true })).toBeVisible(); await expect(btn(env.page, '重新加载')).toBeVisible(); },
    afterCapture: async env => { await hold(env, '**/api/public/shares/' + state(env).share.token); await btn(env.page, '重新加载').click(); await expect(env.page.getByText('正在读取分享笔记…', { exact: true })).toBeVisible(); await release(env); await expect(env.page.locator('.markdown')).toContainText('独立隔离资料'); return { sameCapabilityRecoveredThroughRealAPI: true }; },
    importantStates: inventory('PB-025', 'connection/server failure with refresh icon', 'reload pending; successful retry reads same link'), fault: 'One503 on actual capability read; subsequent response is unmodified realAPI.', tests: ['tests/e2e/reader-feedback.spec.ts'] },
  ...(['ready', 'next-failure'] as const).map((kind): Scene => ({
    id: 'public-share-large-' + kind, sourceIds: ['PB-023'], title: '真实大文件分享 ' + kind, state: 'Guarded temporary note bytes drive real large snapshot reader', role: 'public-reader', path: pathFor('public-share-large-' + kind), target: '.reader-layout',
    before: async env => {
      const note = await createNote(env), knowledge = await realpath(env.fixture.knowledgeRoot), root = dirname(knowledge);
      if (dirname(root) !== await realpath(tmpdir()) || !basename(root).startsWith('dooknow-browser-')) throw Error('Refusing large-file recipe outside isolated browser fixture');
      const path = resolve(knowledge, note.relativePath), child = relative(knowledge, path);
      if (!child || child.startsWith('..') || isAbsolute(child)) throw Error('Unsafe generated fixture note path');
      await writeFile(path, '# 真实大文件取证\n\n' + '当前大文件片段仍需可读。\n'.repeat(70000));
      const share = await env.fixture.api('/api/notes/' + note.id + '/share', 'POST', { permission: 'view', expiresAt: null }); state(env).share = share;
      rememberRoute(env, 'public-share-large-' + kind, new URL(share.url, env.fixture.origin).pathname);
      if (kind === 'next-failure') await env.page.route('**/api/public/shares/' + share.token + '/read', async route => { const body = route.request().postDataJSON(); if (body.cursor && !state(env).failedNext) { state(env).failedNext = true; await route.fulfill({ status: 503, json: { error: 'isolated next fragment unavailable' } }); } else await route.continue(); });
    },
    open: async env => { await expect(env.page.locator('.markdown')).toContainText('当前大文件片段仍需可读', { timeout: 60000 }); await expect(btn(env.page, '编辑笔记')).toHaveCount(0); await expect(env.page.getByRole('note')).toContainText('大文件'); await expect(btn(env.page, '下一片段')).toBeVisible(); if (kind === 'next-failure') { await btn(env.page, '下一片段').click(); await expect(env.page.getByRole('alert')).toContainText('下一片段读取失败'); await expect(env.page.locator('.markdown')).toContainText('当前大文件片段仍需可读'); } },
    afterCapture: async env => { await btn(env.page, '下一片段').click(); await expect(env.page.locator('.markdown')).toContainText('当前大文件片段仍需可读'); await expect(env.page.locator('.reader-fragment-error')).toHaveCount(0); return { realNextFragmentAvailable: true }; },
    importantStates: inventory('PB-023', 'current fragment; next cursor available/finished', 'unsupported-public-edit reason', ...(kind === 'next-failure' ? ['next-fragment failure keeps current rendered HTML and retry'] : [])),
    fault: kind === 'next-failure' ? 'One503 only for a real nonempty snapshot cursor; real current/next content otherwise.' : undefined, tests: ['tests/e2e/sharing-permissions.spec.ts', 'tests/e2e/reader-feedback.spec.ts'] })),
  {
    id: 'public-guest-cas-conflict', sourceIds: ['PB-028'], title: '访客真实版本冲突与草稿恢复', state: 'Owner changes UUID note after guest loads original CAS baseline', role: 'guest-editor', path: pathFor('public-guest-cas-conflict'), target: '.public-share-editor', representative: true,
    before: env => createShare(env, 'public-guest-cas-conflict', 'edit'),
    open: async env => { await guestSource(env); await env.page.locator('.cm-content').fill('# 访客草稿必须保留 ' + randomUUID()); const current = await env.fixture.api('/api/notes/' + state(env).note.id); await env.fixture.api('/api/notes/' + current.id, 'PUT', { content: '# 主人已经更新版本\n', expectedModifiedAt: current.modifiedAt, requestId: randomUUID() }); await btn(env.page, '保存修改').click(); await expect(env.page.getByRole('alert')).toContainText('笔记已更新'); await expect(env.page.locator('.cm-content')).toContainText('访客草稿必须保留'); },
    afterCapture: async env => { await btn(env.page, '重新载入最新内容').click(); await expect(env.page.getByRole('dialog')).toContainText('未保存'); await btn(env.page, '保留编辑').click(); await expect(env.page.locator('.cm-content')).toContainText('访客草稿必须保留'); return { realCASRejectedAndDraftRetained: true, reloadRequiresDiscard: true }; },
    importantStates: inventory('PB-028', '409 stale version preserves draft; instruct copy then reload'), tests: ['tests/e2e/sharing-permissions.spec.ts'] },
  articleScene('public-blog-crop', ['PB-035'], '真实图片裁切缩放与位置', crop, { target: '.blog-crop-editor',
    afterCapture: async env => { await btn(env.page, '取消裁切').click(); await expect(env.page.locator('.blog-crop-editor')).toHaveCount(0); await crop(env); await btn(env.page, '裁切并上传').click(); await expect(env.page.getByText('已选择图片', { exact: true })).toBeVisible(); await btn(env.page, '移除').click(); await expect(env.page.getByText('已选择图片', { exact: true })).toHaveCount(0); return { actualUploadSelectedRemovedAndCropCancelled: true }; },
    importantStates: inventory('PB-035', 'crop preview; zoom/position controls', 'selected; remove; cancel crop'), tests: ['tests/e2e/blog-studio.spec.ts'] }),
  articleScene('public-blog-crop-invalid-file', ['PB-035'], '图片类型拒绝', async env => { const details = env.page.locator('.blog-secondary-fields'); await details.locator('summary').click(); await env.page.getByLabel('选择上传并裁切封面图片', { exact: true }).setInputFiles({ name: 'not-an-image.txt', mimeType: 'text/plain', buffer: Buffer.from('isolated invalid image') }); await expect(env.page.locator('.blog-image-editor [role="alert"]')).toContainText('请选择 JPEG、PNG 或 WebP'); }, { target: '.blog-image-editor', importantStates: inventory('PB-035', 'file type/size rejection') }),
  articleScene('public-blog-crop-upload-error', ['PB-035'], '图片上传失败仍保留裁切', async env => {
    await crop(env); const held = gate(env.page); state(env).release = held.release;
    await env.page.route('**/api/notes/' + state(env).note.id + '/assets', async route => { if (route.request().method() !== 'POST') return route.continue(); await held.pending; await route.fulfill({ status: 503, json: { error: '隔离上传暂时失败' } }); }, { times: 1 });
    await btn(env.page, '裁切并上传').click(); await expect(btn(env.page, '正在上传…')).toBeDisabled(); await expect(env.page.getByLabel('缩放', { exact: true })).toBeDisabled(); held.release(); await expect(env.page.locator('.blog-image-editor [role="alert"]')).toContainText('隔离上传暂时失败'); await expect(env.page.locator('.blog-crop-editor')).toBeVisible();
  }, { target: '.blog-image-editor', fault: 'Actual multipart upload is held then fails503; no successful upload response is synthesized.', importantStates: inventory('PB-035', 'processing/uploading locks controls; upload failure retains crop') }),
  articleScene('public-blog-review-draft', ['PB-036'], '未发布文章的真实引用核对', async env => { await btn(env.page, '预览文章').click(); await expect(env.page.locator('.blog-publication-review')).toContainText('还没有公开版本。'); await expect(env.page.locator('.blog-review-diagnostics')).toContainText('图片不存在或不在授权范围内'); expect(await env.page.locator('.blog-reviewed-body').evaluate((element: HTMLDetailsElement) => element.open)).toBe(false); }, {
    content: '# 待发布核对\n\n[缺失笔记](missing-' + randomUUID() + '.md)\n\n![缺图](missing-' + randomUUID() + '.png)\n', target: '.blog-preview',
    importantStates: inventory('PB-036', 'original-source preview folded under details'), tests: ['tests/e2e/blog.spec.ts', 'tests/blog-studio-review.test.ts'] }),
  articleScene('public-blog-review-published', ['PB-036'], '线上与待发真实快照对照', async env => { await btn(env.page, '预览文章').click(); await expect(env.page.locator('.blog-review-columns > section')).toHaveCount(2); await expect(env.page.locator('.blog-review-columns > section').first().locator('.markdown')).toBeVisible(); await expect(env.page.locator('.blog-review-columns > section').last().locator('.markdown')).toBeVisible(); }, { published: true, target: '.blog-preview', importantStates: inventory('PB-036', 'no public version yet vs published/draft columns') }),
  articleScene('public-blog-review-error-retry', ['PB-036'], '发布核对读取失败与实际重试', async env => {
    const held = gate(env.page); await env.page.route('**/api/blog/posts/' + state(env).post.id + '/review', async route => { await held.pending; await route.fulfill({ status: 503, json: { error: '隔离发布核对读取失败' } }); }, { times: 1 });
    await btn(env.page, '预览文章').click(); await expect(env.page.getByText('正在检查线上快照、原稿引用和关联文章…', { exact: true })).toBeVisible(); held.release(); await expect(env.page.locator('.blog-publication-review [role="alert"]')).toContainText('隔离发布核对读取失败');
  }, { target: '.blog-preview', fault: 'Only the first actual publication review read is held then fails503.', afterCapture: async env => { await btn(env.page, '刷新检查').click(); await expect(env.page.locator('.blog-review-columns')).toBeVisible(); return { actualReviewRetrySucceeded: true }; }, importantStates: inventory('PB-036', 'review loading/error; retry') }),
  ...(['withdraw', 'remove'] as const).map(kind => articleScene('public-blog-confirm-' + kind, [kind === 'withdraw' ? 'PB-037' : 'PB-038'], kind === 'withdraw' ? '实际下架确认' : '实际移除选稿确认', async env => {
    await btn(env.page, kind === 'withdraw' ? '下架文章' : '移除选稿').click(); await expect(env.page.getByRole('alertdialog', { name: '确认博客操作', exact: true })).toBeVisible(); expect((await env.fixture.api('/api/notes/' + state(env).note.id)).id).toBe(state(env).note.id);
  }, { published: kind === 'withdraw', target: '[role="alertdialog"][aria-label="确认博客操作"]', window: true,
    afterCapture: async env => {
      const trigger = btn(env.page, kind === 'withdraw' ? '下架文章' : '移除选稿'); await env.page.keyboard.press('Escape'); await expect(env.page.getByRole('alertdialog')).toHaveCount(0); await expect(trigger).toBeFocused(); await trigger.click(); await btn(env.page, kind === 'withdraw' ? '确认下架' : '确认移除').click();
      await expect(env.page.getByText(kind === 'withdraw' ? '文章已下架，原稿和文章信息仍然保留。' : '已移除博客文章，原笔记仍保留。', { exact: true })).toBeVisible(); expect((await env.fixture.api('/api/notes/' + state(env).note.id)).id).toBe(state(env).note.id);
      if (kind === 'remove') await expect(env.page.getByText('选择左侧文章，或从知识库中选一篇笔记。', { exact: true })).toBeVisible();
      return { realConfirmationExecuted: true, originalNoteRetained: true, escapeRestoredFocus: true };
    }, importantStates: inventory(kind === 'withdraw' ? 'PB-037' : 'PB-038', kind === 'withdraw' ? 'inline alertdialog; source note retained' : 'inline alertdialog; original note retained', ...(kind === 'remove' ? ['successful removal clears article-specific forms/selection'] : [])) })),
  {
    id: 'public-blog-expanded-preview', sourceIds: ['PB-047'], title: '真实放大预览与iframe焦点', state: 'Native preview modal retains1100/375 inner viewports', role: 'owner', path: studioPath, target: page => page.getByRole('dialog', { name: '主页预览', exact: true }), window: true, representative: true,
    open: async env => { await expect(env.page.frameLocator('iframe[title="博客主页草稿预览"]').locator('html')).toBeVisible(); await btn(env.page, '放大预览').click(); await expect(env.page.getByRole('dialog', { name: '主页预览', exact: true })).toBeVisible(); expect(await env.page.evaluate(() => document.body.style.overflow)).toBe('hidden'); },
    afterCapture: async env => {
      const dialog = env.page.getByRole('dialog', { name: '主页预览', exact: true }), frame = dialog.frameLocator('iframe[title="博客主页放大预览"]');
      await dialog.getByRole('button', { name: '桌面', exact: true }).click(); await expect.poll(() => frame.locator('html').evaluate(() => innerWidth)).toBe(1100);
      await dialog.getByRole('button', { name: '手机', exact: true }).click(); await expect.poll(() => frame.locator('html').evaluate(() => innerWidth)).toBe(375);
      expect((await dialog.locator('iframe').getAttribute('sandbox'))?.split(/\s+/)).not.toContain('allow-scripts'); await dialog.locator('iframe').focus(); await env.page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible(); await expect(btn(env.page, '放大预览')).toBeFocused();
      await btn(env.page, '放大预览').click(); await env.page.mouse.click(2, 2); await expect(dialog).not.toBeVisible(); await expect(btn(env.page, '放大预览')).toBeFocused(); return { innerWidths: [1100, 375], iframeEscapeAndBackdropReturnFocus: true };
    }, importantStates: inventory('PB-047', 'native modal dialog and locked body scroll', 'desktop/mobile fixed viewport scaling', 'Escape works from iframe; backdrop closes; focus restored'), tests: ['tests/e2e/blog-admin-preview.spec.ts'] },
  {
    id: 'public-blog-history-restore', sourceIds: ['PB-048'], title: '真实发布历史仅恢复为草稿', state: 'Two actual UUID design publications followed by draft-only restore', role: 'owner', path: studioPath, target: '.blog-history',
    before: async env => {
      const names = ['历史版本A ' + randomUUID().slice(0, 8), '历史版本B ' + randomUUID().slice(0, 8)]; data.set(env.page, { names, revisions: [] });
      for (const name of names) { const current = await env.fixture.api('/api/blog/design'); const saved = await env.fixture.api('/api/blog/design', 'PATCH', { expectedVersion: current.version, requestId: randomUUID(), design: { ...current.draft, profile: { ...current.draft.profile, name } } }); const published = await env.fixture.api('/api/blog/design/publish', 'POST', { expectedVersion: saved.version, requestId: randomUUID() }); state(env).revisions.push(published.publishedRevision); }
      state(env).revision = state(env).revisions[0]; state(env).publishedRevision = state(env).revisions[1];
      const current = await env.fixture.api('/api/blog/design');
      state(env).restoreIndex = current.history.findIndex((revision: { revision: number }) => revision.revision === state(env).revision);
      expect(state(env).restoreIndex).toBeGreaterThanOrEqual(0);
    },
    open: async env => { await env.page.locator('.blog-history summary').click(); await expect(env.page.locator('.blog-history-row').first()).toContainText('版本'); await env.page.getByLabel('姓名', { exact: true }).fill('本地尚未保存'); for (const action of await env.page.locator('.blog-history').getByRole('button', { name: '恢复到草稿', exact: true }).all()) await expect(action).toBeDisabled(); await env.page.getByLabel('姓名', { exact: true }).fill(state(env).names[1]); },
    afterCapture: async env => { const row = env.page.locator('.blog-history-row').nth(state(env).restoreIndex); expect(await row.locator(':scope > span').evaluate(element => element.firstChild?.textContent?.trim())).toBe('版本 ' + state(env).revision); await row.getByRole('button', { name: '恢复到草稿', exact: true }).click(); await expect(env.page.locator('.blog-studio .blog-alert.success')).toContainText('恢复到草稿'); const current = await env.fixture.api('/api/blog/design'); expect(current.publishedRevision).toBe(state(env).publishedRevision); expect(current.published.profile.name).toBe(state(env).names[1]); expect(current.draft.profile.name).toBe(state(env).names[0]); await expect(btn(env.page, '发布主页')).toBeEnabled(); return { publishedRevisionUnchanged: true, restoredOnlyIntoDraft: true }; },
    importantStates: inventory('PB-048', 'version+time rows', 'restore disabled while dirty or busy', 'restored only into draft; success requires later manual publish'), tests: ['tests/e2e/blog-studio.spec.ts'] },
  articleScene('public-blog-metadata-cas', ['PB-049'], '文章信息真实CAS冲突', async env => { await env.page.getByLabel('文章标题', { exact: true }).fill('本地文章编辑必须保留'); const detail = await env.fixture.api('/api/blog/posts/' + state(env).post.id); await env.fixture.api('/api/blog/posts/' + state(env).post.id, 'PATCH', { expectedVersion: detail.post.version, metadata: { title: '另一会话已保存的版本', summary: detail.post.summary, category: detail.post.category, tags: detail.post.tags, cover: detail.post.cover, pinned: detail.post.pinned, slug: detail.post.slug }, requestId: randomUUID() }); await btn(env.page, '保存文章信息').click(); await expect(env.page.getByLabel('文章标题', { exact: true })).toHaveValue('本地文章编辑必须保留'); await expect(env.page.locator('.blog-article-detail [role="alert"]')).toBeVisible(); }, { importantStates: inventory('PB-049', 'failed metadata save retains local form') }),
  articleScene('public-blog-source-change-blocks-publish', ['PB-049'], '原稿变化阻止沿用旧预览发布', async env => { const current = await env.fixture.api('/api/notes/' + state(env).note.id); await env.fixture.api('/api/notes/' + current.id, 'PUT', { content: '# 原稿的新版本尚未发布\n\n' + randomUUID(), expectedModifiedAt: current.modifiedAt, requestId: randomUUID() }); await btn(env.page, '发布更新').click(); await expect(env.page.locator('.blog-article-detail [role="alert"]')).toContainText('原稿或文章信息已变化'); const html = await (await env.context.request.get('/blog/' + state(env).post.slug)).text(); expect(html).not.toContain('原稿的新版本尚未发布'); }, { published: true, importantStates: inventory('PB-049', 'article/version/source changed blocks publish and refreshes detail') }),
  ...(['code', 'fallback', 'copy-failure', 'share-fallback', 'share-abort', 'share-error'] as const).map((kind): Scene => ({
    id: 'public-reader-feedback-' + kind, sourceIds: ['PB-055'], title: '实际公开阅读复制/分享反馈 ' + kind, state: 'Real published reader controls with isolated browser capability branch ' + kind, role: 'public-reader', path: pathFor('public-reader-feedback-' + kind), target: '.reader-actions',
    before: async env => {
      const settings = await env.fixture.api('/api/blog/settings'); if (!settings.enabled) await env.fixture.api('/api/blog/settings', 'PATCH', { settings: { ...settings, enabled: true }, requestId: randomUUID() });
      await createArticle(env, true); rememberRoute(env, 'public-reader-feedback-' + kind, '/blog/' + state(env).post.slug);
      if (kind === 'fallback') await env.context.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }); });
      // Browser source avoids tsx's inferred function-name helper in serialized callbacks.
      if (kind === 'copy-failure') await env.context.addInitScript({ content: `Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new DOMException('isolated clipboard denial', 'NotAllowedError')) } });` });
      if (kind === 'share-fallback') await env.context.addInitScript(() => Object.defineProperty(navigator, 'share', { configurable: true, value: undefined }));
      if (kind === 'share-abort' || kind === 'share-error') await env.page.addInitScript({ content: `(() => {
        const audit = { installedBeforeReader: !document.querySelector('[data-share]'), nativeShareOriginallyAvailable: typeof navigator.share === 'function', shareCalls: 0, clipboardCalls: 0, execCopyCalls: 0 };
        window.__platformUIShareFault = audit;
        const write = navigator.clipboard && navigator.clipboard.writeText.bind(navigator.clipboard);
        if (write) Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: (...args) => { audit.clipboardCalls++; return write(...args); } });
        const exec = document.execCommand.bind(document);
        Object.defineProperty(document, 'execCommand', { configurable: true, value: (command, ...args) => { if (command === 'copy') audit.execCopyCalls++; return exec(command, ...args); } });
        Object.defineProperty(navigator, 'share', { configurable: true, value: () => { audit.shareCalls++; return Promise.reject(${kind === 'share-abort'} || audit.shareCalls === 1 ? new DOMException('isolated cancellation', 'AbortError') : new Error('isolated native share error')); } });
      })();` });
    },
    open: async env => {
      await expect(env.page.locator('.copy-code')).toBeVisible();
      if (kind === 'code') { await env.page.locator('.copy-code').first().click(); await expect(env.page.locator('.copy-code').first()).toHaveText('已复制'); await expect(env.page.locator('[data-reader-status]')).toHaveText('代码已复制'); }
      else if (kind === 'fallback') { await btn(env.page, '复制链接').click(); await expect(env.page.locator('[data-reader-status]')).toHaveText('链接已复制'); expect(await env.page.evaluate(() => typeof navigator.clipboard)).toBe('undefined'); }
      else if (kind === 'copy-failure') { expect(await env.page.evaluate(() => window.isSecureContext)).toBe(true); await env.page.locator('.copy-code').first().click(); await expect(env.page.locator('[data-reader-status]')).toHaveText('无法复制，请手动选择代码'); await btn(env.page, '复制链接').click(); await expect(env.page.locator('[data-reader-status]')).toHaveText('无法复制，请复制地址栏链接'); }
      else {
        if (kind === 'share-abort' || kind === 'share-error') {
          const installed = await env.page.evaluate(() => ({ audit: (window as any).__platformUIShareFault, shareType: typeof navigator.share }));
          expect(installed.audit?.installedBeforeReader).toBe(true); expect(installed.shareType).toBe('function');
        }
        await btn(env.page, '分享文章').click();
        if (kind === 'share-fallback') await expect(env.page.locator('[data-reader-status]')).toHaveText('链接已复制，可以分享给朋友');
        if (kind === 'share-abort' || kind === 'share-error') {
          await expect.poll(() => env.page.evaluate(() => (window as any).__platformUIShareFault?.shareCalls)).toBe(1);
          await env.page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
          await expect(env.page.locator('[data-reader-status]')).toHaveText('');
          const audit = await env.page.evaluate(() => (window as any).__platformUIShareFault); expect(audit.clipboardCalls).toBe(0); expect(audit.execCopyCalls).toBe(0);
        }
        if (kind === 'share-error') { await btn(env.page, '分享文章').click(); await expect(env.page.locator('[data-reader-status]')).toHaveText('暂时无法分享，请复制链接'); await expect.poll(() => env.page.evaluate(() => (window as any).__platformUIShareFault.shareCalls)).toBe(2); }
      }
    },
    verify: async env => { if (kind === 'code') await expect(env.page.locator('.copy-code').first()).toHaveText('复制代码', { timeout: 5000 }); return { actualReaderScriptAction: kind,
      ...(kind === 'share-abort' || kind === 'share-error' ? { standardAPIFaultAudit: await env.page.evaluate(() => (window as any).__platformUIShareFault), nativeOSShare: 'not-hardware-verified' } : {}) }; },
    importantStates: inventory('PB-055', ...({ code: ['code copied then button resets after2s'], fallback: ['clipboard API unavailable uses execCommand fallback'], 'copy-failure': ['copy fails: manual code/address instructions'], 'share-fallback': ['navigator.share unavailable: copy-link fallback'], 'share-abort': [], 'share-error': ['native share AbortError silent; other errors report'] }[kind])),
    fault: kind === 'code' ? undefined : kind === 'share-abort' || kind === 'share-error'
      ? 'Standard Web Share API rejection injected on the page before SSR reader.js; calls and absence of clipboard fallback asserted. Simulated API availability is declared; no native OS dialog or successful share is claimed.'
      : 'Only browser clipboard/share capability is unavailable or rejects as named; actual reader.js and native execCommand fallback run unmodified, never synthesize successful copy.', tests: ['tests/e2e/blog-public-redesign.spec.ts', 'tests/e2e/blog-studio.spec.ts'] })),
];
