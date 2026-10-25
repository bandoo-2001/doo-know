import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as Vue from 'vue';
import { ApiError } from '../apps/web/api';
import * as sync from '../apps/web/git-sync';
const api = vi.fn();
const refreshPlugins = vi.fn(async () => {});
const registry = Vue.shallowRef({
  installed: [] as any[],
  catalog: [] as any[],
  contributions: [] as any[],
});
const cleanups: (() => void)[] = [];
let rendered: any;
const status = () => ({
  pluginInstalled: true,
  pluginEnabled: true,
  repository: 'ready',
  branch: 'main',
  head: 'a'.repeat(40),
  changes: 1,
  connection: {
    url: 'https://github.com/fixture/notes.git',
    host: 'github.com',
    branch: 'main',
    remoteName: 'origin',
    credentialId: null,
    credentialAvailable: true,
    lastCheckedAt: null,
    remoteHead: null,
    remoteExists: false,
    ahead: null,
    behind: null,
    writeVerified: false,
  },
  discoveredRemotes: [],
  jobs: [],
});
async function mount(file = 'GitRemotePanel.vue', props = {}) {
  const descriptor = parse(
    readFileSync(new URL('../apps/web/components/' + file, import.meta.url), 'utf8'),
    { filename: file },
  ).descriptor;
  const script = compileScript(descriptor, { id: 'git-remote-test' });
  const template = compileTemplate({
    source: descriptor.template!.content,
    filename: file,
    id: 'git-remote-test',
    compilerOptions: { bindingMetadata: script.bindings, hoistStatic: false },
  });
  expect(template.errors).toEqual([]);
  const code = ts.transpileModule(script.content + '\n' + template.code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} as any };
  new Function('require', 'module', 'exports', code)(
    (id: string) => {
      if (id === 'vue') return Vue;
      if (id === 'ant-design-vue')
        return {
          Button: 'button',
          Alert: 'aside',
          Input: 'input',
          Select: 'select',
          AutoComplete: 'input',
          Empty: { render: () => null, PRESENTED_IMAGE_SIMPLE: 'empty' },
          Tabs: { render: () => null },
          TabPane: { render: () => null },
        };
      if (id === '../api') return { api, ApiError };
      if (id === '../plugins') return { pluginRegistry: registry, refreshPlugins };
      if (id === '../git-sync') return sync;
      if (id.endsWith('SettingsActionCard.vue'))
        return {
          default: Vue.defineComponent({
            props: ['actionLabel'],
            emits: ['open'],
            setup:
              (props, { emit }) =>
              () =>
                Vue.h('button', { onClick: () => emit('open') }, props.actionLabel),
          }),
          __esModule: true,
        };
      if (id === '../plugin-drafts')
        return { pluginDrafts: {}, pluginDraftSession: () => 0, storePluginDraft: vi.fn() };
      if (id === '../plugin-config') return { PluginConfigError: class extends Error {} };
      if (id === '../../../packages/plugin-ui/host') return { pluginComponents: new Map() };
      if (id.endsWith('.vue')) return { default: { render: () => null }, __esModule: true };
      throw Error('Unexpected dependency ' + id);
    },
    module,
    module.exports,
  );
  const component = module.exports.default;
  component.render = module.exports.render;
  const renderer = Vue.createRenderer<any, any>({
    insert(node, parent, anchor) {
      parent.children ||= [];
      const previous = node.parent?.children.indexOf(node) ?? -1;
      if (previous >= 0) node.parent.children.splice(previous, 1);
      const index = anchor ? parent.children.indexOf(anchor) : -1;
      parent.children.splice(index < 0 ? parent.children.length : index, 0, node);
      node.parent = parent;
    },
    remove(node) {
      const index = node.parent?.children.indexOf(node) ?? -1;
      if (index >= 0) node.parent.children.splice(index, 1);
    },
    createElement: (tag) => ({
      tag,
      tagName: tag.toUpperCase(),
      children: [],
      props: {},
      options: [],
      getRootNode: () => ({ activeElement: null }),
      addEventListener() {},
      removeEventListener() {},
    }),
    createText: (text) => ({ text }),
    createComment: () => ({}),
    setText(node, text) {
      node.text = text;
    },
    setElementText(node, text) {
      node.text = text;
      node.children = [];
    },
    parentNode: (node) => node.parent || null,
    nextSibling: (node) => node.parent?.children[node.parent.children.indexOf(node) + 1] || null,
    patchProp(node, key, _previous, value) {
      node.props[key] = value;
    },
  });
  const app = renderer.createApp(component, props);
  rendered = { children: [] };
  app.mount(rendered);
  cleanups.push(() => app.unmount());
  await Promise.resolve();
  await Promise.resolve();
  await Vue.nextTick();
  return (app as any)._instance.setupState;
}
function renderedNodes(node: any = rendered): any[] {
  return [node, ...(node.children || []).flatMap(renderedNodes)];
}
function renderedText(node: any = rendered): string {
  return [node.text || '', node.props?.message || '', ...(node.children || []).map(renderedText)]
    .join(' ')
    .trim();
}
function renderedButton(label: string) {
  return renderedNodes().find((node) => node.tag === 'button' && renderedText(node) === label);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function flush() {
  for (let i = 0; i < 8; ++i) await Promise.resolve();
  await Vue.nextTick();
}
beforeEach(() => {
  vi.stubGlobal('Document', class {});
  vi.stubGlobal('ShadowRoot', class {});
  vi.stubGlobal('document', { activeElement: null });
  vi.stubGlobal('window', {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  });
  vi.stubGlobal('localStorage', { setItem: vi.fn(), getItem: vi.fn() });
  vi.stubGlobal('sessionStorage', { setItem: vi.fn(), getItem: vi.fn() });
  sync.gitUnsaved.value = false;
  registry.value = {
    catalog: [],
    contributions: [],
    installed: [
      {
        id: 'git',
        state: 'enabled',
        configVersion: 0,
        config: { authorName: 'Fixture', authorEmail: 'fixture@example.invalid' },
      },
    ],
  };
  api.mockReset();
  refreshPlugins.mockReset().mockResolvedValue(undefined);
  api.mockImplementation(async (url: string) =>
    url.endsWith('/status') ? status() : { items: [] },
  );
});
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('retains connection inputs and gives a safe error when the API rejects a connection', async () => {
  const view = await mount();
  view.url = 'https://github.com/fixture/new.git';
  view.branch = 'draft';
  api.mockImplementation(async (url: string, method: string) => {
    if (method === 'POST')
      throw new ApiError(409, { code: 'GIT_DIVERGED', error: 'private-secret-raw' });
    return url.endsWith('/status') ? status() : { items: [] };
  });
  await view.startJob('connect');
  expect(view.url).toContain('/new.git');
  expect(view.branch).toBe('draft');
  expect(view.error).toContain('分歧');
  expect(view.error).not.toContain('private-secret');
});
it('keeps credential secrets out of all browser persistence and clears them after save', async () => {
  const view = await mount();
  view.credentialName = 'Work';
  view.token = 'secret-token';
  view.username = 'fixture';
  api.mockResolvedValueOnce({ id: 'credential', name: 'Work', host: 'github.com', kind: 'https' });
  await view.saveCredential();
  expect(api).toHaveBeenCalledWith(
    '/api/platform/git/credentials',
    'POST',
    expect.objectContaining({ token: 'secret-token', remember: true }),
  );
  expect(view.token).toBe('');
  expect(localStorage.setItem).not.toHaveBeenCalled();
  expect(sessionStorage.setItem).not.toHaveBeenCalled();
});
it('blocks pull and commit while a note has unsaved changes', async () => {
  const view = await mount();
  sync.gitUnsaved.value = true;
  await view.startJob('pull');
  await view.previewCommit();
  expect(api.mock.calls.filter((call) => call[1] === 'POST')).toEqual([]);
  expect(view.error).toContain('保存');
});
it('resumes an existing unknown job without posting another operation', async () => {
  const unknown = {
    id: 'unknown',
    requestId: 'same',
    kind: 'push',
    status: 'needs_reconciliation',
    phase: 'pushing',
    error: 'GIT_RESULT_UNKNOWN',
  };
  api.mockImplementation(async (url: string) =>
    url.endsWith('/status') ? { ...status(), jobs: [unknown] } : { items: [] },
  );
  const view = await mount();
  expect(view.job.id).toBe('unknown');
  expect(view.job.status).toBe('needs_reconciliation');
  expect(api.mock.calls.filter((call) => call[1] === 'POST')).toEqual([]);
});
it.each(['failed', 'needs_reconciliation'])(
  'refreshes the repository after a retried push becomes %s without displaying a busy projection as missing',
  async (terminalStatus) => {
    vi.useFakeTimers();
    const failed = {
      id: 'same-push',
      requestId: 'same-request',
      kind: 'push',
      status: 'failed',
      phase: 'checking_remote',
      error: 'GIT_AUTH_FAILED',
    };
    let repository = { ...status(), jobs: [failed] };
    const running = { ...failed, status: 'running', error: undefined };
    const terminal = {
      ...failed,
      status: terminalStatus,
      error: terminalStatus === 'failed' ? 'GIT_AUTH_FAILED' : 'GIT_COMMAND_CANCELLED',
    };
    api.mockImplementation(async (url: string, method: string) => {
      if (url.endsWith('/status')) return repository;
      if (url.endsWith('/retry') && method === 'POST') return running;
      if (url.endsWith('/jobs/same-push')) return terminal;
      return { items: [] };
    });
    const view = await mount('GitRemotePanel.vue', { inline: true });
    await view.retryJob();
    repository = {
      ...status(),
      repository: 'missing',
      branch: null,
      head: null,
      connection: null,
      code: 'WORKSPACE_BUSY',
      jobs: [running],
    } as any;
    await view.load();
    await Vue.nextTick();
    expect(renderedText()).toContain('仓库状态待读取');
    expect(renderedText()).not.toContain('尚未初始化');
    expect(renderedText()).not.toContain('尚未关联云端仓库');
    expect(renderedText()).not.toContain('https://github.com/fixture/notes.git');
    expect(renderedButton('关联云端仓库')).toBeUndefined();
    expect(renderedButton('仅推送')).toBeUndefined();
    const nextConnection = {
      ...status().connection,
      url: 'https://gitee.com/fixture/new-binding.git',
      branch: 'next',
    };
    repository = {
      ...status(),
      branch: 'next',
      head: 'b'.repeat(40),
      connection: nextConnection,
      jobs: [terminal],
    };
    await view.poll();
    await Vue.nextTick();
    expect(view.state).toMatchObject({
      branch: 'next',
      head: 'b'.repeat(40),
      connection: nextConnection,
    });
    expect(renderedText()).toContain('https://gitee.com/fixture/new-binding.git');
    expect(renderedText()).not.toContain('https://github.com/fixture/notes.git');
    expect(renderedText()).not.toContain('仓库状态待读取');
    expect(view.error).toBe(
      terminalStatus === 'failed'
        ? '认证失败，请检查令牌或 SSH 密钥。'
        : '已请求取消，任务结果待核对。请先刷新任务或检查云端。',
    );
    expect(view.job).toMatchObject({ id: 'same-push', status: terminalStatus });
    expect(api.mock.calls.filter((call) => call[1] === 'POST')).toEqual([
      ['/api/platform/git/jobs/same-push/retry', 'POST', {}],
    ]);
  },
);
it('retains the task failure when the terminal repository refresh also fails', async () => {
  const view = await mount();
  api.mockImplementation(async (url: string) => {
    if (url.endsWith('/status')) throw new ApiError(503, { code: 'SOURCE_UNAVAILABLE' });
    return { items: [] };
  });
  api.mockClear();
  await view.completed({ id: 'push', kind: 'push', status: 'failed', error: 'GIT_AUTH_FAILED' });
  expect(api.mock.calls.some(([url]) => url.endsWith('/status'))).toBe(true);
  expect(view.error).toBe('认证失败，请检查令牌或 SSH 密钥。');
});
it('ignores a failed receipt refresh after a successful retry of the same task ID', async () => {
  vi.useFakeTimers();
  const failed = {
    id: 'retry-job',
    requestId: 'retry-request',
    kind: 'push',
    status: 'failed',
    phase: 'pushing',
    error: 'GIT_AUTH_FAILED',
  };
  const succeeded = { ...failed, status: 'succeeded', phase: 'complete', error: undefined };
  const oldRefresh = deferred<ReturnType<typeof status>>();
  let current = failed;
  let delayRefresh = false;
  api.mockImplementation(async (url: string, method: string) => {
    if (url.endsWith('/status')) {
      if (delayRefresh) {
        delayRefresh = false;
        return oldRefresh.promise;
      }
      return { ...status(), jobs: [current] };
    }
    if (url.endsWith('/retry') && method === 'POST') {
      current = succeeded as any;
      return { ...failed, status: 'queued', phase: 'queued', error: undefined };
    }
    if (url.endsWith('/jobs/retry-job')) return current;
    return { items: [] };
  });
  const view = await mount('GitRemotePanel.vue', { inline: true });
  delayRefresh = true;
  const refreshing = renderedButton('刷新任务状态').props.onClick();
  await flush();
  expect(view.loading).toBe(true);
  expect(renderedButton('核对并重试任务').props.disabled).toBe(false);
  await renderedButton('核对并重试任务').props.onClick();
  await vi.advanceTimersByTimeAsync(500);
  expect(view.job.status).toBe('succeeded');
  expect(view.error).toBe('');
  expect(view.notice).toBe('已推送提交版本。');
  oldRefresh.resolve({ ...status(), head: 'c'.repeat(40), jobs: [failed] } as any);
  await refreshing;
  await flush();
  expect(view.job.status).toBe('succeeded');
  expect(view.state.head).toBe('a'.repeat(40));
  expect(view.error).toBe('');
  expect(view.notice).toBe('已推送提交版本。');
  expect(renderedText()).not.toContain('认证失败');
});
it.each(['failed receipt', 'poll error', 'SSH host receipt'])(
  'keeps the new task polling and cancellable after an old %s arrives',
  async (response) => {
    vi.useFakeTimers();
    const old = {
      id: 'old-task',
      requestId: 'old-request',
      kind: response === 'SSH host receipt' ? 'ssh-host' : 'push',
      status: 'failed',
      phase: 'checking_remote',
      error: 'GIT_AUTH_FAILED',
    };
    const next = {
      id: 'new-task',
      requestId: 'new-request',
      kind: 'check',
      status: 'running',
      phase: 'checking_remote',
    };
    const oldRead = deferred<any>();
    let current: any = old;
    api.mockImplementation(async (url: string, method: string, body: any) => {
      if (url.endsWith('/status')) return { ...status(), jobs: [current] };
      if (url.endsWith('/jobs/old-task')) return oldRead.promise;
      if (url.endsWith('/jobs') && method === 'POST') {
        current = { ...next, requestId: body.requestId };
        return { ...current, status: 'queued', phase: 'queued' };
      }
      if (url.endsWith('/jobs/new-task')) return current;
      if (url.endsWith('/jobs/new-task/cancel'))
        return (current = { ...current, status: 'cancelled', error: 'GIT_COMMAND_CANCELLED' });
      return { items: [] };
    });
    const view = await mount('GitRemotePanel.vue', { inline: true });
    const refreshing = renderedButton('刷新任务状态').props.onClick();
    await flush();
    expect(renderedButton('检查云端').props.disabled).toBe(false);
    await renderedButton('检查云端').props.onClick();
    await flush();
    view.knownHosts = 'current host entry';
    view.trustHost = true;
    if (response === 'poll error') oldRead.reject(new ApiError(503, { code: 'GIT_AUTH_FAILED' }));
    else
      oldRead.resolve(
        response === 'SSH host receipt'
          ? {
              ...old,
              status: 'succeeded',
              result: { knownHosts: 'old host entry', fingerprints: ['old'] },
            }
          : old,
      );
    await refreshing;
    await flush();
    expect(view.job).toMatchObject({ id: 'new-task', status: 'queued' });
    expect(view.running).toBe(true);
    expect(view.error).toBe('');
    expect(view.knownHosts).toBe('current host entry');
    expect(view.trustHost).toBe(true);
    expect(renderedButton('取消当前任务').props.disabled).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(view.job).toMatchObject({ id: 'new-task', status: 'running' });
    expect(api).toHaveBeenCalledWith('/api/platform/git/jobs/new-task');
    await renderedButton('取消当前任务').props.onClick();
    expect(api).toHaveBeenCalledWith('/api/platform/git/jobs/new-task/cancel', 'POST', {});
    expect(view.job.status).toBe('cancelled');
    expect(view.notice).toContain('任务已取消');
  },
);
it.each(['receipt', 'error'])(
  'ignores a pre-retry %s even when the retried task keeps the same ID',
  async (response) => {
    const failed = {
      id: 'same-task',
      requestId: 'same-request',
      kind: 'push',
      status: 'failed',
      phase: 'pushing',
      error: 'GIT_AUTH_FAILED',
    };
    const oldRead = deferred<any>();
    api.mockImplementation(async (url: string) => {
      if (url.endsWith('/status')) return { ...status(), jobs: [failed] };
      if (url.endsWith('/jobs/same-task')) return oldRead.promise;
      if (url.endsWith('/retry')) return { ...failed, status: 'succeeded', error: undefined };
      return { items: [] };
    });
    const view = await mount('GitRemotePanel.vue', { inline: true });
    const refreshing = renderedButton('刷新任务状态').props.onClick();
    await renderedButton('核对并重试任务').props.onClick();
    expect(view.job.status).toBe('succeeded');
    if (response === 'error') oldRead.reject(new ApiError(503, { code: 'GIT_AUTH_FAILED' }));
    else oldRead.resolve(failed);
    await refreshing;
    await flush();
    expect(view.job.status).toBe('succeeded');
    expect(view.error).toBe('');
    expect(view.notice).toBe('已推送提交版本。');
    expect(renderedButton('核对并重试任务')).toBeUndefined();
  },
);
it('ignores a repository read started before a new task was accepted', async () => {
  vi.useFakeTimers();
  const view = await mount();
  const oldStatus = deferred<ReturnType<typeof status>>();
  api.mockImplementation(async (url: string, method: string, body: any) => {
    if (url.endsWith('/status')) return oldStatus.promise;
    if (method === 'POST')
      return {
        id: 'new-task',
        requestId: body.requestId,
        kind: 'check',
        status: 'queued',
        phase: 'queued',
      };
    return { items: [] };
  });
  const loading = view.load();
  await view.startJob('check');
  oldStatus.resolve({ ...status(), head: 'c'.repeat(40) });
  await loading;
  expect(view.state.head).toBe('a'.repeat(40));
  expect(view.job).toMatchObject({ id: 'new-task', status: 'queued' });
  expect(view.loading).toBe(false);
});
it('keeps the newest receipt when overlapping reads of the same attempt finish out of order', async () => {
  const failed = {
    id: 'same-task',
    requestId: 'same-request',
    kind: 'push',
    status: 'failed',
    phase: 'pushing',
    error: 'GIT_AUTH_FAILED',
  };
  const oldRead = deferred<any>();
  let reads = 0;
  api.mockImplementation(async (url: string) => {
    if (url.endsWith('/status')) return { ...status(), jobs: [failed] };
    if (url.endsWith('/jobs/same-task'))
      return ++reads === 1
        ? oldRead.promise
        : { ...failed, status: 'succeeded', phase: 'complete', error: undefined };
    return { items: [] };
  });
  const view = await mount('GitRemotePanel.vue', { inline: true });
  const old = renderedButton('刷新任务状态').props.onClick();
  await renderedButton('刷新任务状态').props.onClick();
  oldRead.resolve(failed);
  await old;
  await flush();
  expect(view.job.status).toBe('succeeded');
  expect(view.error).toBe('');
  expect(view.notice).toBe('已推送提交版本。');
});
it('keeps polling a cancellation acknowledgement after an older receipt returns', async () => {
  vi.useFakeTimers();
  const running = {
    id: 'cancel-task',
    requestId: 'cancel-request',
    kind: 'check',
    status: 'running',
    phase: 'checking_remote',
  };
  const oldRead = deferred<any>();
  let reads = 0;
  api.mockImplementation(async (url: string) => {
    if (url.endsWith('/status')) return { ...status(), jobs: [running] };
    if (url.endsWith('/cancel')) return running;
    if (url.endsWith('/jobs/cancel-task'))
      return ++reads === 1
        ? oldRead.promise
        : { ...running, status: 'cancelled', error: 'GIT_COMMAND_CANCELLED' };
    return { items: [] };
  });
  const view = await mount('GitRemotePanel.vue', { inline: true });
  const refreshing = renderedButton('刷新任务状态').props.onClick();
  await renderedButton('取消当前任务').props.onClick();
  oldRead.resolve({ ...running, status: 'failed', error: 'GIT_AUTH_FAILED' });
  await refreshing;
  expect(view.job.status).toBe('running');
  expect(view.error).toBe('');
  await vi.advanceTimersByTimeAsync(500);
  await flush();
  expect(view.job.status).toBe('cancelled');
  expect(view.notice).toContain('任务已取消');
  expect(renderedButton('核对并重试任务')).toBeUndefined();
});
it('continues reading a running task after its cancellation response is lost', async () => {
  vi.useFakeTimers();
  const running = {
    id: 'cancel-task',
    requestId: 'cancel-request',
    kind: 'check',
    status: 'running',
    phase: 'checking_remote',
  };
  api.mockImplementation(async (url: string) => {
    if (url.endsWith('/status')) return { ...status(), jobs: [running] };
    if (url.endsWith('/cancel')) throw new ApiError(0, {});
    if (url.endsWith('/jobs/cancel-task'))
      return { ...running, status: 'cancelled', error: 'GIT_COMMAND_CANCELLED' };
    return { items: [] };
  });
  const view = await mount('GitRemotePanel.vue', { inline: true });
  await renderedButton('取消当前任务').props.onClick();
  expect(view.job.status).toBe('running');
  expect(view.busy).toBe(false);
  await vi.advanceTimersByTimeAsync(500);
  expect(view.job.status).toBe('cancelled');
  expect(view.error).toBe('');
  expect(view.notice).toContain('任务已取消');
});
it.each(['poll', 'retry', 'cancel'])(
  'keeps the current task when %s returns a different receipt ID',
  async (operation) => {
    vi.useFakeTimers();
    const current = {
      id: 'owned-task',
      requestId: 'owned-request',
      kind: 'check',
      status: operation === 'retry' ? 'failed' : 'running',
      phase: 'checking_remote',
    };
    api.mockImplementation(async (url: string) => {
      if (url.endsWith('/status')) return { ...status(), jobs: [current] };
      if (url.includes('/jobs/')) return { ...current, id: 'other-task', status: 'succeeded' };
      return { items: [] };
    });
    const view = await mount('GitRemotePanel.vue', { inline: true });
    await view[operation === 'poll' ? 'poll' : operation + 'Job']();
    expect(view.job).toMatchObject({ id: 'owned-task', status: current.status });
    expect(view.error).toContain('结果待核对');
    expect(view.notice).toBe('');
    expect(view.busy).toBe(false);
  },
);
it.each(['found', 'absent', 'unavailable'])(
  'reconciles the original unacknowledged request when its receipt is %s',
  async (result) => {
    vi.useFakeTimers();
    const list = deferred<any>();
    const view = await mount('GitRemotePanel.vue', { inline: true });
    let original: any;
    api.mockImplementation(async (url: string, method: string, body: any) => {
      if (url.endsWith('/status')) return status();
      if (url.endsWith('/jobs') && method === 'POST') {
        original = body;
        throw new ApiError(0, {});
      }
      if (url.endsWith('/jobs')) return list.promise;
      return { items: [] };
    });
    await view.startJob('push');
    expect(view.unresolved).toEqual(original);
    const reconciling = renderedButton('核对请求结果').props.onClick();
    await flush();
    expect(view.running).toBe(true);
    expect(renderedButton('核对请求结果').props.disabled).toBe(true);
    // The same user action cannot issue another job while receipt lookup is pending.
    await view.startJob('check');
    if (result === 'unavailable') list.reject(new ApiError(503, { code: 'SOURCE_UNAVAILABLE' }));
    else
      list.resolve({
        items: [
          { id: 'unrelated', requestId: 'different-request', kind: 'check', status: 'running' },
          ...(result === 'found'
            ? [
                {
                  id: 'accepted-original',
                  requestId: original.requestId,
                  kind: 'push',
                  status: 'queued',
                  phase: 'queued',
                },
              ]
            : []),
        ],
      });
    await reconciling;
    expect(api.mock.calls.filter(([, method]) => method === 'POST')).toHaveLength(1);
    if (result === 'found') {
      expect(view.job).toMatchObject({ id: 'accepted-original', requestId: original.requestId });
      expect(view.unresolved).toBeUndefined();
    } else if (result === 'absent') {
      expect(view.job).toBeUndefined();
      expect(view.unresolved).toBeUndefined();
    } else {
      expect(view.job).toBeUndefined();
      expect(view.unresolved).toEqual(original);
      expect(view.error).toContain('原文目录暂时不可用');
    }
  },
);
it('shows a pending read when first opened during workspace maintenance and can refresh a genuinely missing repository', async () => {
  let repository = {
    ...status(),
    repository: 'missing',
    branch: null,
    head: null,
    connection: null,
    code: 'WORKSPACE_BUSY',
  };
  api.mockImplementation(async (url: string) =>
    url.endsWith('/status') ? repository : { items: [] },
  );
  const view = await mount('GitRemotePanel.vue', { inline: true });
  expect(renderedText()).toContain('仓库状态待读取');
  expect(renderedText()).not.toContain('尚未初始化');
  expect(renderedText()).not.toContain('尚未关联云端仓库');
  expect(renderedButton('关联云端仓库')).toBeUndefined();
  expect(renderedButton('刷新同步状态').props.disabled).toBe(false);
  view.openConnection();
  expect(view.overlay).toBeNull();
  await view.startJob('push');
  expect(api.mock.calls.some(([, method]) => method === 'POST')).toBe(false);
  const information = renderedNodes().find(
    (node) => node.tag === 'aside' && node.props.type === 'info',
  );
  expect(information?.props.message).toContain('任务进行中');
  repository = { ...repository, pluginEnabled: false, code: undefined } as any;
  await view.load();
  await Vue.nextTick();
  expect(view.state.pluginEnabled).toBe(false);
  expect(renderedText()).toContain('尚未初始化');
  expect(renderedText()).toContain('尚未关联云端仓库');
  expect(renderedButton('关联云端仓库')).toBeDefined();
});
it('resumes a running task from the first busy read and refreshes after it fails', async () => {
  vi.useFakeTimers();
  const running = {
    id: 'check',
    requestId: 'check',
    kind: 'check',
    status: 'running',
    phase: 'checking_remote',
  };
  let repository = {
    ...status(),
    repository: 'missing',
    branch: null,
    head: null,
    connection: null,
    code: 'WORKSPACE_BUSY',
    jobs: [running],
  };
  api.mockImplementation(async (url: string) => {
    if (url.endsWith('/status')) return repository;
    if (url.endsWith('/jobs/check'))
      return { ...running, status: 'failed', error: 'GIT_AUTH_FAILED' };
    return { items: [] };
  });
  const view = await mount('GitRemotePanel.vue', { inline: true });
  expect(view.job.id).toBe('check');
  repository = status() as any;
  await vi.advanceTimersByTimeAsync(500);
  await Vue.nextTick();
  expect(view.state.branch).toBe('main');
  expect(renderedText()).toContain('https://github.com/fixture/notes.git');
  expect(renderedText()).not.toContain('仓库状态待读取');
  expect(view.error).toContain('认证失败');
});
it('disables an open commit review until busy repository state can be read again', async () => {
  const view = await mount('GitRemotePanel.vue', { inline: true });
  view.openReview();
  view.message = 'Saved change';
  api.mockResolvedValueOnce({ token: 'preview', changes: [], diff: '' });
  await view.previewCommit();
  api.mockImplementation(async (url: string) =>
    url.endsWith('/status')
      ? {
          ...status(),
          repository: 'missing',
          branch: null,
          head: null,
          connection: null,
          code: 'WORKSPACE_BUSY',
        }
      : { items: [] },
  );
  await view.load();
  await Vue.nextTick();
  expect(renderedButton('重新预览本次提交').props.disabled).toBe(true);
  expect(renderedButton('确认提交并推送').props.disabled).toBe(true);
  api.mockClear();
  await view.previewCommit();
  await view.confirmCommit();
  expect(api.mock.calls).toEqual([]);
});
it('shows a real disconnect after the task refresh instead of retaining the old connection', async () => {
  const view = await mount('GitRemotePanel.vue', { inline: true });
  api.mockImplementation(async (url: string) =>
    url.endsWith('/status') ? { ...status(), connection: null } : { items: [] },
  );
  await view.completed({
    id: 'disconnect',
    kind: 'disconnect',
    status: 'succeeded',
    phase: 'complete',
  });
  await Vue.nextTick();
  expect(view.state.branch).toBe('main');
  expect(view.connection).toBeNull();
  expect(renderedText()).toContain('尚未关联云端仓库');
  expect(renderedText()).not.toContain('https://github.com/fixture/notes.git');
  expect(renderedButton('关联云端仓库')).toBeDefined();
});
it('displays a confirmed cancellation without a failure or restart alert and refreshes repository state', async () => {
  vi.useFakeTimers();
  const running = {
    id: 'check',
    requestId: 'check',
    kind: 'check',
    status: 'running',
    phase: 'checking_remote',
  };
  api.mockImplementation(async (url: string) => {
    if (url.endsWith('/status')) return { ...status(), jobs: [running] };
    if (url.endsWith('/cancel'))
      return { ...running, status: 'cancelled', error: 'GIT_COMMAND_CANCELLED' };
    return { items: [] };
  });
  const view = await mount('GitRemotePanel.vue', { inline: true });
  view.error = '旧的任务错误';
  api.mockClear();
  await view.cancelJob();
  await Vue.nextTick();
  expect(view.job.status).toBe('cancelled');
  expect(view.error).toBe('');
  expect(view.notice).toContain('任务已取消');
  expect(api.mock.calls.some(([url]) => url.endsWith('/status'))).toBe(true);
  expect(renderedText()).toContain('任务已取消');
  expect(renderedText()).not.toContain('重启');
  expect(renderedText()).not.toContain('任务未完成');
  expect(renderedButton('核对并重试任务')).toBeUndefined();
  expect(renderedNodes().some((node) => node.props?.role === 'alert')).toBe(false);
});
it('keeps an uncertain cancelled write in reconciliation without claiming cancellation completed', async () => {
  const view = await mount('GitRemotePanel.vue', { inline: true });
  await view.completed({
    id: 'push',
    kind: 'push',
    status: 'needs_reconciliation',
    phase: 'pushing',
    error: 'GIT_COMMAND_CANCELLED',
  });
  await Vue.nextTick();
  expect(view.error).toBe('已请求取消，任务结果待核对。请先刷新任务或检查云端。');
  expect(view.notice).toBe('');
  expect(renderedText()).toContain('结果待核对');
  expect(renderedButton('核对并重试任务')).toBeDefined();
  expect(renderedText()).not.toContain('任务已取消');
});
it('keeps a successful commit after push failure and retries push without another commit', async () => {
  const view = await mount();
  const commit = 'b'.repeat(40);
  api.mockImplementation(async (url: string, method: string, body: any) => {
    if (url.endsWith('/call') && body.id === 'git.preview')
      return { token: 'preview', changes: [{ path: 'one.md', status: 'M' }], diff: 'safe diff' };
    if (url.endsWith('/call') && body.id === 'git.commit') return { commit };
    if (url.endsWith('/jobs') && method === 'POST')
      return {
        id: 'push',
        requestId: body.requestId,
        kind: 'push',
        status: 'failed',
        phase: 'pushing',
        error: 'GIT_NETWORK_FAILED',
      };
    return url.endsWith('/status') ? status() : { items: [] };
  });
  view.message = 'Update';
  await view.previewCommit();
  await view.confirmCommit();
  expect(view.committedHead).toBe(commit);
  expect(view.error).toContain('网络');
  await view.startJob('push');
  expect(api.mock.calls.filter((call) => call[2]?.id === 'git.commit')).toHaveLength(1);
  expect(
    api.mock.calls
      .filter((call) => call[0].endsWith('/jobs') && call[1] === 'POST')
      .map((call) => call[2].expectedHead),
  ).toEqual([commit, commit]);
});
it('retries an unacknowledged commit using its original preview and request ID', async () => {
  const view = await mount();
  api.mockImplementation(async (url: string, _method: string, body: any) => {
    if (body?.id === 'git.preview') return { token: 'fixed-preview', changes: [], diff: '' };
    if (body?.id === 'git.commit') throw new ApiError(0, {});
    return url.endsWith('/status') ? status() : { items: [] };
  });
  view.message = 'Update';
  await view.previewCommit();
  await view.confirmCommit();
  await view.confirmCommit();
  const calls = api.mock.calls.filter((call) => call[2]?.id === 'git.commit');
  expect(calls).toHaveLength(2);
  expect(calls[0][2].input).toEqual(calls[1][2].input);
  await view.previewCommit();
  expect(api.mock.calls.filter((call) => call[2]?.id === 'git.preview')).toHaveLength(1);
});
it('requires explicit SSH host trust and sends secrets only to the credential endpoint', async () => {
  const view = await mount();
  view.credentialName = 'SSH';
  view.credentialKind = 'ssh';
  view.privateKey = 'private-key';
  view.knownHosts = 'github.com ssh-ed25519 AAAA';
  await view.saveCredential();
  expect(api.mock.calls.filter((call) => call[1] === 'POST')).toHaveLength(0);
  expect(view.error).toContain('确认信任');
  view.trustHost = true;
  api.mockResolvedValueOnce({ id: 'ssh', name: 'SSH', host: 'github.com', kind: 'ssh' });
  await view.saveCredential();
  expect(api.mock.calls.find((call) => call[1] === 'POST')?.[0]).toBe(
    '/api/platform/git/credentials',
  );
  expect(view.privateKey).toBe('');
  expect(localStorage.setItem).not.toHaveBeenCalled();
});
it('posts import location and branch without putting secrets into its clone job', async () => {
  const view = await mount('GitRemotePanel.vue', { mode: 'import', timeZone: 'UTC' });
  view.url = ' https://gitee.com/fixture/notes.git ';
  view.name = '中文知识库';
  view.parentPath = '/allowed/中文资料';
  view.branch = 'reading';
  view.credentialId = 'credential';
  view.token = 'must-never-enter-job';
  api.mockResolvedValueOnce({
    id: 'clone',
    requestId: 'clone-request',
    kind: 'clone',
    status: 'running',
    phase: 'cloning',
  });
  await view.startJob('clone');
  const body = api.mock.calls.find((call) => call[1] === 'POST')![2];
  expect(body).toMatchObject({
    kind: 'clone',
    name: '中文知识库',
    parentPath: '/allowed/中文资料',
    branch: 'reading',
    credentialId: 'credential',
    timeZone: 'UTC',
  });
  expect(JSON.stringify(body)).not.toContain('must-never-enter-job');
});
it('offers remote onboarding while keeping local setup modes independent', async () => {
  const view = await mount('SetupWizard.vue', { status: { phase: 'setup_required' } });
  const buttons = (node: any): any[] => [
    ...(node.tag === 'button' ? [node] : []),
    ...(node.children || []).flatMap(buttons),
  ];
  const remote = buttons(rendered).find(
    (button) => button.props['aria-label'] === '从 GitHub／Gitee 导入',
  );
  expect(remote).toBeDefined();
  await remote.props.onClick();
  expect(view.mode).toBe('remote');
  await view.complete();
  expect(api.mock.calls.filter((call) => call[1] === 'POST')).toHaveLength(0);
  await view.selectMode('new');
  expect(view.mode).toBe('new');
  expect(
    api.mock.calls.filter((call) => call[0].includes('/plugins/') || call[0].includes('/git/')),
  ).toHaveLength(0);
});
it('resumes a slow installation for longer than the request timeout without another install POST', async () => {
  vi.useFakeTimers();
  const installing = {
    id: 'slow',
    pluginId: 'git',
    version: '1.1.0',
    status: 'running',
    phase: 'downloading',
  };
  let finished = false;
  const fetch = vi.fn(
    async (url: string) =>
      new Response(
        JSON.stringify(
          url.endsWith('/plugin-installations')
            ? { items: [installing] }
            : finished
              ? { ...installing, status: 'succeeded', phase: 'complete' }
              : installing,
        ),
        { headers: { 'content-type': 'application/json' } },
      ),
  );
  vi.stubGlobal('fetch', fetch);
  const onUpdate = vi.fn();
  const work = sync.installPlugin('git', { onUpdate });
  await vi.advanceTimersByTimeAsync(16000);
  expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ phase: 'downloading' }));
  expect(fetch.mock.calls.length).toBeGreaterThan(20);
  finished = true;
  await vi.advanceTimersByTimeAsync(500);
  await work;
  expect(onUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'succeeded' }));
  expect(fetch.mock.calls.filter((call: any[]) => call[1]?.method === 'POST')).toHaveLength(0);
});
it('reconciles a lost installation response before polling its accepted receipt', async () => {
  vi.useFakeTimers();
  const accepted = {
    id: 'receipt',
    pluginId: 'git',
    version: '1.1.0',
    requestId: '',
    status: 'running',
    phase: 'verifying',
  };
  let lists = 0;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/csrf')) return new Response(JSON.stringify({ token: 'csrf' }));
    if (init?.method === 'POST') {
      accepted.requestId = JSON.parse(String(init.body)).requestId;
      throw new TypeError('response lost');
    }
    if (url.endsWith('/plugin-installations'))
      return new Response(JSON.stringify({ items: ++lists === 1 ? [] : [accepted] }));
    return new Response(JSON.stringify({ ...accepted, status: 'succeeded', phase: 'complete' }));
  });
  vi.stubGlobal('fetch', fetch);
  const work = sync.installPlugin('git');
  await vi.advanceTimersByTimeAsync(500);
  await work;
  expect(lists).toBe(2);
  expect(fetch.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(1);
});

