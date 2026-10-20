import { readFileSync } from 'node:fs';
import { parse, compileScript } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as Vue from 'vue';
import MarkdownIt from 'markdown-it';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiError } from '../apps/web/api';
import * as navigation from '../apps/web/navigation';
import * as preferences from '../apps/web/preferences';
import * as settings from '../apps/web/settings';
import * as format from '../apps/web/markdown-format';
import * as drafts from '../apps/web/drafts';
import * as search from '../apps/web/search-results';
import * as outline from '../apps/web/document-outline';
import { markdownStyles } from '../shared/markdown-styles';

const mockApi = vi.fn();
const cleanups: (() => void)[] = [];
const original = {
  id: 'note-one',
  relativePath: '00-Inbox/one.md',
  title: 'One',
  content: '# Old',
  modifiedAt: 'base-one',
};
const meta = { ...original, editorMode: 'full', sizeBytes: 5 };
let state: any;
let flush: ReturnType<typeof vi.fn>, clearSaved: ReturnType<typeof vi.fn>;
const descriptor = parse(
  readFileSync(new URL('../apps/web/components/Workspace.vue', import.meta.url), 'utf8'),
).descriptor;
const compiled = compileScript(descriptor, { id: 'workspace-save-recovery' });
const source = ts.transpileModule(compiled.content, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
async function mount() {
  const output: { exports: any } = { exports: {} };
  new Function('require', 'module', 'exports', source)(
    (id: string) => {
      if (id === 'vue') return Vue;
      if (id === 'markdown-it') return { default: MarkdownIt, __esModule: true };
      if (id === 'dompurify')
        return { default: { sanitize: (value: string) => value }, __esModule: true };
      if (id === '../../../shared/markdown-styles') return { markdownStyles };
      if (id === '../api') return { api: mockApi, ApiError, resetCsrf: vi.fn() };
      if (id === '../navigation') return navigation;
      if (id === '../preferences') return preferences;
      if (id === '../settings') return settings;
      if (id === '../markdown-format') return format;
      if (id === '../drafts') return drafts;
      if (id === '../search-results') return search;
      if (id === '../document-outline') return outline;
      if (id === '../plugins')
        return {
          refreshPlugins: async () => {},
          disposePluginUIs: async () => {},
          pluginRegistry: Vue.ref([]),
        };
      if (id === '../git-sync') return { gitUnsaved: Vue.ref(false) };
      if (id === '../plugin-drafts') return { clearPluginDrafts: vi.fn() };
      if (id === '../useNoteDraft')
        return {
          useNoteDraft: () => ({
            scope: Vue.ref(),
            recovered: Vue.ref(),
            loading: Vue.ref(false),
            busy: Vue.ref(false),
            error: Vue.ref(''),
            savedAt: Vue.ref(),
            setup: vi.fn(),
            prepare: vi.fn(),
            load: async () => {},
            flush,
            clearSaved,
            discard: vi.fn(),
            restore: vi.fn(),
            logout: vi.fn(),
          }),
        };
      if (id.endsWith('.vue')) return { default: {}, __esModule: true };
      if (id === 'naive-ui' || id === 'ant-design-vue') return {};
      throw Error('Unexpected Workspace dependency: ' + id);
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
  const app = renderer.createApp(component);
  app.mount({});
  cleanups.push(() => app.unmount());
  await vi.waitFor(() => expect(state.note.value?.id).toBe(original.id));
  state.draft.value = '# Submitted';
  await Vue.nextTick();
}
function writes() {
  return mockApi.mock.calls.filter((call) => call[1] === 'PUT');
}
function pending() {
  return { ...state.pendingSave.value };
}
function response(content = '# Submitted') {
  return { ...original, content, modifiedAt: 'saved-two' };
}
function lookupFailure(error: unknown) {
  mockApi.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/operations?')) throw error;
    return [];
  });
}
beforeEach(() => {
  mockApi.mockReset();
  clearSaved = vi.fn(async () => {});
  flush = vi.fn(async () => 'current-local-version');
  const location = {
    href: 'http://isolated.invalid/?note=note-one',
    search: '?note=note-one',
    hash: '',
  };
  vi.stubGlobal('location', location);
  vi.stubGlobal('window', Object.assign(new EventTarget(), { location }));
  vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: false }));
  vi.stubGlobal('history', { state: {}, replaceState: vi.fn(), pushState: vi.fn() });
  vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: vi.fn() });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
  mockApi.mockImplementation(async (url: string, method = 'GET') => {
    if (method === 'PUT') throw new TypeError('Failed to fetch');
    if (url === '/api/auth/get-session') return { user: { id: 'owner' } };
    if (url === '/api/platform/status') return { knowledgeRoot: '/isolated', bindingVersion: 1 };
    if (url.endsWith('/meta')) return { ...meta };
    if (url === '/api/notes/note-one') return { ...original };
    if (url === '/api/tree' || url.endsWith('/assets')) return [];
    return {};
  });
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});

