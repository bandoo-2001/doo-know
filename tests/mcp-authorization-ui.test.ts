import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse, compileScript } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as Vue from 'vue';
import { isResourceScope } from '../shared/authorization-scopes';
import * as permissionHelpers from '../apps/web/mcp-permissions';
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
      if (id === 'ant-design-vue') return { Alert: 'aside', Button: 'button', Card: 'section', Checkbox: { Group: 'div' }, Spin: 'span' };
      if (id === '../api') return { api };
      if (id === '../mcp-permissions') return permissionHelpers;
      if (id === './MCPDomainPermissions.vue' || id === './MCPClientPermissions.vue') return { default: {render:()=>null} };
      if (id === '../plugins') return { pluginRegistry: registry };
      if (id === './Icon.vue' || id === './KnowledgeResourceTreeSelect.vue') return { default: { render: () => null } };
      if (id === '../../../shared/authorization-scopes') return { isResourceScope };
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

it('leaves blog publication unchecked when OAuth requests include the public disclosure grant', async () => {
  api.mockResolvedValueOnce({ clientName: 'Fixture', allowedScopes: ['knowledge:read', 'knowledge:write', 'blog:publish', 'offline_access'], allowedPrefixes: ['00-Inbox'] });
  const view = await mount('OAuthConsent.vue', { oauthQuery: 'fixture-query' });
  expect(view.scopes).toEqual(['knowledge:read', 'offline_access']);
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

it('loads v2 consent as independent domain permissions with publication unchecked', async () => {
  const allowedPolicy={version:2,domains:{knowledge:{enabled:true,ownerId:'owner',instanceId:'lib',actions:['read','write','organize','archive'],resources:{mode:'all'}},blog:{enabled:true,ownerId:'owner',instanceId:'blog',actions:['read','publish'],resources:{mode:'all'}}}};
  api.mockResolvedValueOnce({clientName:'Agent',allowedScopes:['knowledge:read','knowledge:write','knowledge:organize','knowledge:archive','blog:read','blog:publish','offline_access'],allowedPolicy,allowedPrefixes:[]});
  const view=await mount('OAuthConsent.vue',{oauthQuery:'v2-query'});
  expect(view.permissionPolicy.domains.knowledge.actions).toEqual(['read']);
  expect(view.permissionPolicy.domains.blog.enabled).toBe(false);
  expect(view.permissionPolicy.domains.blog.actions).toEqual([]);
  expect(view.canAccept).toBe(true);
  view.permissionPolicy.domains.knowledge.actions=['read','write','organize'];
  expect(view.selectedScopes).toEqual(['knowledge:read','knowledge:write','knowledge:organize','offline_access']);
});

it('starts narrowing from the effective identity grant without editing the original',async()=>{
  const permissionPolicy={version:2,domains:{knowledge:{enabled:true,ownerId:'owner',instanceId:'lib',actions:['read','write','organize'],resources:{mode:'all'}}}};
  const view=await mount('MCPClientPermissions.vue',{client:{clientId:'agent',active:true,permissionPolicy,effectivePolicy:permissionPolicy,grantVersion:2}});
  view.edit();expect(view.draft).toEqual(permissionPolicy);
  view.draft.domains.knowledge.actions=['read'];
  expect(permissionPolicy.domains.knowledge.actions).toContain('organize');
  api.mockResolvedValueOnce({revoked:false});
  await view.save();
  expect(view.notice).toContain('已收窄');
  expect(api).toHaveBeenCalledWith('/api/platform/mcp/clients/narrow','POST',expect.objectContaining({clientId:'agent',expectedGrantVersion:2,permissionPolicy:expect.objectContaining({version:2})}));
});
it('reviews the current Tunnel ceiling before explicitly replacing its authorization',async()=>{
  const permissionPolicy={version:2,domains:{knowledge:{enabled:true,ownerId:'owner',instanceId:'lib',actions:['read','write','organize'],resources:{mode:'all'}}}};
  const view=await mount('MCPConnectionGuide.vue',{plugin:{id:'mcp',state:'enabled',configVersion:1,config:{}},mode:'tunnel',dirty:false});
  api.mockResolvedValueOnce({policy:permissionPolicy,resources:{}});
  await view.prepareTunnel();
  expect(view.tunnelPolicy).toEqual(permissionPolicy);
  expect(api).not.toHaveBeenCalledWith('/api/platform/mcp/tunnel/authorize',expect.anything(),expect.anything());
  api.mockResolvedValueOnce({authorized:true}).mockResolvedValueOnce(connection(true));
  await view.authorizeTunnel();
  expect(api).toHaveBeenCalledWith('/api/platform/mcp/tunnel/authorize','POST',{permissionPolicy});
  expect(view.notice).toContain('Tunnel 授权已更新');
});

it('accepts task-only legacy consent without requiring a note directory', async () => {
  api.mockResolvedValueOnce({ clientName: 'Task agent', allowedScopes: ['to-doo:read', 'to-doo:write'], allowedPrefixes: [] });
  const view = await mount('OAuthConsent.vue', { oauthQuery: 'tasks-only' });
  expect(view.canAccept).toBe(true);
  expect(view.selectedScopes).toEqual(['to-doo:read']);
  view.scopes = ['to-doo:write'];
  expect(view.canAccept).toBe(false);
});

it('defaults an explicitly requested task domain to read without enabling knowledge or task edits', async () => {
  const allowedPolicy = { version: 2, domains: { 'to-doo': { enabled: true, ownerId: 'owner', instanceId: 'tasks', actions: ['read', 'write'], resources: { mode: 'all' } } } };
  api.mockResolvedValueOnce({ clientName: 'Task agent', allowedScopes: ['to-doo:read', 'to-doo:write'], allowedPrefixes: [], allowedPolicy });
  const view = await mount('OAuthConsent.vue', { oauthQuery: 'tasks-v2' });
  expect(view.canAccept).toBe(true);
  expect(view.selectedScopes).toEqual(['to-doo:read']);
  expect(view.permissionPolicy.domains).not.toHaveProperty('knowledge');
});

it('offers a newly introduced task domain in an old v2 settings draft without overwriting dirty choices', async () => {
  const knowledge = { enabled: true, ownerId: 'owner', instanceId: 'library', actions: ['read'], resources: { mode: 'selected', resources: [{ kind: 'directory', id: 'dirty-selection' }] } };
  const modelValue = { version: 2, domains: { knowledge, blog: { enabled: false, ownerId: 'owner', instanceId: 'blog', actions: [], resources: { mode: 'all' } } } };
  const task = { enabled: false, ownerId: 'owner', instanceId: 'tasks', actions: [], resources: { mode: 'all' } };
  api.mockResolvedValueOnce({ policy: { version: 2, domains: { ...modelValue.domains, knowledge: { ...knowledge, actions: ['read', 'write'], resources: { mode: 'all' } }, 'to-doo': task } }, resources: {} });
  const updates: any[] = [];
  const view = await mount('MCPDomainPermissions.vue', { modelValue, 'onUpdate:modelValue': (value: unknown) => updates.push(value) });
  expect(view.domains.map((domain: any) => domain.id)).toContain('to-doo');
  expect(view.policy.domains['to-doo']).toEqual(task);
  expect(view.policy.domains.knowledge).toEqual(knowledge);
  expect(updates).toEqual([]);
  view.update('to-doo', (grant: any) => { grant.enabled = true; grant.actions = ['read']; });
  expect(updates[0].domains['to-doo']).toMatchObject({ enabled: true, actions: ['read'] });
  expect(updates[0].domains.knowledge).toEqual(knowledge);
  expect(modelValue.domains).not.toHaveProperty('to-doo');
});

it.each(['consent', 'narrow'])('keeps newly inventoried task domains outside an existing %s ceiling', async (mode) => {
  const modelValue = { version: 2, domains: { knowledge: { enabled: true, ownerId: 'owner', instanceId: 'library', actions: ['read'], resources: { mode: 'all' } } } };
  api.mockResolvedValueOnce({ policy: { version: 2, domains: { ...modelValue.domains, 'to-doo': { enabled: false, ownerId: 'owner', instanceId: 'tasks', actions: [], resources: { mode: 'all' } } } }, resources: {} });
  const view = await mount('MCPDomainPermissions.vue', { modelValue, ceiling: modelValue, consent: mode === 'consent' });
  expect(view.domains.map((domain: any) => domain.id)).toEqual(['knowledge']);
  expect(view.policy.domains).not.toHaveProperty('to-doo');
});

it('requires an explicit disabled rebind after the task dataset changes without reusing old grants', async () => {
  const old = { enabled: true, ownerId: 'owner', instanceId: 'old-dataset', actions: ['read', 'write', 'share'], resources: { mode: 'all' } };
  const modelValue = { version: 2, domains: { 'to-doo': old } };
  api.mockResolvedValueOnce({ policy: modelValue, resources: {}, bindings: { 'to-doo': { ownerId: 'owner', instanceId: 'new-dataset' } } });
  const updates: any[] = [];
  const view = await mount('MCPDomainPermissions.vue', { modelValue, 'onUpdate:modelValue': (value: unknown) => updates.push(value) });
  expect(updates).toEqual([]);
  expect(view.bindingChanged('to-doo')).toBe(true);
  view.rebind('to-doo');
  expect(updates[0].domains['to-doo']).toEqual({ enabled: false, ownerId: 'owner', instanceId: 'new-dataset', actions: [], resources: { mode: 'selected', resources: [] } });
  expect(modelValue.domains['to-doo']).toEqual(old);
});