it('keeps the onboarding skip guidance after a plugin installation failure', async () => {
  const view = await mount('SetupFeatures.vue');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/csrf')) return new Response(JSON.stringify({ token: 'csrf' }));
      if (init?.method === 'POST')
        return new Response(JSON.stringify({ code: 'PLUGIN_INSTALL_FAILED' }), { status: 503 });
      return new Response(JSON.stringify({ items: [] }));
    }),
  );
  await view.configure('mcp');
  expect(view.error).toContain('可以先跳过');
  expect(view.busy).toBe('');
});

it('publishes a workspace-wide change after pull and explains a pending index refresh', async () => {
  const view = await mount();
  await view.completed({
    id: 'pull',
    kind: 'pull',
    requestId: 'pull',
    status: 'succeeded',
    phase: 'complete',
    result: { indexRefreshPending: true },
  });
  expect(view.notice).toContain('待刷新');
  expect(view.notice).not.toContain('索引已刷新');
  const event = vi
    .mocked(window.dispatchEvent)
    .mock.calls.find(([event]) => event.type === 'dooknow-workspace-changed')![0];
  expect((event as CustomEvent).detail).toEqual({ scope: 'workspace' });
});

it.each([
  ['SetupFeatures.vue', 'succeeded'],
  ['SetupFeatures.vue', 'failed'],
  ['PluginManager.vue', 'succeeded'],
  ['PluginManager.vue', 'failed'],
] as const)(
  '%s resumes the original installation when it becomes %s between mount lookup and polling',
  async (file, status) => {
    const pending = {
      id: 'race',
      pluginId: 'git',
      version: '1.1.0',
      status: 'running',
      phase: 'downloading',
    };
    const terminal = {
      ...pending,
      status,
      phase: status === 'succeeded' ? 'complete' : 'verifying',
      ...(status === 'failed' ? { error: 'PLUGIN_INSTALL_FAILED' } : {}),
    };
    api.mockImplementation(async (url: string) =>
      url.endsWith('/plugin-installations') ? { items: [pending] } : { items: [] },
    );
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/csrf')) return new Response(JSON.stringify({ token: 'csrf' }));
      if (init?.method === 'POST')
        return new Response(JSON.stringify({ ...terminal, id: 'duplicate' }));
      return new Response(
        JSON.stringify(url.endsWith('/plugin-installations') ? { items: [terminal] } : terminal),
      );
    });
    vi.stubGlobal('fetch', fetch);
    const view = await mount(file);
    await vi.waitFor(() => expect(view.installation?.status).toBe(status));
    expect(fetch.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(0);
    expect(view.installation.id).toBe('race');
    expect(fetch.mock.calls.map((call) => call[0])).toEqual([
      '/api/platform/plugin-installations/race',
    ]);
    if (status === 'failed') expect(view.installation.error).toBe('PLUGIN_INSTALL_FAILED');
  },
);