it.each(['save', 'checkSave'])(
  'one explicit %s retries an undelivered save with its original identity, content and base',
  async (action) => {
    await mount();
    await state.save();
    const submitted = writes()[0]![2],
      retained = pending();
    state.draft.value = '# Later typing';
    mockApi.mockImplementation(async (url: string, method = 'GET') => {
      if (url.startsWith('/api/operations?'))
        throw new ApiError(404, { code: 'OPERATION_NOT_FOUND' });
      if (method === 'PUT') return response();
      return [];
    });
    await state.run(() => state[action]());
    expect(writes()).toHaveLength(2);
    expect(writes()[1]![2]).toEqual(submitted);
    expect(submitted.requestId).toBe(retained.requestId);
    expect(state.pendingSave.value).toBeUndefined();
    expect(state.savedContent.value).toBe('# Submitted');
    expect(state.draft.value).toBe('# Later typing');
    expect(state.dirty.value).toBe(true);
    expect(clearSaved).not.toHaveBeenCalled();
  },
);
it.each([
  new TypeError('network unavailable'),
  new ApiError(401, { code: 'UNAUTHORIZED' }),
  new ApiError(403, { code: 'FORBIDDEN' }),
  new ApiError(503, { code: 'UNAVAILABLE' }),
  new ApiError(404, { code: 'OTHER_NOT_FOUND' }),
])('does not resend or forget a pending save when lookup fails: %s', async (failure) => {
  await mount();
  await state.save();
  const retained = pending();
  lookupFailure(failure);
  await state.save();
  expect(writes()).toHaveLength(1);
  expect(state.pendingSave.value).toEqual(retained);
  expect(state.draft.value).toBe('# Submitted');
});
it('confirms an already committed save without another write and preserves subsequent typing', async () => {
  await mount();
  await state.save();
  state.draft.value = '# Later typing';
  mockApi.mockImplementation(async (url: string) =>
    url.startsWith('/api/operations?')
      ? { status: 'succeeded', result: { modifiedAt: 'saved-two' } }
      : { ...meta, modifiedAt: 'saved-two' },
  );
  await state.save();
  expect(writes()).toHaveLength(1);
  expect(state.pendingSave.value).toBeUndefined();
  expect(state.note.value.modifiedAt).toBe('saved-two');
  expect(state.savedContent.value).toBe('# Submitted');
  expect(state.draft.value).toBe('# Later typing');
});
it.each(['running', 'needs_reconciliation'])(
  'does not resend a save with an unresolved operation: %s',
  async (status) => {
    await mount();
    await state.save();
    const retained = pending();
    mockApi.mockResolvedValue({ status });
    await state.save();
    expect(writes()).toHaveLength(1);
    expect(state.pendingSave.value).toEqual(retained);
  },
);
it('keeps version-conflict protection when retrying an undelivered request', async () => {
  await mount();
  await state.save();
  const submitted = writes()[0]![2];
  mockApi.mockImplementation(async (url: string, method = 'GET') => {
    if (url.startsWith('/api/operations?'))
      throw new ApiError(404, { code: 'OPERATION_NOT_FOUND' });
    if (method === 'PUT')
      throw new ApiError(409, { code: 'VERSION_CONFLICT', currentModifiedAt: 'other-version' });
    return [];
  });
  await state.save();
  expect(writes()).toHaveLength(2);
  expect(writes()[1]![2]).toEqual(submitted);
  expect(state.conflict.value).toMatchObject({ version: 'other-version', content: '# Submitted' });
  expect(state.savedContent.value).toBe('# Old');
  expect(state.draft.value).toBe('# Submitted');
});

it.each(['failed', 'cancelled'])(
  'saves once after reauthentication when the previous operation is confirmed %s',
  async (status) => {
    await mount();
    await state.save();
    const first = writes()[0]![2];
    lookupFailure(new ApiError(401, { code: 'UNAUTHORIZED' }));
    await state.save();
    expect(writes()).toHaveLength(1);
    expect(state.pendingSave.value.requestId).toBe(first.requestId);
    mockApi.mockImplementation(async (url: string, method = 'GET') => {
      if (url.startsWith('/api/operations?')) return { status };
      if (method === 'PUT') return response();
      return [];
    });
    await state.save();
    expect(writes()).toHaveLength(2);
    expect(writes()[1]![2]).toMatchObject({
      content: '# Submitted',
      expectedModifiedAt: 'base-one',
    });
    expect(writes()[1]![2].requestId).not.toBe(first.requestId);
    expect(state.savedContent.value).toBe('# Submitted');
    expect(state.pendingSave.value).toBeUndefined();
    expect(state.dirty.value).toBe(false);
  },
);
it('saves the current note once after discarding the previous note while its successful response was held', async () => {
  await mount();
  const second = {
    ...original,
    id: 'note-two',
    relativePath: '00-Inbox/two.md',
    content: '# Second original',
    modifiedAt: 'base-two',
  };
  let release!: (value: unknown) => void;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  mockApi.mockImplementation(async (url: string, method = 'GET', body: any) => {
    if (url === '/api/notes/note-one' && method === 'PUT') return held;
    if (url === '/api/notes/note-two' && method === 'PUT')
      return { ...second, content: body.content, modifiedAt: 'second-saved' };
    if (url === '/api/notes/note-two') return second;
    if (url === '/api/notes/note-two/meta') return { ...meta, ...second };
    if (url.startsWith('/api/operations?'))
      return { status: 'succeeded', result: { modifiedAt: 'saved-two' } };
    return [];
  });
  const savingFirst = state.save();
  await vi.waitFor(() => expect(writes()).toHaveLength(1));
  const first = writes()[0]![2];
  await state.openNote(second.id);
  expect(state.leaveOpen.value).toBe(true);
  await state.leave('discard');
  expect(state.note.value.id).toBe(second.id);
  release(response());
  await savingFirst;
  state.draft.value = '# Second new content';
  await state.save();
  expect(writes()).toHaveLength(2);
  expect(writes()[1]![0]).toBe('/api/notes/note-two');
  expect(writes()[1]![2]).toMatchObject({
    content: '# Second new content',
    expectedModifiedAt: 'base-two',
  });
  expect(writes()[1]![2].requestId).not.toBe(first.requestId);
  expect(state.note.value.id).toBe(second.id);
  expect(state.savedContent.value).toBe('# Second new content');
  expect(state.dirty.value).toBe(false);
});
