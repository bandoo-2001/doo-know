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
  origin: 'http://127.0.0.1:3000',
  connection: { oauth: { ready: false, address: 'http://127.0.0.1:3000/mcp' }, apiKey: { ready: true, address: 'http://127.0.0.1:3000/mcp/api-key' } },
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
      if (id === './MCPDomainPermissions.vue' || id === './MCPClientPermissions.vue' || id === './MCPApiClients.vue') return { default: {render:()=>null} };
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
it('shows the API Key endpoint from the saved connection state', async () => {
  const view = await mount('MCPConnectionGuide.vue', { plugin: { id: 'mcp', state: 'enabled', configVersion: 1, config: {} }, dirty: false });
  view.path = 'api-key';
  expect(view.endpoint).toBe('http://127.0.0.1:3000/mcp/api-key');
  expect(view.localReady).toBe(true);
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

const apiPolicy = { version: 2 as const, domains: { knowledge: { enabled: true, ownerId: 'owner', instanceId: 'library', actions: ['read', 'write'], resources: { mode: 'all' as const } } } };
function apiClient(overrides: Record<string, unknown> = {}) {
  return { clientId: 'api-client', name: 'Desktop assistant', status: 'active', version: 4, grantVersion: 7, permissionPolicy: structuredClone(apiPolicy), effectivePolicy: structuredClone(apiPolicy), key: { id: 'key-id', suffix: '12345678', version: 2, createdAt: '2026-11-01T00:00:00.000Z', expiresAt: null, revokedAt: null, lastUsedAt: null }, ...overrides };
}
async function apiView(clients = [apiClient()]) {
  api.mockImplementation(async (url: string) => url === '/api/platform/mcp/permissions' ? { policy: structuredClone(apiPolicy), resources: {} } : { items: clients });
  return mount('MCPApiClients.vue');
}
it('creates a client with a ninety-day default and keeps the one-time key out of the client list', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-01T12:00:00.000Z'));
  try {
    const view = await apiView([]);
    await view.beginCreate();
    expect(view.form.expiry).toBe('90');
    expect(view.form.permissionPolicy.domains.knowledge.actions).toEqual(['read']);
    view.form.name = 'My application';
    api.mockResolvedValueOnce({ client: apiClient({ name: 'My application' }), key: 'one-time-key' });
    await view.submit();
    expect(api).toHaveBeenLastCalledWith('/api/platform/mcp/api-clients', 'POST', expect.objectContaining({ name: 'My application', expiresAt: '2027-01-30T12:00:00.000Z' }));
    expect(view.secret).toBe('one-time-key');
    expect(view.clients[0].name).toBe('My application');
    expect(JSON.stringify(view.clients)).not.toContain('one-time-key');
    view.dismissSecret();
    expect(view.secret).toBe('');
  } finally { vi.useRealTimers(); }
});
it.each([['7', '2026-11-08T12:00:00.000Z'], ['30', '2026-12-01T12:00:00.000Z'], ['forever', null], ['custom', '2027-02-03T10:00:00.000Z']])('uses the selected %s expiration when rotating without resubmitting permissions', async (expiry, expiresAt) => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-01T12:00:00.000Z'));
  try {
    const view = await apiView();
    await view.beginEdit(view.clients[0], 'rotate');
    view.form.expiry = expiry;
    view.form.expiresAtCustom = '2027-02-03T10:00';
    api.mockResolvedValueOnce({ client: apiClient({ version: 5 }), key: 'rotated-key' });
    await view.submit();
    expect(api).toHaveBeenLastCalledWith('/api/platform/mcp/api-clients/api-client/rotate-key', 'POST', { expectedVersion: 4, expiresAt });
    expect(view.clients[0].version).toBe(5);
    expect(view.secret).toBe('rotated-key');
  } finally { vi.useRealTimers(); }
});
it('rejects a custom expiration in the past before issuing a credential', async () => {
  const view = await apiView();
  await view.beginCreate();
  view.form.name = 'Expired'; view.form.expiry = 'custom'; view.form.expiresAtCustom = '2020-01-01T00:00';
  const previousCalls = api.mock.calls.length;
  await view.submit();
  expect(view.error).toContain('将来');
  expect(api.mock.calls.length).toBe(previousCalls);
});
it('renames against the client version and edits permissions against the captured grant version', async () => {
  const view = await apiView();
  await view.beginEdit(view.clients[0], 'rename');
  view.form.name = 'New name';
  api.mockResolvedValueOnce(apiClient({ name: 'New name', version: 5 }));
  await view.submit();
  expect(view.clients[0].name).toBe('New name');
  expect(api).toHaveBeenLastCalledWith('/api/platform/mcp/api-clients/api-client', 'PATCH', { name: 'New name', expectedVersion: 4 });
  await view.beginEdit(view.clients[0], 'permissions');
  view.form.permissionPolicy.domains.knowledge.actions = ['read'];
  expect(view.clients[0].permissionPolicy.domains.knowledge.actions).toEqual(['read', 'write']);
  api.mockResolvedValueOnce(apiClient({ grantVersion: 8 }));
  await view.submit();
  expect(api).toHaveBeenLastCalledWith('/api/platform/mcp/api-clients/api-client/permissions', 'PUT', { permissionPolicy: expect.objectContaining({ version: 2 }), expectedGrantVersion: 7 });
  expect(view.clients[0].grantVersion).toBe(8);
});
it('retains a rejected stale permissions draft until the owner reloads it', async () => {
  const view = await apiView();
  await view.beginEdit(view.clients[0], 'permissions');
  view.form.permissionPolicy.domains.knowledge.actions = ['read'];
  api.mockRejectedValueOnce(Object.assign(Error('version conflict'), { status: 409 }));
  await view.submit();
  expect(view.error).toContain('重新载入');
  expect(view.form.permissionPolicy.domains.knowledge.actions).toEqual(['read']);
  expect(view.form.expectedGrantVersion).toBe(7);
  expect(view.clients[0].grantVersion).toBe(7);
});
it('only offers explicit reauthorization for clients that require it and submits both versions', async () => {
  const view = await apiView([apiClient({ status: 'requires_reauthorization' }), apiClient({ clientId: 'revoked', status: 'revoked' })]);
  await view.beginEdit(view.clients[1], 'reauthorize');
  expect(view.form).toBeUndefined();
  await view.beginEdit(view.clients[0], 'reauthorize');
  view.form.expiry = 'forever';
  api.mockResolvedValueOnce({ client: apiClient(), key: 'reauthorized-key' });
  await view.submit();
  expect(api).toHaveBeenLastCalledWith('/api/platform/mcp/api-clients/api-client/reauthorize', 'POST', { permissionPolicy: expect.objectContaining({ version: 2 }), expectedVersion: 4, expectedGrantVersion: 7, expiresAt: null });
  expect(view.clients[0].status).toBe('active');
  expect(view.secret).toBe('reauthorized-key');
});
it('keeps revocation confirmed when an older list response arrives later', async () => {
  const view = await apiView();
  const stale = deferred<{ items: ReturnType<typeof apiClient>[] }>();
  api.mockImplementationOnce(() => stale.promise);
  const reading = view.load();
  api.mockResolvedValueOnce({ revoked: true });
  await view.revoke(view.clients[0]);
  stale.resolve({ items: [apiClient()] });
  await reading;
  expect(view.clients[0].status).toBe('revoked');
  expect(view.clients[0].key.revokedAt).not.toBeNull();
});
it('discards a late creation response after the API client component unmounts', async () => {
  const view = await apiView([]);
  await view.beginCreate(); view.form.name = 'Leaving';
  const pending = deferred<any>(); api.mockImplementationOnce(() => pending.promise);
  const submitting = view.submit();
  cleanup.pop()!();
  pending.resolve({ client: apiClient(), key: 'do-not-reveal' });
  await submitting;
  expect(view.secret).toBe('');
});