it('notifies the workspace after successful pull even when the panel closes during its status refresh', async () => {
  const view = await mount();
  let finish!: (value: ReturnType<typeof status>) => void;
  const pending = new Promise<ReturnType<typeof status>>((resolve) => {
    finish = resolve;
  });
  api.mockImplementation(async (url: string) =>
    url.endsWith('/status') ? pending : { items: [] },
  );
  const completed = view.completed({
    id: 'pull-closed',
    kind: 'pull',
    requestId: 'pull-closed',
    status: 'succeeded',
    phase: 'complete',
    result: {},
  });
  cleanups.pop()!();
  finish(status());
  await completed;
  expect(
    vi
      .mocked(window.dispatchEvent)
      .mock.calls.some(([event]) => event.type === 'dooknow-workspace-changed'),
  ).toBe(true);
});

it.each([
  ['knowledgeRoot', 'status'],
  ['boundKnowledgeRoot', 'status'],
  ['knowledgeRoot', 'plugins'],
] as const)(
  'notifies an accepted clone once after a newer task starts during its %s %s refresh',
  async (rootField, waiting) => {
    vi.useFakeTimers();
    const clone = {
      id: 'import-clone',
      requestId: 'clone-request',
      kind: 'clone',
      status: 'running',
      phase: 'cloning',
    };
    const oldRefresh = deferred<ReturnType<typeof status>>();
    const pluginRefresh = deferred<void>();
    const imported = vi.fn();
    const changed = vi.fn();
    let holdStatus = false;
    let current: any = clone;
    api.mockImplementation(async (url: string, method: string, body: any) => {
      if (url.endsWith('/status')) {
        if (holdStatus) {
          holdStatus = false;
          return oldRefresh.promise;
        }
        return { ...status(), jobs: [current] };
      }
      if (url.endsWith('/jobs/import-clone'))
        return {
          ...clone,
          status: 'succeeded',
          phase: 'complete',
          result: { [rootField]: '/fixture/imported-knowledge' },
        };
      if (url.endsWith('/jobs') && method === 'POST') {
        current = {
          id: 'new-test',
          requestId: body.requestId,
          kind: 'test',
          status: 'running',
          phase: 'testing_connection',
        };
        return { ...current, status: 'queued', phase: 'queued' };
      }
      if (url.endsWith('/jobs/new-test')) return current;
      return { items: [] };
    });
    const view = await mount('GitRemotePanel.vue', {
      mode: 'import',
      inline: true,
      onImported: imported,
      onChanged: changed,
    });
    if (waiting === 'plugins') refreshPlugins.mockReturnValueOnce(pluginRefresh.promise);
    else holdStatus = true;
    const completing = renderedButton('刷新任务状态').props.onClick();
    await flush();
    expect(view.job.status).toBe('succeeded');
    expect(renderedButton('测试读取连接').props.disabled).toBe(false);
    await renderedButton('测试读取连接').props.onClick();
    expect(view.job).toMatchObject({ id: 'new-test', status: 'queued' });
    if (waiting === 'plugins') pluginRefresh.resolve();
    else oldRefresh.resolve({ ...status(), head: 'c'.repeat(40), jobs: [clone] } as any);
    await completing;
    await flush();
    expect(imported).toHaveBeenCalledExactlyOnceWith('/fixture/imported-knowledge');
    expect(changed).toHaveBeenCalledTimes(1);
    expect(view.job).toMatchObject({ id: 'new-test', status: 'queued' });
    expect(view.state.head).toBe('a'.repeat(40));
    expect(view.error).toBe('');
    expect(view.notice).toBe('');
    await vi.advanceTimersByTimeAsync(500);
    expect(view.job).toMatchObject({ id: 'new-test', status: 'running' });
    expect(api).toHaveBeenCalledWith('/api/platform/git/jobs/new-test');
    expect(imported).toHaveBeenCalledTimes(1);
  },
);

