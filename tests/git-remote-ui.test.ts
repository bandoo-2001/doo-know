import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as Vue from 'vue';
import { ApiError } from '../apps/web/api';
import * as sync from '../apps/web/git-sync';
const api = vi.fn();
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
        };
      if (id === '../api') return { api, ApiError };
      if (id === '../plugins') return { pluginRegistry: registry, refreshPlugins: async () => {} };
      if (id === '../git-sync') return sync;
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
