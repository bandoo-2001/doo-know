import { readFileSync } from 'node:fs';
import { parse, compileScript } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as Vue from 'vue';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiError } from '../apps/web/api';
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
async function mount() {
  const output: { exports: any } = { exports: {} };
  new Function('require', 'module', 'exports', source)((id: string) => {
    if (id === 'vue') return Vue;
    if (id === './api') return { api, ApiError, refreshCsrf: csrf, resetCsrf() {} };
    if (id === './preferences') return { resolvedTheme: Vue.ref('light'), initializeEditorPreferences() {} };
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
  await vi.waitFor(() => expect(state.ready.value).toBe(true));
}
const checks = () => api.mock.calls.filter(([url]) => url === '/api/auth/get-session').length;
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
