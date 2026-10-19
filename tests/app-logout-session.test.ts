import { readFileSync } from 'node:fs';
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as Vue from 'vue';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mockApi = vi.fn(),
  clearDrafts = vi.fn(),
  disposePlugins = vi.fn();
const cleanups: (() => void)[] = [];
let state: any, workspaceEmit: (event: string) => void, compactLoginEmit: (event: string) => void;
let workspaceMounts = 0,
  workspaceUnmounts = 0;
let workspaceDraft: Vue.Ref<string>;

async function mount(authenticated = true) {
  mockApi.mockImplementation(async (url: string) => {
    if (url === '/api/auth/get-session')
      return authenticated ? { user: { id: 'owner', username: 'owner' } } : null;
    if (url === '/api/platform/status') return { phase: 'ready', onboardingRequired: false };
    return {};
  });
  const provider = {
    inheritAttrs: false,
    setup: (_props: any, ctx: any) => () => ctx.slots.default?.(),
  };
  const modal = {
    props: ['show'],
    setup: (props: any, ctx: any) => () =>
      props.show ? Vue.h('dialog-marker', ctx.slots.default?.()) : null,
  };
  const workspace = {
    emits: ['logout', 'retry-service'],
    setup(_props: any, ctx: any) {
      workspaceMounts++;
      workspaceEmit = ctx.emit;
      workspaceDraft = Vue.ref('unsaved editor text');
      Vue.onBeforeUnmount(() => workspaceUnmounts++);
      return () => Vue.h('workspace-marker', { draft: workspaceDraft.value });
    },
  };
  const login = {
    props: { compact: Boolean },
    emits: ['login'],
    setup(props: any, ctx: any) {
      if (props.compact) compactLoginEmit = ctx.emit;
      return () => Vue.h('login-marker', { compact: !!props.compact });
    },
  };
  const descriptor = parse(
    readFileSync(new URL('../apps/web/App.vue', import.meta.url), 'utf8'),
  ).descriptor;
  const script = compileScript(descriptor, { id: 'app-logout-regression' });
  const template = compileTemplate({
    source: descriptor.template!.content,
    filename: 'App.vue',
    id: 'app-logout-regression',
    compilerOptions: { bindingMetadata: script.bindings },
  });
  const source = ts.transpileModule(script.content + '\n' + template.code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const output: { exports: any } = { exports: {} };
  new Function('require', 'module', 'exports', source)(
    (id: string) => {
      if (id === 'vue') return Vue;
      if (id === 'naive-ui')
        return {
          NConfigProvider: provider,
          NModal: modal,
          NAlert: provider,
          NButton: provider,
          darkTheme: {},
        };
      if (id === 'ant-design-vue')
        return { ConfigProvider: provider, theme: { darkAlgorithm: {}, defaultAlgorithm: {} } };
      if (id === 'ant-design-vue/es/locale/zh_CN') return { default: {} };
      if (id === './ant-design') return { antTheme: {} };
      if (id === './api') return { api: mockApi, refreshCsrf: vi.fn(), resetCsrf: vi.fn() };
      if (id === './plugin-drafts')
        return { clearPluginDrafts: clearDrafts, hasUnsavedPluginDrafts: () => false };
      if (id === './plugins') return { disposePluginUIs: disposePlugins };
      if (id === './preferences')
        return { initializeEditorPreferences: vi.fn(), resolvedTheme: Vue.ref('light') };
      if (id.endsWith('/Workspace.vue')) return { __esModule: true, default: workspace };
      if (id.endsWith('/Login.vue')) return { __esModule: true, default: login };
      if (id.endsWith('.vue')) return { __esModule: true, default: provider };
      throw Error('Unexpected App dependency: ' + id);
    },
    output,
    output.exports,
  );
  const component = output.exports.default,
    setup = component.setup;
  component.setup = (props: any, ctx: any) => {
    state = setup(props, ctx);
    return state;
  };
  component.render = output.exports.render;
  const renderer = Vue.createRenderer<any, any>({
    insert(node, parent, anchor) {
      if (node.parent) {
        const index = node.parent.children.indexOf(node);
        if (index >= 0) node.parent.children.splice(index, 1);
      }
      parent.children ||= [];
      const index = anchor ? parent.children.indexOf(anchor) : -1;
      parent.children.splice(index < 0 ? parent.children.length : index, 0, node);
      node.parent = parent;
    },
    remove(node) {
      if (node.parent) {
        const index = node.parent.children.indexOf(node);
        if (index >= 0) node.parent.children.splice(index, 1);
        node.parent = null;
      }
    },
    createElement: (type) => ({ type, children: [] }),
    createText: () => ({}),
    createComment: () => ({}),
    setText() {},
    setElementText() {},
    parentNode: (node) => node?.parent || null,
    nextSibling: (node) => node?.parent?.children[node.parent.children.indexOf(node) + 1] || null,
    patchProp(node, key, _old, value) {
      (node.props ||= {})[key] = value;
    },
  });
  const root: any = { children: [] },
    app = renderer.createApp(component);
  app.mount(root);
  cleanups.push(() => app.unmount());
  const count = (type: string) => {
    let total = 0;
    const visit = (node: any) => {
      if (node.type === type) total++;
      for (const child of node.children || []) visit(child);
    };
    visit(root);
    return total;
  };
  await vi.waitFor(() =>
    expect(count(authenticated ? 'workspace-marker' : 'login-marker')).toBe(1),
  );
  return { count };
}

beforeEach(() => {
  mockApi.mockReset();
  clearDrafts.mockReset();
  disposePlugins.mockReset();
  disposePlugins.mockResolvedValue(undefined);
  workspaceMounts = 0;
  workspaceUnmounts = 0;
  vi.stubGlobal('location', { pathname: '/', search: '' });
  vi.stubGlobal('window', new EventTarget());
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});

it('explicit logout closes reauthentication and ignores a late unauthorized response', async () => {
  const view = await mount();
  window.dispatchEvent(new Event('dooknow-session-expired'));
  await vi.waitFor(() => expect(view.count('dialog-marker')).toBe(1));
  workspaceEmit('logout');
  window.dispatchEvent(new Event('dooknow-session-expired'));
  await Vue.nextTick();
  expect(state.loggedIn.value).toBe(false);
  expect(state.expired.value).toBe(false);
  expect(view.count('dialog-marker')).toBe(0);
  expect(view.count('login-marker')).toBe(1);
  expect(view.count('workspace-marker')).toBe(0);
  expect(clearDrafts).toHaveBeenCalled();
  expect(disposePlugins).toHaveBeenCalled();
});

it('an unauthorized response while signed out keeps only the main login form', async () => {
  const view = await mount(false);
  window.dispatchEvent(new Event('dooknow-session-expired'));
  await Vue.nextTick();
  expect(state.expired.value).toBe(false);
  expect(view.count('dialog-marker')).toBe(0);
  expect(view.count('login-marker')).toBe(1);
});

it('session expiry and same-owner reauthentication keep the mounted workspace and local editor draft', async () => {
  const view = await mount();
  workspaceDraft.value = 'draft retained while signing in';
  window.dispatchEvent(new Event('dooknow-session-expired'));
  await vi.waitFor(() => expect(view.count('dialog-marker')).toBe(1));
  expect(view.count('workspace-marker')).toBe(1);
  compactLoginEmit('login');
  await vi.waitFor(() => expect(state.expired.value).toBe(false));
  expect(view.count('dialog-marker')).toBe(0);
  expect(workspaceMounts).toBe(1);
  expect(workspaceUnmounts).toBe(0);
  expect(workspaceDraft.value).toBe('draft retained while signing in');
  expect(clearDrafts).not.toHaveBeenCalled();
});