it('does not notify an import from a clone receipt superseded before acceptance', async () => {
  vi.useFakeTimers();
  const clone = {
    id: 'old-clone',
    requestId: 'clone-request',
    kind: 'clone',
    status: 'failed',
    phase: 'cloning',
    error: 'GIT_NETWORK_FAILED',
  };
  const receipt = deferred<any>();
  const imported = vi.fn();
  const changed = vi.fn();
  api.mockImplementation(async (url: string, method: string, body: any) => {
    if (url.endsWith('/status')) return { ...status(), jobs: [clone] };
    if (url.endsWith('/jobs/old-clone')) return receipt.promise;
    if (url.endsWith('/jobs') && method === 'POST')
      return {
        id: 'new-test',
        requestId: body.requestId,
        kind: 'test',
        status: 'queued',
        phase: 'queued',
      };
    return { items: [] };
  });
  const view = await mount('GitRemotePanel.vue', {
    mode: 'import',
    inline: true,
    onImported: imported,
    onChanged: changed,
  });
  const oldRead = renderedButton('刷新任务状态').props.onClick();
  await renderedButton('测试读取连接').props.onClick();
  receipt.resolve({
    ...clone,
    status: 'succeeded',
    phase: 'complete',
    result: { knowledgeRoot: '/fixture/old-import' },
  });
  await oldRead;
  expect(view.job).toMatchObject({ id: 'new-test', status: 'queued' });
  expect(imported).not.toHaveBeenCalled();
  expect(changed).not.toHaveBeenCalled();
  expect(refreshPlugins).not.toHaveBeenCalled();
});