it('starts reauthorization from the current resource binding when the old dataset is unavailable', async () => {
  const old = structuredClone(apiPolicy); old.domains.knowledge.instanceId = 'removed-dataset';
  const view = await apiView([apiClient({ status: 'requires_reauthorization', permissionPolicy: old, effectivePolicy: undefined })]);
  await view.beginEdit(view.clients[0], 'reauthorize');
  expect(view.form.permissionPolicy.domains.knowledge.instanceId).toBe('library');
  expect(view.form.permissionPolicy.domains.knowledge.actions).toEqual(['read']);
});

it('keeps saved grants editable when effective permissions are temporarily unavailable', async () => {
  const view = await apiView([apiClient({ effectivePolicy: { version: 2, domains: {} } })]);
  await view.beginEdit(view.clients[0], 'permissions');
  expect(view.form.permissionPolicy.domains.knowledge.actions).toEqual(['read', 'write']);
});
it('does not unlock a stale form if reloading the latest client fails', async () => {
  const view = await apiView();
  await view.beginEdit(view.clients[0], 'rename'); view.form.name = 'Pending';
  api.mockRejectedValueOnce(Object.assign(Error('conflict'), { status: 409 }));
  await view.submit();
  api.mockRejectedValueOnce(Error('offline'));
  await view.reloadForm();
  expect(view.conflict).toBe(true);
  expect(view.form.name).toBe('Pending');
  expect(view.canSubmit).toBe(false);
});
it('resolves an uncertain revoke from a fresh client list without leaving a stale confirmation', async () => {
  const view = await apiView();
  view.pendingRevoke = 'api-client';
  api.mockRejectedValueOnce(Error('response lost'));
  await view.revoke(view.clients[0]);
  api.mockResolvedValueOnce({ items: [apiClient({ status: 'revoked' })] });
  await view.load();
  expect(view.pendingRevoke).toBe('');
  expect(view.error).toBe('');
  expect(view.clients[0].status).toBe('revoked');
});

