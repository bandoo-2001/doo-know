import { readFileSync } from 'node:fs';
import { compileScript, parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as Vue from 'vue';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as gitHistory from '../packages/plugin-ui/git-history';
import * as diffView from '../packages/plugin-ui/diff-view';
import * as noteHistory from '../apps/web/note-history';

const firstCommit = 'a'.repeat(40),
  nextCommit = 'b'.repeat(40);
const commit = (sha: string) => ({
  commit: sha,
  at: '2026-10-29T12:00:00Z',
  author: 'Fixture',
  message: sha === firstCommit ? 'First version' : 'Current version',
});
const mockApi = vi.fn();
const cleanups: (() => void)[] = [];
const pluginRegistry = Vue.shallowRef({ installed: [{ id: 'git', state: 'enabled' }] });
const descriptor = parse(
  readFileSync(new URL('../apps/web/components/NoteHistoryDialog.vue', import.meta.url), 'utf8'),
).descriptor;
const source = ts.transpileModule(
  compileScript(descriptor, { id: 'note-history-context' }).content,
  {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  },
).outputText;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function turn() {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Vue.nextTick();
}
function gitCalls(id?: string) {
  return mockApi.mock.calls.filter(
    (call) => call[0] === '/api/plugins/git/call' && (!id || call[2]?.id === id),
  );
}
async function mount() {
  const output: { exports: any } = { exports: {} };
  new Function('require', 'module', 'exports', source)(
    (id: string) => {
      if (id === 'vue') return Vue;
      if (id === '../api') return { api: mockApi };
      if (id === '../plugins') return { pluginRegistry };
      if (id === '../note-history') return noteHistory;
      if (id === '../../../packages/plugin-ui/git-history') return gitHistory;
      if (id === '../../../packages/plugin-ui/diff-view') return diffView;
      if (id.endsWith('.vue')) return { default: {}, __esModule: true };
      if (id === 'naive-ui' || id === 'ant-design-vue') return {};
      throw Error('Unexpected history dialog dependency: ' + id);
    },
    output,
    output.exports,
  );
  const component = output.exports.default,
    setup = component.setup;
  let state: any;
  component.setup = (props: any, context: any) => {
    state = setup(props, context);
    return () => null;
  };
  const props = Vue.reactive({
    show: true,
    noteId: 'note-one',
    title: 'First note',
    currentContent: '# Current saved content',
    currentModifiedAt: 'v1',
    dirty: false,
    busy: false,
  });
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
  const app = renderer.createApp({ setup: () => () => Vue.h(component, props) });
  app.mount({});
  cleanups.push(() => app.unmount());
  await turn();
  return { state, props };
}

beforeEach(() => {
  vi.stubGlobal('window', new EventTarget());
  mockApi.mockReset();
  mockApi.mockImplementation(async (url: string, method = 'GET', body?: any) => {
    if (/^\/api\/notes\/[^/]+\/revisions$/.test(url) && method === 'GET') return { items: [] };
    if (url === '/api/plugins/git/call' && method === 'POST') {
      if (body.id === 'git.history') return { items: [commit(firstCommit)] };
      if (body.id === 'git.diff')
        return { diff: 'Historical commit patch', restore: { supported: true } };
      if (body.id === 'git.restore')
        return { noteId: body.input.noteId, modifiedAt: 'restored-v2' };
    }
    throw Error('Unexpected history API call: ' + method + ' ' + url);
  });
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});

it('keeps an uncertain Git restore visible across note changes and resets to the new note only after reconciliation', async () => {
  const { state, props } = await mount();
  const changed: string[] = [];
  window.addEventListener('dooknow-workspace-changed', (event) =>
    changed.push((event as CustomEvent).detail.noteId),
  );
  await state.changeSource('git');
  expect(state.git.diffCommit).toBe(firstCommit);
  state.git.confirmRestore = true;
  const api = mockApi.getMockImplementation()!;
  let restores = 0;
  const reconciled = deferred<any>();
  mockApi.mockImplementation((...args) => {
    if (args[0] === '/api/plugins/git/call' && args[2]?.id === 'git.restore') {
      restores++;
      if (restores === 1) return Promise.reject(new TypeError('Failed to fetch'));
      return reconciled.promise;
    }
    return api(...args);
  });
  expect(await state.git.restore()).toBe(false);
  const original = { ...state.git.pendingRestore };
  expect(original).toMatchObject({
    noteId: 'note-one',
    commit: firstCommit,
    expectedModifiedAt: 'v1',
    requestId: expect.any(String),
  });
  props.noteId = 'note-two';
  props.currentModifiedAt = 'new-note-v1';
  await turn();
  expect(state.historySource.value).toBe('git');
  expect(state.git.pendingRestore).toEqual(original);
  const retry = state.git.restore();
  await turn();
  expect(state.historySource.value).toBe('git');
  expect(state.git.busy).toBe(true);
  expect(state.git.pendingRestore).toEqual(original);
  expect(gitCalls('git.restore').map((call) => call[2].input)).toEqual([original, original]);
  reconciled.resolve({ noteId: 'note-one', modifiedAt: 'restored-v2' });
  expect(await retry).toBe(true);
  await turn();
  expect(changed).toEqual(['note-one']);
  expect(state.git.pendingRestore).toBeUndefined();
  expect(state.git.busy).toBe(false);
  expect(state.historySource.value).toBe('saved');
  expect(state.git.rows).toEqual([]);
  expect(mockApi.mock.calls.some((call) => call[0] === '/api/notes/note-two/revisions')).toBe(true);
});

it('replaces an in-flight Git list after a baseline change and ignores the stale list instead of showing false empty history', async () => {
  const { state, props } = await mount();
  const oldHistory = deferred<any>();
  const api = mockApi.getMockImplementation()!;
  let reads = 0;
  mockApi.mockImplementation((...args) => {
    if (args[0] === '/api/plugins/git/call' && args[2]?.id === 'git.history') {
      reads++;
      return reads === 1 ? oldHistory.promise : Promise.resolve({ items: [commit(nextCommit)] });
    }
    return api(...args);
  });
  const opening = state.changeSource('git');
  expect(state.git.loading).toBe(true);
  props.currentModifiedAt = 'v2';
  await turn();
  oldHistory.resolve({ items: [commit(firstCommit)] });
  await opening;
  await turn();
  expect(gitCalls('git.history')).toHaveLength(2);
  expect(state.git.rows.map((row: any) => row.commit)).toEqual([nextCommit]);
  expect(state.git.diffCommit).toBe(nextCommit);
  expect(state.git.loading).toBe(false);
  expect(gitCalls('git.diff').map((call) => call[2].input)).toEqual([
    { noteId: 'note-one', commit: nextCommit },
  ]);
});

it('refreshes cached Git history when returning after a saved-source baseline change without Git requests while saved', async () => {
  const { state, props } = await mount();
  await state.changeSource('git');
  expect(state.git.diffCommit).toBe(firstCommit);
  await state.changeSource('saved');
  const before = gitCalls().length;
  props.currentModifiedAt = 'v2';
  await turn();
  expect(gitCalls()).toHaveLength(before);
  await state.changeSource('git');
  expect(gitCalls('git.history')).toHaveLength(2);
  expect(gitCalls('git.diff')).toHaveLength(2);
  expect(state.git.diffCommit).toBe(firstCommit);
  state.git.confirmRestore = true;
  expect(await state.git.restore()).toBe(true);
  expect(gitCalls('git.restore')).toHaveLength(1);
  expect(gitCalls('git.restore')[0][2].input).toMatchObject({
    noteId: 'note-one',
    commit: firstCommit,
    expectedModifiedAt: 'v2',
  });
});

it('uses historical original view after a Git restore preserves an old draft baseline until a fresh saved baseline arrives', async () => {
  const { state, props } = await mount();
  props.dirty = true;
  await turn();
  await state.changeSource('git');
  state.git.confirmRestore = true;
  expect(await state.git.restore()).toBe(true);
  expect(props.currentModifiedAt).toBe('v1');
  expect(props.currentContent).toBe('# Current saved content');

  const revision = {
    id: 'before-git-restore',
    createdAt: '2026-10-29T11:00:00Z',
    modifiedAt: '2026-10-29T10:00:00Z',
    sizeBytes: 16,
  };
  const api = mockApi.getMockImplementation()!;
  mockApi.mockImplementation((...args) => {
    if (args[0] === '/api/notes/note-one/revisions') return Promise.resolve({ items: [revision] });
    if (args[0] === '/api/notes/note-one/revisions/before-git-restore/read')
      return Promise.resolve({
        kind: 'ready',
        data: {
          snapshotId: 'immutable-before-git-restore',
          sourceHash: 'c'.repeat(64),
          modifiedAt: revision.modifiedAt,
          bytesReturned: 16,
          budgetRemainingBytes: 1024 * 1024 - 16,
          rangeHash: 'd'.repeat(64),
          content: '# Saved original',
          startLine: 1,
          endLine: 1,
          startByte: 0,
          endByte: 16,
          lineByteOffset: 0,
          hasMore: false,
        },
      });
    return api(...args);
  });
  await state.changeSource('saved');
  await vi.waitFor(() => expect(state.complete.value).toBe(true));
  expect(state.source.value).toBe('# Saved original');
  expect(state.mode.value).toBe('source');
  expect(state.canCompare(revision)).toBe(false);
  expect(state.patch.value).toBeUndefined();
  expect(state.compareNotice.value).toMatch(/草稿|基准|恢复后|最新原文/);

  props.currentContent = '# Newly loaded original';
  props.currentModifiedAt = 'fresh-after-git-restore';
  await vi.waitFor(() => {
    expect(state.mode.value).toBe('compare');
    expect(state.patch.value).toContain('+# Newly loaded original');
  });
  expect(state.canCompare(revision)).toBe(true);
  expect(state.patch.value).not.toContain('# Current saved content');
});
