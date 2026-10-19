import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse, compileScript } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as Vue from 'vue';
const api = vi.fn();
const registry = Vue.shallowRef({ installed: [] as any[] });
const cleanup: (() => void)[] = [];
const connection = (active: boolean) => ({
  clients: [
    {
      clientId: 'client',
      active,
      scopes: ['knowledge:read'],
      effectiveScopes: active ? ['knowledge:read'] : [],
      effectivePrefixes: active ? ['00-Inbox'] : [],
      allowedPrefixes: ['00-Inbox'],
    },
  ],
  connection: { oauth: { ready: false }, tunnel: { ready: false } },
  latestSuccessfulCall: null,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function mount(file: string, props = {}) {
  const filename = new URL('../apps/web/components/' + file, import.meta.url);
  const descriptor = parse(readFileSync(filename, 'utf8'), { filename: file }).descriptor;
  const source = compileScript(descriptor, { id: 'authorization-regression' }).content;
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} as any };
  new Function('require', 'module', 'exports', code)(
    (id: string) => {
      if (id === 'vue') return Vue;
      if (id === 'ant-design-vue') return { Alert: 'aside', Button: 'button' };
      if (id === '../api') return { api };
      if (id === '../plugins') return { pluginRegistry: registry };
      throw Error('Unexpected component dependency: ' + id);
    },
    module,
    module.exports,
  );
  const component = module.exports.default;
  component.render = () => null;
  const renderer = Vue.createRenderer<any, any>({
    insert() {},
    remove() {},
    createElement: () => ({}),
    createText: () => ({}),
    createComment: () => ({}),
    setText() {},
    setElementText() {},
    parentNode: () => null,
    nextSibling: () => null,
    patchProp() {},
  });
  const app = renderer.createApp(component, props);
  app.mount({});
  cleanup.push(() => app.unmount());
  await Promise.resolve();
  await Vue.nextTick();
  return (app as any)._instance.setupState;
}
beforeEach(() => {
  registry.value = { installed: [] };
  api.mockReset();
  api.mockImplementation(async (_url, method) =>
    method === 'POST' ? { revoked: true } : connection(true),
  );
});
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});
it('does not let a stale authorization read overwrite a confirmed revocation', async () => {
  const view = await mount('MCPAuthorizationManager.vue');
  const stale = deferred<ReturnType<typeof connection>>();
  api.mockImplementationOnce(() => stale.promise);
  const reading = view.load();
  view.pending = 'client';
  api.mockResolvedValueOnce({ revoked: true }).mockResolvedValueOnce(connection(false));
  await view.revoke();
  expect(view.clients[0].active).toBe(false);
  stale.resolve(connection(true));
  await reading;
  expect(view.clients[0].active).toBe(false);
});
it('keeps a rejected revocation visible when a subsequent status read succeeds', async () => {
  const view = await mount('MCPConnectionGuide.vue', {
    plugin: { id: 'mcp', state: 'disabled', configVersion: 0, config: {} },
    mode: 'oauth',
    dirty: false,
  });
  view.revokeClient = 'client';
  api.mockRejectedValueOnce(Error('request refused')).mockResolvedValueOnce(connection(true));
  await view.revoke();
  expect(String(view.actionError || view.error)).toContain('撤销');
  expect(view.state.clients[0].active).toBe(true);
});

it('marks a confirmed revocation locally when the following status refresh fails', async () => {
  const view = await mount('MCPConnectionGuide.vue', {
    plugin: { id: 'mcp', state: 'disabled', configVersion: 0, config: {} },
    mode: 'oauth',
    dirty: false,
  });
  view.revokeClient = 'client';
  api.mockResolvedValueOnce({ revoked: true }).mockRejectedValueOnce(Error('status unavailable'));
  await view.revoke();
  expect(view.state.clients[0].active).toBe(false);
  expect(view.error).not.toBe('');
  expect(view.notice).toContain('授权已撤销');
});

it.each(['MCPAuthorizationManager.vue', 'MCPConnectionGuide.vue'])(
  'uses a fresh revoked state to resolve an uncertain revocation in %s',
  async (file) => {
    const view = await mount(
      file,
      file === 'MCPConnectionGuide.vue'
        ? {
            plugin: { id: 'mcp', state: 'disabled', configVersion: 0, config: {} },
            mode: 'oauth',
            dirty: false,
          }
        : {},
    );
    if (file === 'MCPConnectionGuide.vue') view.revokeClient = 'client';
    else view.pending = 'client';
    api.mockImplementation(async (_url, method) => {
      if (method === 'POST') throw Error('response lost');
      return connection(false);
    });
    await view.revoke();
    await view.load();
    expect(view.actionError).toBe('');
    expect(view.notice).toContain('撤销');
  },
);