it('offers newly available client permission domains without widening the existing grant', async () => {
  const saved = { version: 2, domains: { knowledge: { enabled: true, ownerId: 'owner', instanceId: 'library', actions: ['read'], resources: { mode: 'selected', resources: [{ kind: 'directory', id: 'original-directory' }] } } } };
  const ceiling = { version: 2, domains: { ...structuredClone(apiPolicy.domains), blog: { enabled: true, ownerId: 'owner', instanceId: 'blog', actions: ['read', 'write', 'publish'], resources: { mode: 'selected', resources: [{ kind: 'article', id: 'new-article' }] } } } };
  const view = await apiView([apiClient({ permissionPolicy: structuredClone(saved) })]);
  api.mockResolvedValueOnce({ policy: ceiling, resources: {} });
  await view.beginEdit(view.clients[0], 'permissions');
  expect(view.form.permissionPolicy.domains.knowledge).toEqual(saved.domains.knowledge);
  expect(view.form.permissionPolicy.domains.blog).toEqual({ enabled: false, ownerId: 'owner', instanceId: 'blog', actions: [], resources: { mode: 'selected', resources: [{ kind: 'article', id: 'new-article' }] } });
  expect(view.clients[0].permissionPolicy).toEqual(saved);
  api.mockResolvedValueOnce({ policy: ceiling, resources: {} });
  const editor = await mount('MCPDomainPermissions.vue', {
    modelValue: view.form.permissionPolicy,
    ceiling: view.form.ceiling,
    consent: true,
    'onUpdate:modelValue': (policy: unknown) => { view.form.permissionPolicy = policy; },
  });
  expect(editor.domains.map((domain: any) => domain.id)).toEqual(['knowledge', 'blog']);
  editor.update('blog', (grant: any) => { grant.enabled = true; grant.actions = ['read']; });
  expect(view.form.permissionPolicy.domains.knowledge).toEqual(saved.domains.knowledge);
  expect(ceiling.domains.blog.actions).toEqual(['read', 'write', 'publish']);
  api.mockResolvedValueOnce(apiClient({ permissionPolicy: JSON.parse(JSON.stringify(view.form.permissionPolicy)), grantVersion: 8 }));
  await view.submit();
  expect(api).toHaveBeenLastCalledWith('/api/platform/mcp/api-clients/api-client/permissions', 'PUT', {
    expectedGrantVersion: 7,
    permissionPolicy: { version: 2, domains: { knowledge: saved.domains.knowledge, blog: { enabled: true, ownerId: 'owner', instanceId: 'blog', actions: ['read'], resources: { mode: 'selected', resources: [{ kind: 'article', id: 'new-article' }] } } } },
  });
  expect(view.clients[0].permissionPolicy.domains.blog.actions).toEqual(['read']);
});