it('emits an import once when an accepted clone receipt is read again during its refresh', async () => {
  const clone = {
    id: 'repeat-clone',
    requestId: 'clone-request',
    kind: 'clone',
    status: 'running',
    phase: 'cloning',
  };
  const refresh = deferred<any>();
  const imported = vi.fn();
  let holdStatus = false;
  api.mockImplementation(async (url: string) => {
    if (url.endsWith('/status')) {
      if (holdStatus) {
        holdStatus = false;
        return refresh.promise;
      }
      return { ...status(), jobs: [clone] };
    }
    if (url.endsWith('/jobs/repeat-clone'))
      return {
        ...clone,
        status: 'succeeded',
        phase: 'complete',
        result: { knowledgeRoot: '/fixture/imported-once' },
      };
    return { items: [] };
  });
  await mount('GitRemotePanel.vue', { onImported: imported });
  holdStatus = true;
  const first = renderedButton('刷新任务状态').props.onClick();
  await flush();
  await renderedButton('刷新任务状态').props.onClick();
  expect(imported).toHaveBeenCalledExactlyOnceWith('/fixture/imported-once');
  refresh.resolve(status());
  await first;
  expect(imported).toHaveBeenCalledTimes(1);
});

it('does not emit import navigation after unmount during an accepted clone refresh', async () => {
  const clone = {
    id: 'closed-clone',
    requestId: 'clone-request',
    kind: 'clone',
    status: 'running',
    phase: 'cloning',
  };
  const refresh = deferred<any>();
  const imported = vi.fn();
  const changed = vi.fn();
  let holdStatus = false;
  api.mockImplementation(async (url: string) => {
    if (url.endsWith('/status'))
      return holdStatus ? refresh.promise : { ...status(), jobs: [clone] };
    if (url.endsWith('/jobs/closed-clone'))
      return {
        ...clone,
        status: 'succeeded',
        phase: 'complete',
        result: { knowledgeRoot: '/fixture/closed-import' },
      };
    return { items: [] };
  });
  await mount('GitRemotePanel.vue', { onImported: imported, onChanged: changed });
  holdStatus = true;
  const completing = renderedButton('刷新任务状态').props.onClick();
  await flush();
  cleanups.pop()!();
  refresh.resolve(status());
  await completing;
  expect(imported).not.toHaveBeenCalled();
  expect(changed).not.toHaveBeenCalled();
});

