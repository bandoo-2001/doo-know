/** First-run recipes: every scene receives its own real app/database/owner. */
import { expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import type { Scene, SceneEnv } from './model';
import { registerSceneCleanup } from './lifecycle';

const state = new WeakMap<Page, { release?: () => void; requests?: number; fileName?: string }>();
const btn = (env: SceneEnv, name: string) => env.page.getByRole('button', { name, exact: true });
async function disabledTextButton(env: SceneEnv, scope: string, name: string) {
  // Ant's loading icon has role=img/aria-label=loading and augments the accessible
  // button name. Keep the exact visible text and native disabled assertion.
  const button = env.page.locator(scope).getByRole('button').filter({ hasText: name });
  await expect(button).toHaveCount(1);
  await expect(button).toHaveText(name);
  await expect(button).toBeDisabled();
}
const setup = (env: SceneEnv) => {
  if (!env.fixture.setup) throw Error('Fresh independent setup app required');
  return env.fixture.setup;
};
const exact = (sourceId: string, ...states: string[]) => ({ [sourceId]: states });
async function initial(env: SceneEnv) {
  setup(env);
  await expect(env.page.getByRole('heading', { name: '准备你的知识库', exact: true })).toBeVisible({ timeout: 30000 });
  await expect(env.page.getByRole('button', { name: '创建新知识库', exact: true })).toHaveAttribute('aria-pressed', 'true');
}
async function advanced(env: SceneEnv) {
  const details = env.page.locator('.setup-page details.advanced').first();
  if (!await details.evaluate((element: HTMLDetailsElement) => element.open)) await details.locator('summary').click();
}
async function namedLibrary(env: SceneEnv, name = 'runtime-' + randomUUID().slice(0, 8)) {
  await initial(env); await advanced(env);
  await env.page.getByLabel('保存到哪个文件夹', { exact: true }).fill(setup(env).libraryParent);
  await env.page.getByLabel('知识库名称', { exact: true }).fill(name);
}
async function features(env: SceneEnv) {
  await namedLibrary(env); await btn(env, '确认并继续').click();
  await expect(env.page.getByRole('heading', { name: '选择需要的功能', exact: true })).toBeVisible({ timeout: 60000 });
  const actual = await env.fixture.api('/api/platform/status');
  if (actual.phase !== 'ready' || !actual.knowledgeRoot) throw Error('Actual library binding is not ready');
  env.fixture.knowledgeRoot = actual.knowledgeRoot;
}
async function ready(env: SceneEnv) {
  await features(env); await btn(env, '暂时跳过').click();
  await expect(env.page.getByRole('heading', { name: '知识库准备好了', exact: true })).toBeVisible();
}
async function existing(env: SceneEnv) {
  await initial(env); await btn(env, '使用已有资料').click();
  await expect(env.page.getByRole('button', { name: '打开文件夹 personal', exact: true })).toBeVisible();
}
async function chosen(env: SceneEnv, empty = false) {
  await existing(env); await btn(env, '打开文件夹 personal').click();
  if (empty) await btn(env, '打开文件夹 00-Inbox').click();
  await btn(env, '使用这个文件夹').click();
  await expect(env.page.locator('.chosen-folder')).toContainText(empty ? '00-Inbox' : 'personal');
}
async function remote(env: SceneEnv) {
  await initial(env); await btn(env, '从 GitHub／Gitee 导入').click();
  await expect(env.page.getByLabel('仓库克隆地址', { exact: true })).toBeVisible();
}
async function remoteFilled(env: SceneEnv, name = 'clone-' + randomUUID().slice(0, 8)) {
  await remote(env); await env.page.getByLabel('仓库克隆地址', { exact: true }).fill(setup(env).gitRemoteURL);
  await env.page.getByLabel('导入后的知识库名称', { exact: true }).fill(name);
  await env.page.getByLabel('导入保存位置（选填）', { exact: true }).fill(setup(env).libraryParent);
}
async function hold(env: SceneEnv, pattern: string | RegExp, method?: string) {
  let release!: () => void; const pending = new Promise<void>(done => { release = done; });
  registerSceneCleanup(env.page, release);
  state.set(env.page, { ...(state.get(env.page) ?? {}), release });
  await env.page.route(pattern, async route => { if (method && route.request().method() !== method) return route.continue();
    await pending; await route.continue().catch(() => undefined); });
}
async function release(env: SceneEnv) { state.get(env.page)?.release?.(); }
async function importPanel(env: SceneEnv) {
  await ready(env); await env.page.locator('.setup-page summary').filter({ hasText: '导入已有资料' }).click();
  await expect(env.page.getByLabel('选择 Markdown 文件', { exact: true })).toBeVisible();
}
async function importFile(env: SceneEnv, type: 'normal' | 'extension' | 'size' | 'utf8' = 'normal') {
  const name = 'runtime-import-' + randomUUID().slice(0, 8) + (type === 'extension' ? '.txt' : '.md');
  const buffer = type === 'size' ? Buffer.alloc(256 * 1024 + 1, 65) : type === 'utf8' ? Buffer.from([0xc3, 0x28]) : Buffer.from('# 隔离导入原文\n');
  state.set(env.page, { ...(state.get(env.page) ?? {}), fileName: name });
  await env.page.getByLabel('选择 Markdown 文件', { exact: true }).setInputFiles({ name, mimeType: 'text/markdown', buffer });
}
const scene = (id: string, sourceId: string, title: string, open: Scene['open'], options: Partial<Scene> = {}): Scene => ({
  id: 'setup-extra-' + id, sourceIds: [sourceId], title, state: title, role: 'owner', suite: 'setup', readiness: 'target',
  path: '/', target: '.setup-page', open, representative: true,
  tests: ['tests/platform-browser/setup.spec.ts', 'tests/platform-setup.test.ts'], ...options,
});

export const setupScenes: Scene[] = [
  scene('new', 'PB-008', 'Actual first-run new-library form and three-step progress', async env => {
    await initial(env); await expect(env.page.getByRole('list', { name: '首次设置进度', exact: true })).toBeVisible();
    await expect(env.page.getByLabel('知识库名称', { exact: true })).toHaveValue('我的知识库');
  }, { importantStates: exact('PB-008', 'three-step progress; new source selected') }),
  scene('create-busy', 'PB-008', 'Actual pending create request locks the real form', async env => {
    await namedLibrary(env); await hold(env, '**/api/platform/setup/create', 'POST'); await btn(env, '确认并继续').click();
    await expect(env.page.getByLabel('知识库名称', { exact: true })).toBeDisabled(); await expect(btn(env, '使用已有资料')).toBeDisabled();
  }, { fault: 'Hold the real create transport before response; no successful directory/binding receipt is fulfilled.',
    afterCapture: release, importantStates: exact('PB-008', 'create then validate then bind busy') }),
  ...[['name-exists', 'personal', '已经存在'], ['invalid-name', '../escape', '知识库名称']].map(([id, name, error]): Scene => scene(id, 'PB-008',
    'Actual setup API rejects ' + id, async env => { await namedLibrary(env, name); await btn(env, '确认并继续').click(); await expect(env.page.getByRole('alert')).toContainText(error); },
    { importantStates: exact('PB-008', 'existing-name/forbidden/unwritable/invalid name errors') })),
  scene('forbidden-path', 'PB-008', 'Actual server refuses a parent outside its allowed library range', async env => {
    await namedLibrary(env); await env.page.getByLabel('保存到哪个文件夹', { exact: true }).fill(env.fixture.dataRoot);
    await btn(env, '确认并继续').click(); await expect(env.page.getByRole('alert')).toContainText('换一个保存位置');
  }, { importantStates: exact('PB-008', 'existing-name/forbidden/unwritable/invalid name errors') }),
  scene('invalid-timezone', 'PB-010', 'Actual timezone validation error retains fields', async env => {
    await namedLibrary(env); await env.page.getByLabel('时区', { exact: true }).fill('Invalid/Fixture');
    await btn(env, '确认并继续').click(); await expect(env.page.getByRole('alert')).toContainText('时区');
  }, { sourceIds: ['PB-008', 'PB-010'], importantStates: { ...exact('PB-010', 'invalid timezone/path validation errors'),
    ...exact('PB-008', 'expired validation; root changed; setup already completed; invalid timezone') } }),
  scene('validation-expired', 'PB-008', 'Actual server rejection of a validation proof missing from its live store', async env => {
    await namedLibrary(env); await env.page.route('**/api/platform/setup/complete', async route => {
      const input = route.request().postDataJSON(); await route.continue({ postData: JSON.stringify({ ...input, validationId: randomUUID() }) });
    });
    await btn(env, '确认并继续').click(); await expect(env.page.getByRole('alert')).toContainText('确认时间已过');
  }, { fault: 'Alter the actual complete request proof to a nonexistent UUID; real server VALIDATION_EXPIRED path, no successful result synthesized.',
    importantStates: exact('PB-008', 'expired validation; root changed; setup already completed; invalid timezone') }),
  scene('root-changed', 'PB-008', 'Actual directory identity changes after validation; retained old directory', async env => {
    await namedLibrary(env); await env.page.route('**/api/platform/setup/validate', async route => {
      const response = await route.fetch(), proof = await response.json();
      if (response.ok()) {
        const child = relative(setup(env).libraryParent, proof.knowledgeRoot);
        if (!child || child.startsWith('..') || isAbsolute(child)) throw Error('Refusing non-fixture root identity change');
        await rename(proof.knowledgeRoot, proof.knowledgeRoot + '-retained'); await mkdir(proof.knowledgeRoot);
      }
      await route.fulfill({ response });
    });
    await btn(env, '确认并继续').click(); await expect(env.page.getByRole('alert')).toContainText('刚刚发生了变化');
  }, { fault: 'Within this fresh slot only, rename the validated empty library and create a new inode at its original path before actual completion.',
    importantStates: exact('PB-008', 'expired validation; root changed; setup already completed; invalid timezone') }),
  scene('already-bound', 'PB-008', 'Actual competing completion wins before current form submit', async env => {
    await namedLibrary(env); await env.page.route('**/api/platform/setup/complete', async route => {
      const input = route.request().postDataJSON();
      await env.fixture.api('/api/platform/setup/complete', 'POST', { ...input, requestId: randomUUID() });
      await route.continue();
    });
    await btn(env, '确认并继续').click(); await expect(env.page.getByRole('alert')).toContainText('知识库已设置');
  }, { importantStates: exact('PB-008', 'expired validation; root changed; setup already completed; invalid timezone') }),
  scene('directory-loading', 'PB-009', 'Actual directory listing request pending', async env => {
    await initial(env); await hold(env, '**/api/platform/setup/directories', 'POST'); await btn(env, '使用已有资料').click();
    await expect(env.page.getByText('正在读取文件夹…', { exact: true })).toBeVisible();
  }, { fault: 'Hold only the real directory-read transport.', afterCapture: release, importantStates: exact('PB-009', 'folder listing loading') }),
  scene('allowed-root', 'PB-009', 'Actual allowed top-level path cannot be selected as a library', async env => {
    await existing(env); await expect(btn(env, '使用这个文件夹')).toBeDisabled();
  }, { importantStates: exact('PB-009', 'allowed root itself cannot be bound') }),
  scene('empty-directory', 'PB-009', 'Actual empty child directory remains selectable', async env => {
    await chosen(env, true); await expect(env.page.getByText('没有可浏览的子文件夹，可以选择当前文件夹。', { exact: true })).toBeVisible();
  }, { importantStates: exact('PB-009', 'no child directories; current path selectable') }),
  scene('truncated-directory', 'PB-009', 'Actual directory listing exceeds its200-item limit', async env => {
    // Truncation is applied during directory enumeration, before sorting. The
    // seeded personal folder need not be included among the returned200 rows.
    await initial(env);
    const response = env.page.waitForResponse(value => new URL(value.url()).pathname === '/api/platform/setup/directories' && value.request().method() === 'POST');
    await btn(env, '使用已有资料').click();
    const actual = await response, listing = await actual.json();
    expect(actual.ok()).toBe(true); expect(listing.path).toBe(setup(env).libraryParent);
    expect(listing.truncated).toBe(true); expect(listing.directories).toHaveLength(200);
    await expect(env.page.locator('.folder-list > li')).toHaveCount(200);
    await expect(env.page.getByText('文件夹较多，仅显示部分结果。可以在高级设置中填写完整路径。', { exact: true })).toBeVisible();
    await advanced(env); await expect(env.page.getByLabel('服务器上的知识库目录', { exact: true })).toBeVisible();
  }, { before: async env => { await Promise.all(Array.from({ length: 205 }, (_, index) => mkdir(resolve(setup(env).libraryParent, 'fixture-child-' + index)))); },
    importantStates: exact('PB-009', 'truncated listing with advanced-path fallback') }),
  scene('directory-error-retry', 'PB-009', 'Actual directory transport failure retains retry and then recovers', async env => {
    await initial(env); await env.page.route('**/api/platform/setup/directories', route => route.abort('failed'), { times: 1 });
    await btn(env, '使用已有资料').click(); await expect(btn(env, '重新选择')).toBeVisible(); await expect(env.page.getByRole('alert')).toBeVisible();
  }, { fault: 'Abort exactly one actual directory-read request, then allow actual retry.',
    afterCapture: async env => { await btn(env, '重新选择').click(); await expect(btn(env, '打开文件夹 personal')).toBeVisible(); return { realRetry: 'folder-list-returned' }; },
    importantStates: exact('PB-009', 'read failure and retry; chosen-folder receipt') }),
  scene('chosen-directory', 'PB-009', 'Actual selected-folder receipt', async env => { await chosen(env); },
    { importantStates: exact('PB-009', 'read failure and retry; chosen-folder receipt') }),
  scene('advanced-new', 'PB-010', 'Actual new-library optional parent path and timezone controls', async env => {
    await namedLibrary(env); await expect(env.page.getByLabel('时区', { exact: true })).toBeVisible(); await expect(env.page.locator('.advanced')).toContainText('允许保存的范围');
  }, { importantStates: exact('PB-010', 'new-mode optional parent path', 'allowed-range hint; timezone autocomplete') }),
  scene('advanced-existing', 'PB-010', 'Actual existing-library full path and timezone controls', async env => {
    await chosen(env); await advanced(env); await expect(env.page.getByLabel('服务器上的知识库目录', { exact: true })).toHaveValue(setup(env).existingRoot);
  }, { importantStates: exact('PB-010', 'existing-mode full root path') }),
  scene('git-empty', 'PB-011', 'Actual first-run Git import form without credentials', remote,
    { importantStates: exact('PB-011', 'empty clone inputs; no credentials required for public HTTPS') }),
  scene('git-read-success', 'PB-011', 'Real isolated bare repository read-connection result', async env => {
    await remoteFilled(env); await btn(env, '测试读取连接').click();
    await expect(env.page.getByText('读取连接成功。这不代表拥有推送权限。', { exact: true })).toBeVisible({ timeout: 90000 });
  }, { importantStates: exact('PB-011', 'connection test running/result') }),
  scene('git-clone-running', 'PB-011', 'Actual accepted clone job pending in its local provider transport', async env => {
    await remoteFilled(env); await btn(env, '导入并继续').click(); await expect(btn(env, '取消当前任务')).toBeVisible({ timeout: 90000 });
    const before = await env.fixture.api('/api/platform/git/status');
    const accepted = before.jobs.find((entry: { kind: string; status: string }) => entry.kind === 'clone' && ['queued', 'running'].includes(entry.status));
    expect(accepted).toBeTruthy();
    await env.page.reload();
    // SetupWizard deliberately initializes its source mode to new after reload.
    // Reopen the real import entry so GitRemotePanel mounts and reads stored jobs.
    await remote(env); await expect(btn(env, '取消当前任务')).toBeVisible({ timeout: 30000 });
    const after = await env.fixture.api('/api/platform/git/status');
    expect(after.jobs.find((entry: { id: string }) => entry.id === accepted.id)?.status).toMatch(/^(queued|running)$/);
  }, { setupMode: 'git-delayed', fault: 'Delay the mapped local provider clone transport after the actual job is accepted; no successful job data is fulfilled.',
    afterCapture: async env => { await setup(env).releaseGit?.(); return { providerTransportReleased: true }; },
    importantStates: exact('PB-011', 'clone queued/running; server task persists across refresh') }),
  scene('git-clone-cancelled', 'PB-011', 'Actual cancel of a real pending clone job preserves the source repository', async env => {
    await remoteFilled(env); await btn(env, '导入并继续').click(); await expect(btn(env, '取消当前任务')).toBeVisible({ timeout: 90000 });
    await btn(env, '取消当前任务').click(); await expect(env.page.getByText('任务已取消', { exact: true }).first()).toBeVisible({ timeout: 30000 });
  }, { setupMode: 'git-delayed', fault: 'Actual clone transport waits for cancellation/release in a mapped local fixture.',
    importantStates: exact('PB-011', 'failed/cancelled/needs_reconciliation and unresolved-request recovery') }),
  scene('git-clone-lost-receipt', 'PB-011', 'Actual accepted clone POST loses its browser response', async env => {
    await remoteFilled(env); await env.page.route('**/api/platform/git/jobs', async route => {
      if (route.request().method() !== 'POST') return route.continue(); await route.fetch(); await route.abort('failed');
    });
    await btn(env, '导入并继续').click(); await expect(env.page.getByText(/请求结果尚未确认/).first()).toBeVisible({ timeout: 90000 });
  }, { setupMode: 'git-delayed', fault: 'Actual server accepts clone; only its POST response is discarded while the local provider waits.',
    afterCapture: async env => { await setup(env).releaseGit?.(); return { actualProviderReleased: true }; },
    importantStates: exact('PB-011', 'failed/cancelled/needs_reconciliation and unresolved-request recovery') }),
  scene('git-clone-success', 'PB-011', 'Actual clone binds a new independent knowledge library', async env => {
    await remoteFilled(env); await btn(env, '导入并继续').click();
    await expect(env.page.getByRole('heading', { name: '选择需要的功能', exact: true })).toBeVisible({ timeout: 90000 });
    const actual = await env.fixture.api('/api/platform/status'); if (actual.phase !== 'ready') throw Error('Real clone did not bind a ready library');
  }),
  scene('git-same-name', 'PB-011', 'Actual clone rejects an existing same-name library directory', async env => {
    await remoteFilled(env, 'personal'); await btn(env, '导入并继续').click(); await expect(env.page.getByRole('alert').first()).toBeVisible({ timeout: 90000 });
    await expect(env.page.getByRole('heading', { name: '准备你的知识库', exact: true })).toBeVisible();
  }, { importantStates: exact('PB-011', 'existing same-name folder stops import') }),
  scene('features-unadded', 'PB-012', 'Actual optional features after real library binding', async env => {
    await features(env); await expect(env.page.locator('.feature-state').filter({ hasText: '可选 · 随时添加' })).toHaveCount(2);
  }, { importantStates: exact('PB-012', 'not added; added but needs configuration; enabled') }),
  scene('features-mcp-added', 'PB-012', 'Actual MCP installation and expanded configuration', async env => {
    await features(env); await btn(env, '添加连接设置').click(); await expect(env.page.locator('#setup-feature-mcp .plugin-settings')).toBeVisible({ timeout: 90000 });
    await expect(env.page.locator('.feature-state').filter({ hasText: '已添加 · 还需完成设置' })).toHaveCount(1);
  }, { importantStates: exact('PB-012', 'not added; added but needs configuration; enabled', 'installation pending/succeeded/result needs reconciliation', 'expanded MCP/Git configuration; expanded content-search setup') }),
  scene('features-mcp-enabled', 'PB-012', 'Actual enabled optional MCP connection', async env => {
    await features(env); await btn(env, '添加连接设置').click(); const configuration = env.page.locator('#setup-feature-mcp .plugin-settings');
    await expect(configuration).toBeVisible({ timeout: 90000 }); await configuration.getByRole('button', { name: '启用插件', exact: true }).click();
    await expect(env.page.locator('.feature-state').filter({ hasText: '已启用 · 可继续检查设置' })).toHaveCount(1);
  }, { importantStates: exact('PB-012', 'not added; added but needs configuration; enabled') }),
  scene('features-search', 'PB-012', 'Actual expanded content-search setup', async env => {
    await features(env); await btn(env, '设置内容搜索').click(); await expect(env.page.locator('#setup-feature-search')).toBeVisible();
  }, { importantStates: exact('PB-012', 'expanded MCP/Git configuration; expanded content-search setup') }),
  scene('features-read-error', 'PB-012', 'Actual optional-feature registry transport failure leaves skip guidance', async env => {
    await features(env); await expect(env.page.getByRole('alert')).toContainText('可以先跳过'); await expect(btn(env, '暂时跳过')).toBeEnabled();
  }, { before: async env => { await env.page.route('**/api/platform/plugins', route => route.abort('failed')); },
    fault: 'Only optional plugin registry reads fail; real library create/validate/bind requests continue.',
    importantStates: exact('PB-012', 'catalog unavailable; read/install error with skip guidance') }),
  scene('ready', 'PB-013', 'Actual ready summary after real create/validate/bind', async env => {
    await ready(env); await expect(env.page.locator('.ready-summary')).toContainText(env.fixture.knowledgeRoot);
  }, { importantStates: exact('PB-013', 'library location summary') }),
  scene('finish-busy', 'PB-013', 'Actual pending finish request locks leaving actions', async env => {
    await ready(env); await hold(env, '**/api/platform/setup/finish', 'POST'); await btn(env, '进入工作区').click();
    await disabledTextButton(env, '.start-actions', '进入工作区'); await disabledTextButton(env, '.start-actions', '创建第一篇笔记');
  }, { afterCapture: release, fault: 'Hold only actual finish transport before response.', importantStates: exact('PB-013', 'finish busy/error; import busy disables leaving') }),
  scene('finish-error', 'PB-013', 'Actual finish transport failure retains setup summary', async env => {
    await ready(env); await env.page.route('**/api/platform/setup/finish', route => route.abort('failed')); await btn(env, '进入工作区').click();
    await expect(env.page.getByRole('alert')).toBeVisible(); await expect(env.page.locator('.ready-summary')).toBeVisible();
  }, { fault: 'Abort only the actual setup-finish request.', importantStates: exact('PB-013', 'finish busy/error; import busy disables leaving') }),
  scene('first-note-intent', 'PB-013', 'Actual first-note intent transitions into the real workspace create window', async env => {
    await ready(env); await btn(env, '创建第一篇笔记').click(); await expect(env.page.getByRole('dialog', { name: '新建笔记', exact: true })).toBeVisible({ timeout: 30000 });
  }, { target: page => page.getByRole('dialog', { name: '新建笔记', exact: true }), window: true,
    importantStates: exact('PB-013', 'create-first-note intent stored for workspace') }),
  scene('import-empty', 'PB-014', 'Actual single-Markdown import with no file selected', async env => {
    await importPanel(env); await expect(btn(env, '确认导入')).toBeDisabled();
  }, { importantStates: exact('PB-014', 'no file; selection filename/size') }),
  scene('import-selected', 'PB-014', 'Actual selected single-Markdown filename and size', async env => {
    await importPanel(env); await importFile(env); await expect(env.page.locator('.import-selection')).toContainText(state.get(env.page)!.fileName!);
  }, { importantStates: exact('PB-014', 'no file; selection filename/size') }),
  ...(['extension', 'size', 'utf8'] as const).map(type => scene('import-invalid-' + type, 'PB-014', 'Actual single-file ' + type + ' rejection', async env => {
    await importPanel(env); await importFile(env, type); await btn(env, '确认导入').click();
    await expect(env.page.locator('.setup-import [role="alert"]')).toContainText({ extension: '请选择 Markdown', size: '256 KiB', utf8: 'UTF-8' }[type]);
  }, { importantStates: exact('PB-014', 'invalid extension; >256 KiB; invalid UTF-8') })),
  scene('import-busy', 'PB-014', 'Actual pending note import disables leaving without losing source selection', async env => {
    await importPanel(env); await importFile(env); await hold(env, '**/api/notes', 'POST'); await btn(env, '确认导入').click();
    await disabledTextButton(env, '.setup-import', '确认导入'); await disabledTextButton(env, '.start-actions', '进入工作区');
  }, { sourceIds: ['PB-013', 'PB-014'], fault: 'Hold actual imported-note POST after actual folder setup; no success receipt is fulfilled.', afterCapture: release,
    importantStates: { ...exact('PB-014', 'upload busy; success receipt'), ...exact('PB-013', 'finish busy/error; import busy disables leaving') } }),
  scene('import-success', 'PB-014', 'Actual successful single-file import and receipt', async env => {
    await importPanel(env); await importFile(env); await btn(env, '确认导入').click();
    await expect(env.page.locator('.setup-import [role="status"]')).toContainText('已导入');
    await expect(env.page.getByLabel('选择 Markdown 文件', { exact: true })).toHaveValue('');
  }, { importantStates: exact('PB-014', 'upload busy; success receipt') }),
  scene('import-conflict', 'PB-014', 'Actual duplicate import refuses overwrite and retains original bytes', async env => {
    await importPanel(env); await importFile(env); const name = state.get(env.page)!.fileName!;
    await btn(env, '确认导入').click(); await expect(env.page.locator('.setup-import [role="status"]')).toContainText('已导入');
    await env.page.getByLabel('选择 Markdown 文件', { exact: true }).setInputFiles({ name, mimeType: 'text/markdown', buffer: Buffer.from('# 不得覆盖的第二次内容\n') });
    await btn(env, '确认导入').click(); await expect(env.page.locator('.setup-import [role="alert"]')).toContainText('没有覆盖');
    if (await readFile(resolve(env.fixture.knowledgeRoot, '40-Resources', name), 'utf8') !== '# 隔离导入原文\n') throw Error('Actual original import bytes changed unexpectedly');
  }, { importantStates: exact('PB-014', 'same-name conflict never overwrites') }),
  scene('import-network-error', 'PB-014', 'Actual import transport failure retains the selected source file', async env => {
    await importPanel(env); await importFile(env); await env.page.route('**/api/notes', async route => {
      if (route.request().method() === 'POST') await route.abort('failed'); else await route.continue();
    });
    await btn(env, '确认导入').click(); await expect(env.page.locator('.setup-import [role="alert"]')).toContainText('原文件不会被修改');
    await expect(env.page.locator('.import-selection')).toContainText(state.get(env.page)!.fileName!);
  }, { fault: 'Abort only actual note-import POST; no successful imported note is manufactured.', importantStates: exact('PB-014', 'network failure retains source file') }),
  scene('initializing', 'PB-015', 'Actual initializing renderer auto-polls and supports manual progress check', async env => {
    await expect(env.page.getByRole('heading', { name: '正在准备你的知识库', exact: true })).toBeVisible();
    await expect.poll(() => state.get(env.page)?.requests ?? 0, { timeout: 7000 }).toBeGreaterThanOrEqual(2);
  }, { before: async env => { state.set(env.page, { requests: 0 }); await env.page.route('**/api/platform/status', async route => {
    const response = await route.fetch(), actual = await response.json(); state.get(env.page)!.requests!++;
    await route.fulfill({ response, json: { ...actual, phase: 'initializing', setupRequired: false, components: { ...actual.components, knowledge: false } } });
  }); }, fault: 'Actual status is fetched; only its non-ready transient phase is controlled to expose the existing initializing renderer. No binding/success result is replaced.',
    verify: async env => { const before = state.get(env.page)!.requests!; await btn(env, '检查进度').click(); await expect.poll(() => state.get(env.page)!.requests!).toBeGreaterThan(before); return { actualManualRefreshRequested: true }; },
    importantStates: exact('PB-015', 'retained-files reassurance; auto-poll each1.5s', 'manual progress check') }),
  scene('source-unavailable', 'PB-017', 'Actual source-unavailable setup state from a non-directory configured root', async env => {
    await expect(env.page.getByRole('heading', { name: '暂时无法打开知识库', exact: true })).toBeVisible({ timeout: 30000 });
    await env.page.locator('.setup-state summary').click();
    const actual = await env.fixture.api('/api/platform/status');
    if (!['source_unavailable', 'configuration_error'].includes(actual.phase)) throw Error('Actual source failure phase was not produced');
    await expect(env.page.locator('.setup-state details')).toContainText(actual.code || actual.phase);
    if (!String(await readFile(resolve(setup(env).existingRoot, '00-Inbox', '已有资料.md'), 'utf8')).includes('真实首次设置夹具原文')) throw Error('Existing fixture source was changed');
  }, { setupMode: 'source-unavailable', importantStates: exact('PB-017', 'saved data/settings retained', 'details exposes actual status code/phase'),
    verify: async env => { await btn(env, '重新检查').click(); await expect(env.page.getByRole('heading', { name: '暂时无法打开知识库', exact: true })).toBeVisible(); return { actualRecheck: 'same-unavailable-source-preserved' }; } }),
];
