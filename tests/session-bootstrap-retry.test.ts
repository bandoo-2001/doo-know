import { readFileSync } from 'node:fs';
import { parse, compileScript } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as Vue from 'vue';
import * as AppShortcuts from '../apps/web/app-shortcuts';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiError, api as requestAPI } from '../apps/web/api';
import type { PlatformStatus } from '../shared/platform-contracts';

const api = vi.fn(), csrf = vi.fn();
const descriptor = parse(readFileSync(new URL('../apps/web/App.vue', import.meta.url), 'utf8')).descriptor;
const source = ts.transpileModule(compileScript(descriptor, { id: 'session-bootstrap-retry' }).content, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const owner = { user: { id: 'retained-owner', name: 'Retained owner' } };
const platform: PlatformStatus = {
  phase: 'ready', setupRequired: false, configurationSource: 'application',
  knowledgeRoot: '/isolated/library', timeZone: 'UTC', bindingVersion: 1,
  onboardingRequired: false, components: { knowledge: true, search: true },
};
let state: any, app: ReturnType<ReturnType<typeof Vue.createRenderer>['createApp']> | undefined;
beforeEach(() => {
  api.mockReset(); csrf.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('location', { pathname: '/', search: '' });
  vi.stubGlobal('window', new EventTarget());
});
afterEach(() => { app?.unmount(); app = undefined; vi.unstubAllGlobals(); });
async function mount(waitUntilReady = true) {
  const output: { exports: any } = { exports: {} };
  new Function('require', 'module', 'exports', source)((id: string) => {
    if (id === 'vue') return Vue;
    if (id === './api') return { api, ApiError, refreshCsrf: csrf, resetCsrf() {} };
    if (id === './preferences') return { resolvedTheme: Vue.ref('light'), initializeEditorPreferences() {} };
    if (id === './app-shortcuts') return AppShortcuts;
    if (id === './plugin-drafts') return { clearPluginDrafts() {}, hasUnsavedPluginDrafts: () => false };
    if (id === './plugins') return { disposePluginUIs: async () => {} };
    if (id === './ant-design') return { antTheme: {} };
    if (id === 'naive-ui' || id === 'ant-design-vue') return {};
    if (id === 'ant-design-vue/es/locale/zh_CN' || id.endsWith('.vue')) return { default: {}, __esModule: true };
    throw Error('Unexpected App dependency: ' + id);
  }, output, output.exports);
  const component = output.exports.default, setup = component.setup;
  component.setup = (props: any, ctx: any) => { state = setup(props, ctx); return state; };
  component.render = () => null;
  const renderer = Vue.createRenderer<any, any>({ insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null, patchProp() {} });
  app = renderer.createApp(component); app.mount({});
  if (waitUntilReady) await vi.waitFor(() => expect(state.ready.value).toBe(true));
}
const checks = () => api.mock.calls.filter(([url]) => url === '/api/auth/get-session').length;
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

it.each(['csrf', 'platform'] as const)(
  'overlaps initial safety reads but keeps the workspace closed until %s finishes last',
  async (last) => {
    const security = deferred<void>(), service = deferred<PlatformStatus>();
    csrf.mockImplementation(() => security.promise);
    api.mockImplementation(async (url: string) => url === '/api/auth/get-session' ? owner : service.promise);
    await mount(false);
    try {
      await vi.waitFor(() => expect(api.mock.calls.filter(([url]) => url === '/api/platform/status')).toHaveLength(1));
      expect(state.mountedWorkspace.value).toBe(false);
      if (last === 'csrf') service.resolve(platform);
      else security.resolve();
      await turn();
      expect(state.mountedWorkspace.value).toBe(false);
      expect(state.ready.value).toBe(false);
      if (last === 'csrf') expect(state.ownerId.value).toBe('');
    } finally {
      security.resolve(); service.resolve(platform);
      await vi.waitFor(() => expect(state.ready.value).toBe(true));
    }
    expect(state.ownerId.value).toBe('retained-owner');
    expect(state.mountedWorkspace.value).toBe(true);
  },
);

it('a status reply from a security-failed attempt cannot replace a newer owner or library', async () => {
  const oldStatus = deferred<PlatformStatus>();
  const newer = { ...platform, knowledgeRoot: '/isolated/newer-library', bindingVersion: 2 };
  let attempts = 0;
  api.mockImplementation(async (url: string) => {
    if (url === '/api/auth/get-session') return ++attempts === 1 ? owner : { user: { id: 'newer-owner', name: 'Newer owner' } };
    return attempts === 1 ? oldStatus.promise : newer;
  });
  csrf.mockRejectedValueOnce(new ApiError(503, { error: 'Security unavailable' }));
  await mount();
  expect(state.mountedWorkspace.value).toBe(false);
  expect(state.ownerId.value).toBe('');
  await state.checkInitialSession();
  oldStatus.resolve({ ...platform, knowledgeRoot: '/isolated/obsolete-library' });
  await turn();
  expect(state.ownerId.value).toBe('newer-owner');
  expect(state.platform.value.knowledgeRoot).toBe('/isolated/newer-library');
  expect(state.mountedWorkspace.value).toBe(true);
});

it('never preloads private platform state for a session without an owner id', async () => {
  api.mockImplementation(async (url: string) => {
    if (url === '/api/auth/get-session') return { user: { name: 'Unconfirmed identity' } };
    throw Error('Private state must not be requested');
  });
  await mount();
  expect(api.mock.calls.filter(([url]) => url === '/api/platform/status')).toHaveLength(0);
  expect(state.ownerId.value).toBe('');
  expect(state.mountedWorkspace.value).toBe(false);
});

it('a failed safety check never mounts a workspace when the parallel service read also fails', async () => {
  api.mockImplementation(async (url: string) => {
    if (url === '/api/auth/get-session') return owner;
    throw new ApiError(503, { error: 'Platform unavailable' });
  });
  csrf.mockRejectedValue(new ApiError(503, { error: 'Security unavailable' }));
  await mount();
  await turn();
  expect(state.sessionCheckError.value).not.toBe('');
  expect(state.ownerId.value).toBe('');
  expect(state.mountedWorkspace.value).toBe(false);
});

it('a session lost during the parallel read still requests reauthentication after safety initialization', async () => {
  const security = deferred<void>();
  let notifications = 0;
  window.addEventListener('dooknow-session-expired', () => { notifications++; });
  const fetchStatus = vi.fn(async () => new Response(JSON.stringify({ error: 'Session expired' }), { status: 401 }));
  vi.stubGlobal('fetch', fetchStatus);
  csrf.mockImplementation(() => security.promise);
  api.mockImplementation(async (url: string, method?: string, body?: unknown, options?: Parameters<typeof requestAPI>[3]) =>
    url === '/api/auth/get-session' ? owner : requestAPI(url, method, body, options));
  await mount(false);
  try {
    await vi.waitFor(() => expect(fetchStatus).toHaveBeenCalledTimes(1));
    expect(state.loggedIn.value).toBe(false);
    expect(state.mountedWorkspace.value).toBe(false);
  } finally {
    security.resolve();
    await vi.waitFor(() => expect(state.ready.value).toBe(true));
  }
  expect(state.expired.value).toBe(true);
  expect(notifications).toBe(1);
  expect(state.mountedWorkspace.value).toBe(false);
});

it('an abandoned status request cannot expire a newer successful login when its 401 arrives late', async () => {
  const obsolete = deferred<Response>();
  const fetchStatus = vi.fn().mockImplementationOnce(() => obsolete.promise).mockResolvedValue(
    new Response(JSON.stringify({ ...platform, knowledgeRoot: '/isolated/newer-library' })),
  );
  vi.stubGlobal('fetch', fetchStatus);
  let attempts = 0, staleRead: Promise<unknown> | undefined;
  api.mockImplementation((url: string, method?: string, body?: unknown, options?: Parameters<typeof requestAPI>[3]) => {
    if (url === '/api/auth/get-session') return Promise.resolve(++attempts === 1 ? owner : { user: { id: 'newer-owner', name: 'Newer owner' } });
    const request = requestAPI(url, method, body, options);
    if (attempts === 1) staleRead = request;
    return request;
  });
  csrf.mockRejectedValueOnce(new ApiError(503, { error: 'Security unavailable' }));
  await mount();
  expect(fetchStatus).toHaveBeenCalledTimes(1);
  await state.checkInitialSession();
  expect(state.ownerId.value).toBe('newer-owner');
  expect(state.expired.value).toBe(false);
  obsolete.resolve(new Response(JSON.stringify({ error: 'Obsolete session response' }), { status: 401 }));
  await expect(staleRead).rejects.toMatchObject({ status: 401 });
  await turn();
  expect(state.expired.value).toBe(false);
  expect(state.platform.value.knowledgeRoot).toBe('/isolated/newer-library');
  expect(state.mountedWorkspace.value).toBe(true);
});
for (const failure of [new ApiError(429, { error: 'Limited' }), new ApiError(503, { error: 'Unavailable' }), new TypeError('Network unavailable')]) {
  it(`keeps session uncertainty recoverable after ${failure.name} ${'status' in failure ? failure.status : 'network'}`, async () => {
    let unavailable = true;
    api.mockImplementation(async (url: string) => { if (url === '/api/auth/get-session') { if (unavailable) throw failure; return owner; } return platform; });
    await mount();
    expect(state.loggedIn.value).toBe(false);
    expect(state.sessionCheckError.value).toBeTruthy();
    expect(state.mountedWorkspace.value).toBe(false);
    unavailable = false;
    await state.checkInitialSession();
    expect(state.loggedIn.value).toBe(true);
    expect(state.ownerId.value).toBe('retained-owner');
    expect(state.mountedWorkspace.value).toBe(true);
    expect(state.sessionCheckError.value).toBe('');
    expect(checks()).toBe(2);
  });
}
it('uses a successful initial identity without spending a second session request', async () => {
  api.mockImplementation(async (url: string) => url === '/api/auth/get-session' ? owner : platform);
  await mount(); expect(state.loggedIn.value).toBe(true); expect(state.ownerId.value).toBe('retained-owner'); expect(checks()).toBe(1);
});
for (const response of ['absent', 'unauthorized'] as const) {
  it(`offers login after the server confirms a session is ${response}`, async () => {
    api.mockImplementation(async () => { if (response === 'unauthorized') throw new ApiError(401, { error: 'Unauthenticated' }); return null; });
    await mount(); expect(state.loggedIn.value).toBe(false); expect(state.sessionCheckError.value).toBe(''); expect(state.sessionCheckBusy.value).toBe(false);
  });
}
it('keeps the recovery view during a pending retry and coalesces repeated clicks', async () => {
  api.mockRejectedValue(new ApiError(429, { error: 'Limited' })); await mount();
  let release!: (value: unknown) => void;
  const pending = new Promise(yes => { release = yes; });
  api.mockImplementation(async (url: string) => url === '/api/auth/get-session' ? pending : platform);
  const first = state.checkInitialSession(), duplicate = state.checkInitialSession();
  expect(state.sessionCheckBusy.value).toBe(true); expect(state.sessionCheckError.value).toBeTruthy(); expect(checks()).toBe(2);
  release(owner); await Promise.all([first, duplicate]);
  expect(state.loggedIn.value).toBe(true); expect(state.sessionCheckBusy.value).toBe(false); expect(state.sessionCheckError.value).toBe('');
});
it('keeps a failed CSRF initialization recoverable without misreporting a logged-out session', async () => {
  api.mockResolvedValue(owner); csrf.mockRejectedValue(new ApiError(503, { error: 'Unavailable' }));
  await mount(); expect(state.loggedIn.value).toBe(false); expect(state.sessionCheckError.value).toBeTruthy(); expect(state.mountedWorkspace.value).toBe(false);
});
it('retains a confirmed owner when the knowledge service is unavailable', async () => {
  api.mockImplementation(async (url: string) => { if (url === '/api/auth/get-session') return owner; throw new ApiError(503, { error: 'Unavailable' }); });
  await mount(); expect(state.loggedIn.value).toBe(true); expect(state.ownerId.value).toBe('retained-owner'); expect(state.sessionCheckError.value).toBe(''); expect(state.platformError.value).toBeTruthy();
});