it('returns from an inline Git panel through exactly one direct event', async () => {
  const returned = vi.fn();
  const view = await mount('GitRemotePanel.vue', { inline: true, onReturnSave: returned });
  await view.returnSave();
  expect(returned).toHaveBeenCalledTimes(1);
  expect(window.dispatchEvent).not.toHaveBeenCalled();
});

it('returns from a standalone Git panel through exactly one global event', async () => {
  const returned = vi.fn();
  const view = await mount('GitRemotePanel.vue', { onReturnSave: returned });
  await view.returnSave();
  expect(returned).not.toHaveBeenCalled();
  expect(window.dispatchEvent).toHaveBeenCalledTimes(1);
  expect(vi.mocked(window.dispatchEvent).mock.calls[0][0].type).toBe('dooknow-git-return-save');
});

it('guards a dirty connection before returning and cancels the pending navigation when editing continues', async () => {
  let view: any;
  const returned = vi.fn(() => expect(view.panelDirty).toBe(false));
  view = await mount('GitRemotePanel.vue', { inline: true, onReturnSave: returned });
  const originalURL = view.url,
    originalBranch = view.branch;
  view.openConnection();
  view.url = 'https://github.com/fixture/unsaved-connection.git';
  view.branch = 'unsaved-branch';
  await view.returnSave();
  expect(view.discardOpen).toBe(true);
  expect(returned).not.toHaveBeenCalled();
  expect(window.dispatchEvent).not.toHaveBeenCalled();
  view.cancelDiscard();
  expect(view.discardOpen).toBe(false);
  expect(view.url).toBe('https://github.com/fixture/unsaved-connection.git');
  expect(view.branch).toBe('unsaved-branch');
  // A later ordinary back action must not inherit the cancelled return-to-note intent.
  view.requestBack();
  await view.confirmDiscard();
  expect(view.overlay).toBeNull();
  expect(returned).not.toHaveBeenCalled();
  expect(window.dispatchEvent).not.toHaveBeenCalled();
  view.openConnection();
  view.url = 'https://github.com/fixture/another-connection.git';
  await view.returnSave();
  const finishing = view.confirmDiscard();
  expect(returned).not.toHaveBeenCalled();
  await finishing;
  await Vue.nextTick();
  expect(view.url).toBe(originalURL);
  expect(view.branch).toBe(originalBranch);
  expect(view.panelDirty).toBe(false);
  expect(returned).toHaveBeenCalledTimes(1);
  expect(window.dispatchEvent).not.toHaveBeenCalled();
});

