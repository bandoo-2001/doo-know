import { readFileSync } from 'node:fs';
import { parse, compileScript } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as Vue from 'vue';
import MarkdownIt from 'markdown-it';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiError } from '../apps/web/api';
import * as navigation from '../apps/web/navigation';
import * as markdownLinks from '../apps/web/markdown-links';
import * as imageRequests from '../apps/web/image-requests';
import * as preferences from '../apps/web/preferences';
import * as settings from '../apps/web/settings';
import * as format from '../apps/web/markdown-format';
import * as drafts from '../apps/web/drafts';
import * as search from '../apps/web/search-results';
import * as searchMatching from '../shared/search-matching';
import * as outline from '../apps/web/document-outline';
import { previewSource } from '../apps/web/preview-source';
import * as collectionFeed from '../apps/web/collection-feed';
import * as blogWorkbench from '../apps/web/blog-workbench';
import * as blogDiagrams from '../apps/web/blog-diagrams';
import * as toDooCapture from '../apps/web/to-doo-capture';
import { markdownStyles } from '../shared/markdown-styles';
import {markdownTasks} from '../shared/markdown-tasks';
import {diagramFences} from '../shared/diagram-fences';
import * as whiteboard from '../shared/whiteboard';
import * as editorCompatibility from '../apps/web/editor/compatibility';
import * as assetBookmarks from '../apps/web/editor/asset-bookmark';
import * as keyboardShortcuts from '../apps/web/editor/keyboard-shortcuts';
import * as viewTransitions from '../apps/web/editor/view-transitions';
import * as knowledgeMarkdown from '../shared/knowledge-markdown';
import * as editorSnippets from '../shared/editor-snippets';
import * as diagramEdits from '../apps/web/editor/diagram-edits';
import * as uploadQueue from '../apps/web/editor/upload-queue';
import * as diagramPortability from '../shared/diagram-portability';
import * as portableFigure from '../shared/portable-figure';
import * as frontmatterRange from '../shared/frontmatter-range';
import * as diagramSavePolicy from '../apps/web/diagrams/save-policy';
import { useNoteDraft as realNoteDraft } from '../apps/web/useNoteDraft';

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
let realDraftLifecycle = false;
let flush: ReturnType<typeof vi.fn>, clearSaved: ReturnType<typeof vi.fn>;
const descriptor = parse(
  readFileSync(new URL('../apps/web/components/Workspace.vue', import.meta.url), 'utf8'),
).descriptor;
const compiled = compileScript(descriptor, { id: 'workspace-save-recovery' });
const source = ts.transpileModule(compiled.content, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
async function mount(waitForNote = true) {
  const output: { exports: any } = { exports: {} };
  new Function('require', 'module', 'exports', source)(
    (id: string) => {
      if (id === 'vue') return Vue;
      if(id.endsWith('.css'))return {};
      if(id==='../../../shared/diagram-fences')return {diagramFences};
      if(id==='../../../shared/knowledge-markdown')return knowledgeMarkdown;
      if(id==='../../../shared/editor-snippets')return editorSnippets;
      if(id==='../../../shared/diagram-portability')return diagramPortability;
      if(id==='../../../shared/portable-figure')return portableFigure;
      if(id==='../../../shared/frontmatter-range')return frontmatterRange;
      if(id==='../editor/diagram-edits')return diagramEdits;
      if(id==='../editor/upload-queue')return uploadQueue;
      if(id==='../diagrams/save-policy')return diagramSavePolicy;
      if(id==='../../../shared/whiteboard')return whiteboard;
      if(id==='../whiteboards/diagrams')return {syncDiagrams:vi.fn(),clearDiagrams:vi.fn()};
      if (id === 'markdown-it') return { default: MarkdownIt, __esModule: true };
      if (id === 'dompurify')
        return { default: { sanitize: (value: string) => value }, __esModule: true };
      if (id === '../../../shared/markdown-styles') return { markdownStyles };
      if (id === '../../../shared/markdown-tasks') return {markdownTasks};
      if (id === '../editor/compatibility') return editorCompatibility;
      if (id === '../editor/asset-bookmark') return assetBookmarks;
      if (id === '../editor/keyboard-shortcuts') return keyboardShortcuts;
      if (id === '../editor/view-transitions') return viewTransitions;
      if (id === '../editor/toolbar-state') return format;
      if (id === '../api') return { api: mockApi, ApiError, resetCsrf: vi.fn() };
      if (id === '../navigation') return navigation;
      if (id === '../markdown-links') return markdownLinks;
      if (id === '../image-requests') return imageRequests;
      if (id === '../preferences') return preferences;
      if (id === '../settings') return settings;
      if (id === '../markdown-format') return format;
      if (id === '../drafts') return drafts;
      if (id === '../search-results') return search;
      if (id === '../../../shared/search-matching') return searchMatching;
      if (id === '../document-outline') return outline;
      if (id === '../preview-source') return { previewSource };
      if (id === '../collection-feed') return collectionFeed;
      if (id === '../blog-workbench') return blogWorkbench;
      if (id === '../blog-diagrams') return blogDiagrams;
      if (id === '../to-doo-capture') return toDooCapture;
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
          useNoteDraft: (context: any, restore: any) => realDraftLifecycle ? realNoteDraft(context, restore) : ({
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
  if (!waitForNote) return;
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
  realDraftLifecycle = false;
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

function holdIdentity() {
  // Namespace hashing has its own browser coverage; keep this lifecycle test on
  // the supported no-SubtleCrypto path so draining one turn settles the reply.
  vi.stubGlobal('crypto', { randomUUID: crypto.randomUUID.bind(crypto) });
  const request = mockApi.getMockImplementation()!;
  let resolve!: (value: unknown) => void;
  const pending = new Promise((done) => { resolve = done; });
  mockApi.mockImplementation((...args) => args[0] === '/api/auth/get-session' ? pending : request(...args));
  return () => resolve({ user: { id: 'owner' } });
}
it('coalesces manual saves waiting for the same editor composition flush', async () => {
  await mount();
  const request = mockApi.getMockImplementation()!;
  mockApi.mockImplementation((...args) => args[1] === 'PUT'
    ? Promise.resolve(response(args[2].content)) : request(...args));
  let release!: () => void;
  const composition = new Promise<void>((resolve) => { release = resolve; });
  state.editorRef.value = { flush: () => composition, cancelPendingFocus() {} };
  const first = state.save(), second = state.save();
  expect(writes()).toHaveLength(0);
  release();
  await Promise.all([first, second]);
  expect(writes()).toHaveLength(1);
  expect(writes()[0][2]).toMatchObject({ content: '# Submitted', expectedModifiedAt: 'base-one' });
  expect(state.savedContent.value).toBe('# Submitted');
  expect(state.conflict.value).toBeUndefined();
});

it('does not submit a second request when coalesced saves lose their first response', async () => {
  await mount();
  let release!: () => void;
  const composition = new Promise<void>((resolve) => { release = resolve; });
  state.editorRef.value = { flush: () => composition, cancelPendingFocus() {} };
  const first = state.save(), second = state.save();
  release();
  await Promise.all([first, second]);
  expect(writes()).toHaveLength(1);
  expect(state.pendingSave.value).toMatchObject({
    requestId: writes()[0][2].requestId,
    content: '# Submitted',
  });
  expect(state.draft.value).toBe('# Submitted');
});

it('does not let an old composition save submit a newer editing session of the same note', async () => {
  await mount();
  const request = mockApi.getMockImplementation()!;
  const other = { ...original, id: 'note-two', relativePath: '00-Inbox/two.md' };
  mockApi.mockImplementation((...args) => {
    if (args[0] === '/api/notes/note-two/meta') return Promise.resolve({ ...other, editorMode: 'full' });
    if (args[0] === '/api/notes/note-two') return Promise.resolve(other);
    if (args[1] === 'PUT') return Promise.resolve(response(args[2].content));
    return request(...args);
  });
  let release!: () => void;
  const composition = new Promise<void>((resolve) => { release = resolve; });
  state.editorRef.value = { flush: () => composition, cancelPendingFocus() {} };
  const saving = state.save();
  await turn();
  // Navigation's current adapter is ready while the older flush reply is still held.
  state.editorRef.value = { flush: async () => {}, cancelPendingFocus() {} };
  state.draft.value = state.savedContent.value;
  await state.openNote('note-two');
  await state.openNote(original.id);
  state.draft.value = '# New editing session';
  release();
  await saving;
  expect(writes()).toHaveLength(0);
  expect(state.draft.value).toBe('# New editing session');
});

it('recomputes filename matches after a late directory arrives without retyping or another content request', async () => {
  await mount();
  const request = mockApi.getMockImplementation()!;
  let entries: any[] = [];
  mockApi.mockImplementation((...args) => {
    if (args[0] === '/api/tree') return Promise.resolve(entries);
    if (args[0] === '/api/search/advanced')
      return Promise.reject(new ApiError(503, { code: 'TOKENIZER_UNAVAILABLE' }));
    return request(...args);
  });
  vi.useFakeTimers();
  try {
    state.query.value = 'late-file';
    await Vue.nextTick();
    await vi.advanceTimersByTimeAsync(220);
    expect(state.results.value).toEqual([]);
    expect(state.searchError.value).toContain('文件名搜索仍可使用');
    entries = [{ type: 'note', id: 'late', name: 'late-file.md', path: '00-Inbox/late-file.md' }];
    await state.refresh();
    await Vue.nextTick();
    expect(state.results.value).toMatchObject([
      { id: 'late', relativePath: '00-Inbox/late-file.md', filenameMatch: true },
    ]);
    expect(mockApi.mock.calls.filter(([url]) => url === '/api/search/advanced')).toHaveLength(1);
  } finally { vi.useRealTimers(); }
});

it('refreshes filename fallbacks without losing a refined content hit or its match line', async () => {
  await mount();
  state.query.value = 'target';
  await Vue.nextTick();
  state.results.value = [
    { id: 'indexed', title: 'Content match', relativePath: '00-Inbox/content.md', snippet: 'Matched body', line: 38 },
    { id: 'old', title: 'Old fallback', relativePath: '00-Inbox/target-old.md', snippet: '', line: 1, filenameMatch: true },
  ];
  state.tree.value = [{ type: 'note', id: 'new', name: 'target-new.md', path: '00-Inbox/target-new.md' }];
  await Vue.nextTick();
  expect(state.results.value).toHaveLength(2);
  expect(state.results.value.find((item: any) => item.id === 'indexed')).toMatchObject({ line: 38, snippet: 'Matched body' });
  expect(state.results.value.find((item: any) => item.id === 'old')).toBeUndefined();
  expect(state.results.value.find((item: any) => item.id === 'new')).toMatchObject({ filenameMatch: true });
});
// Drain the current work without completing the explicitly held identity request.
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

it('manual refresh cannot publish an editable directory before draft ownership is confirmed', async () => {
  const release = holdIdentity();
  await mount(false);
  const refreshed = state.refresh();
  try {
    await turn();
    expect(state.treeLoaded.value).toBe(false);
    expect(state.note.value).toBeUndefined();
  } finally { release(); await refreshed; }
  await vi.waitFor(() => expect(state.note.value?.id).toBe(original.id));
});

it('a direct note open joins ownership validation before reading or exposing the note', async () => {
  const release = holdIdentity();
  await mount(false);
  const opened = state.openNote(original.id);
  try {
    await turn();
    expect(state.note.value).toBeUndefined();
    expect(mockApi.mock.calls.some(([url]) => url === '/api/notes/note-one/meta')).toBe(false);
  } finally { release(); await opened; }
  await vi.waitFor(() => expect(state.note.value?.content).toBe(original.content));
});

it('failed ownership validation leaves the editor closed until an explicit successful retry', async () => {
  const request = mockApi.getMockImplementation()!;
  let valid = false;
  mockApi.mockImplementation((...args) => args[0] === '/api/auth/get-session' && !valid ? Promise.resolve({}) : request(...args));
  await mount(false);
  await vi.waitFor(() => expect(state.draftError.value).not.toBe(''));
  await turn();
  expect(state.note.value).toBeUndefined();
  expect(state.treeLoaded.value).toBe(false);
  valid = true;
  await state.run(() => state.openNote(original.id));
  expect(state.note.value?.content).toBe(original.content);
});

it('settings supersedes queued startup and note navigation while identity is pending', async () => {
  const release = holdIdentity();
  await mount(false);
  const opened = state.openNote(original.id);
  await state.settings('editor');
  expect(state.panel.value).toBe('settings');
  release();
  await opened;
  await turn();
  expect(state.panel.value).toBe('settings');
  expect(state.note.value).toBeUndefined();
});

it('late ownership replies cannot initialize a draft store or open a note after unmount', async () => {
  realDraftLifecycle = true;
  const release = holdIdentity();
  await mount(false);
  cleanups.pop()!();
  release();
  await turn();
  expect(state.draftScope.value).toBeUndefined();
  expect(state.note.value).toBeUndefined();
  expect(state.treeLoaded.value).toBe(false);
});

it('newer settings navigation preserves an unconsumed welcome action during startup', async () => {
  const release = holdIdentity();
  const storage = { getItem: (key: string) => key === 'dooknow-welcome-action' ? 'create-note' : null, removeItem: vi.fn() };
  vi.stubGlobal('sessionStorage', storage);
  await mount(false);
  await state.settings('editor');
  release();
  await turn();
  expect(state.panel.value).toBe('settings');
  expect(state.createOpen.value).toBe(false);
  expect(storage.removeItem).not.toHaveBeenCalled();
});

it('the newest requested note owns navigation when multiple opens wait for identity', async () => {
  const request = mockApi.getMockImplementation()!;
  const second = { ...original, id: 'note-two', content: '# Newer selection', relativePath: '00-Inbox/two.md' };
  mockApi.mockImplementation((...args) => {
    if (args[0] === '/api/notes/note-two/meta') return Promise.resolve({ ...second, editorMode: 'full', sizeBytes: 17 });
    if (args[0] === '/api/notes/note-two') return Promise.resolve(second);
    return request(...args);
  });
  const release = holdIdentity();
  await mount(false);
  const first = state.openNote(original.id), newest = state.openNote(second.id);
  release();
  await Promise.all([first, newest]);
  await turn();
  expect(state.note.value?.id).toBe('note-two');
  expect(state.draft.value).toBe('# Newer selection');
  expect(state.selected.value).toBe('00-Inbox/two.md');
});

it('logout invalidates a pending draft identity before its old response can initialize storage', async () => {
  realDraftLifecycle = true;
  const release = holdIdentity();
  await mount(false);
  await state.logout();
  release();
  await turn();
  expect(state.draftScope.value).toBeUndefined();
  expect(state.draftIdentityReady.value).toBe(false);
  expect(state.note.value).toBeUndefined();
});

it('a refused logout holds the retained editor until fresh ownership validation finishes', async () => {
  await mount();
  state.draft.value = original.content;
  await Vue.nextTick();
  const release = holdIdentity();
  const held = mockApi.getMockImplementation()!;
  mockApi.mockImplementation((...args) => args[0] === '/api/auth/sign-out' ? Promise.reject(new Error('Sign-out unavailable')) : held(...args));
  const loggedOut = state.logout();
  await vi.waitFor(() => expect(state.draftIdentityReady.value).toBe(false));
  expect(state.formatDisabled.value).toBe(true);
  const reopened = state.openNote(original.id);
  release();
  await Promise.all([loggedOut, reopened]);
  expect(state.draftIdentityReady.value).toBe(true);
  expect(state.note.value?.content).toBe(original.content);
  expect(state.formatDisabled.value).toBe(false);
});

it('a folder history route waits for the winning initial directory read after refresh supersession', async () => {
  const request = mockApi.getMockImplementation()!;
  const entries = [{ type: 'folder', name: '00-Inbox', path: '00-Inbox', children: [] }];
  let trees = 0, releaseTree!: (entries: unknown) => void;
  const winningTree = new Promise((resolve) => { releaseTree = resolve; });
  mockApi.mockImplementation((...args) => args[0] === '/api/tree'
    ? (++trees >= 3 ? winningTree : Promise.resolve(entries)) : request(...args));
  const releaseIdentity = holdIdentity();
  await mount(false);
  const routed = state.applyRoute({ folder: '00-Inbox' });
  const refreshed = state.refresh();
  releaseIdentity();
  await turn();
  releaseTree(entries);
  await Promise.all([routed, refreshed]);
  await turn();
  expect(state.treeLoaded.value).toBe(true);
  expect(state.panel.value).toBe('folder');
  expect(state.folder.value).toBe('00-Inbox');
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});

it('starts initial reads together but publishes no tree or note before draft identity resolves', async () => {
  const request = mockApi.getMockImplementation()!;
  let finish!: (value: unknown) => void;
  const identity = new Promise((resolve) => { finish = resolve; });
  mockApi.mockImplementation((...args) => args[0] === '/api/auth/get-session' ? identity : request(...args));
  await mount(false);
  try {
    await vi.waitFor(() => expect(mockApi.mock.calls.some(([url]) => url === '/api/tree')).toBe(true));
    expect(state.treeLoaded.value).toBe(false);
    expect(state.note.value).toBeUndefined();
    expect(mockApi.mock.calls.some(([url]) => url === '/api/notes/note-one/meta')).toBe(false);
  } finally { finish({ user: { id: 'owner' } }); }
  await vi.waitFor(() => expect(state.note.value?.content).toBe(original.content));
  expect(state.treeLoaded.value).toBe(true);
});

it('starts body and attachment reads together but opens only the complete note', async () => {
  const request = mockApi.getMockImplementation()!;
  let finish!: (value: unknown) => void;
  const document = new Promise((resolve) => { finish = resolve; });
  mockApi.mockImplementation((...args) => args[0] === '/api/notes/note-one' ? document : request(...args));
  await mount(false);
  try {
    await vi.waitFor(() => expect(mockApi.mock.calls.some(([url]) => url === '/api/notes/note-one')).toBe(true));
    expect(mockApi.mock.calls.some(([url]) => url === '/api/notes/note-one/assets')).toBe(true);
    expect(state.note.value).toBeUndefined();
  } finally { finish({ ...original }); }
  await vi.waitFor(() => expect(state.note.value?.content).toBe(original.content));
  expect(writes()).toHaveLength(0);
});

it.each(['folder', 'welcome'] as const)('keeps initial %s actions after a refresh supersedes the prefetched tree', async (route) => {
  const request = mockApi.getMockImplementation()!;
  const entries = [{ type: 'folder', name: '00-Inbox', path: '00-Inbox', children: [] }];
  let identityReady!: (value: unknown) => void, refreshReady!: (value: unknown) => void;
  const identity = new Promise((resolve) => { identityReady = resolve; });
  const manual = new Promise((resolve) => { refreshReady = resolve; });
  const storage = { getItem: vi.fn(() => route === 'welcome' ? 'create-note' : null), removeItem: vi.fn() };
  vi.stubGlobal('sessionStorage', storage);
  window.location.search = route === 'folder' ? '?folder=00-Inbox' : '';
  window.location.href = 'http://isolated.invalid/' + window.location.search;
  let holdNextTree = false;
  mockApi.mockImplementation((...args) => {
    if (args[0] === '/api/auth/get-session') return identity;
    if (args[0] === '/api/tree') {
      if (holdNextTree) { holdNextTree = false; return manual; }
      return Promise.resolve(entries);
    }
    return request(...args);
  });
  await mount(false);
  holdNextTree = true;
  const refreshed = state.refresh();
  try {
    identityReady({ user: { id: 'owner' } });
    // Startup may now join the winning manual read instead of issuing another
    // read. Release that real prerequisite before waiting for its route/action.
    await turn();
  } finally { refreshReady(entries); await refreshed; }
  await vi.waitFor(() => expect(storage.getItem).toHaveBeenCalledWith('dooknow-welcome-action'));
  expect(state.treeLoaded.value).toBe(true);
  if (route === 'folder') {
    expect(state.panel.value).toBe('folder');
    expect(state.folder.value).toBe('00-Inbox');
  } else expect(state.createOpen.value).toBe(true);
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

it.each(['note', 'settings'])(
  'reloads the selected clean note and tree after a workspace-wide remote update while preserving the %s panel',
  async (panel) => {
    await mount();
    state.panel.value = panel;
    state.draft.value = original.content;
    const remote = { ...original, content: '# Updated in cloud', modifiedAt: 'remote-two' };
    const tree = [
      { type: 'note', path: '00-Inbox/cloud-new.md', id: 'cloud-new', name: 'cloud-new.md' },
    ];
    mockApi.mockImplementation(async (url: string) => {
      if (url === '/api/tree') return tree;
      if (url.endsWith('/meta')) return { ...meta, modifiedAt: remote.modifiedAt };
      if (url === '/api/notes/note-one') return remote;
      return [];
    });
    state.workspaceChanged(
      new CustomEvent('dooknow-workspace-changed', { detail: { scope: 'workspace' } }),
    );
    await vi.waitFor(() => expect(state.tree.value).toEqual(tree));
    await vi.waitFor(() => expect(state.draft.value).toBe(remote.content));
    expect(state.note.value.modifiedAt).toBe(remote.modifiedAt);
    expect(state.dirty.value).toBe(false);
    expect(state.panel.value).toBe(panel);
    expect(() => state.workspaceChanged(new Event('dooknow-workspace-changed'))).not.toThrow();
  },
);

it('preserves a note draft typed while the post-pull tree refresh is pending', async () => {
  await mount();
  state.draft.value = original.content;
  let finish!: (value: any[]) => void;
  const reading = new Promise<any[]>((resolve) => {
    finish = resolve;
  });
  mockApi.mockImplementation(async (url: string) => (url === '/api/tree' ? reading : []));
  state.workspaceChanged(
    new CustomEvent('dooknow-workspace-changed', { detail: { scope: 'workspace' } }),
  );
  state.draft.value = '# Typed while refresh was pending';
  finish([{ type: 'folder', path: 'remote-folder', name: 'remote-folder' }]);
  await vi.waitFor(() => expect(state.tree.value).toHaveLength(1));
  expect(state.draft.value).toBe('# Typed while refresh was pending');
  expect(state.note.value.content).toBe(original.content);
  expect(state.notice.value).toContain('草稿会保留');
  expect(state.leaveOpen.value).toBe(false);
});

it('preserves a draft typed while the clean selected note is being reloaded', async () => {
  await mount();
  state.draft.value = original.content;
  let finish!: (value: typeof original) => void;
  const reading = new Promise<typeof original>((resolve) => {
    finish = resolve;
  });
  mockApi.mockImplementation(async (url: string) => {
    if (url.endsWith('/meta')) return { ...meta, modifiedAt: 'remote-two' };
    if (url === '/api/notes/note-one') return reading;
    return [];
  });
  state.workspaceChanged(
    new CustomEvent('dooknow-workspace-changed', { detail: { scope: 'workspace' } }),
  );
  await vi.waitFor(() =>
    expect(mockApi.mock.calls.filter((call) => call[0] === '/api/notes/note-one')).toHaveLength(2),
  );
  state.draft.value = '# Typed while original was loading';
  finish({ ...original, content: '# Cloud update', modifiedAt: 'remote-two' });
  await vi.waitFor(() => expect(state.noteOpening.value).toBe(false));
  expect(state.draft.value).toBe('# Typed while original was loading');
  expect(state.note.value.content).toBe(original.content);
  expect(state.notice.value).toContain('草稿会保留');
});