it('discards nested credential and connection drafts before returning to the note once', async () => {
  let view: any;
  const returned = vi.fn(() => expect(view.panelDirty).toBe(false));
  view = await mount('GitRemotePanel.vue', { inline: true, onReturnSave: returned });
  const originalURL = view.url,
    originalBranch = view.branch;
  view.openConnection();
  view.url = 'https://github.com/fixture/unsaved-parent.git';
  view.branch = 'unsaved-parent-branch';
  view.editCredential();
  view.credentialName = 'Unsaved child';
  view.token = 'unsaved-disposable-token';
  await view.returnSave();
  expect(view.discardOpen).toBe(true);
  expect(returned).not.toHaveBeenCalled();
  view.cancelDiscard();
  expect(view.token).toBe('unsaved-disposable-token');
  expect(view.url).toBe('https://github.com/fixture/unsaved-parent.git');
  await view.returnSave();
  const finishing = view.confirmDiscard();
  expect(returned).not.toHaveBeenCalled();
  await finishing;
  await Vue.nextTick();
  expect(view.overlay).toBeNull();
  expect(view.token).toBe('');
  expect(view.url).toBe(originalURL);
  expect(view.branch).toBe(originalBranch);
  expect(view.panelDirty).toBe(false);
  expect(returned).toHaveBeenCalledTimes(1);
  expect(window.dispatchEvent).not.toHaveBeenCalled();
});
