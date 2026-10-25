import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRenderer, nextTick, reactive, type App } from 'vue';
const storage = vi.hoisted(() => ({
  records: new Map<string, any>(),
  sequence: 0,
  gate: undefined as Promise<void> | undefined,
  failure: undefined as Error | undefined,
  removeFailure: undefined as Error | undefined,
}));
vi.mock('../apps/web/drafts', () => ({
  createDraftStore: () => ({
    async put(input: any) {
      if (storage.failure) throw storage.failure;
      const snapshot = structuredClone(input),
        version = String(++storage.sequence);
      await storage.gate;
      const record = {
        ...snapshot,
        version,
        updatedAt: Date.now(),
        scope: { ownerId: 'o', knowledgeId: 'k' },
      };
      storage.records.set(input.noteId, record);
      return record;
    },
    async load(noteId: string) {
      return structuredClone(storage.records.get(noteId));
    },
    async remove(noteId: string, version: string) {
      if (storage.removeFailure) throw storage.removeFailure;
      if (storage.records.get(noteId)?.version !== version) return false;
      storage.records.delete(noteId);
      return true;
    },
  }),
  async clearOwnerDrafts() {
    storage.records.clear();
  },
}));
import { useNoteDraft } from '../apps/web/useNoteDraft';

let app: App, drafts: ReturnType<typeof useNoteDraft>;
let state: {
  noteId: string;
  baseRevision: string;
  content: string;
  dirty: boolean;
  enabled: boolean;
};
const renderer = createRenderer<any, any>({
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
beforeEach(() => {
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
  storage.records.clear();
  storage.sequence = 0;
  storage.gate = undefined;
  storage.failure = undefined;
  storage.removeFailure = undefined;
  state = reactive({
    noteId: 'n',
    baseRevision: 'base-1',
    content: 'original',
    dirty: false,
    enabled: true,
  });
  app = renderer.createApp({
    setup() {
      drafts = useNoteDraft(
        () => state,
        (content) => {
          state.content = content;
          state.dirty = true;
        },
      );
      return () => null;
    },
  });
  app.mount({});
  drafts.setup({ ownerId: 'o', knowledgeId: 'k' });
});
afterEach(async () => {
  await drafts.logout();
  app.unmount();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('note local draft coordination', () => {
  test('undoing to the saved source removes its durable draft before loading a newer base', async () => {
    state.content = 'unsaved edit';
    state.dirty = true;
    await drafts.flush();
    state.content = 'original';
    state.dirty = false;
    await drafts.flush();
    expect(storage.records.get('n')).toBeUndefined();
    expect(drafts.savedAt.value).toBeUndefined();
    drafts.prepare();
    state.baseRevision = 'base-2';
    state.content = 'remote update';
    await drafts.load('n', 'base-2', 'remote update');
    expect(drafts.recovered.value).toBeUndefined();
    expect(state.content).toBe('remote update');
  });

  test('undoing removes the durable draft without requiring navigation or an explicit flush', async () => {
    vi.useFakeTimers();
    state.content = 'unsaved edit';
    state.dirty = true;
    await drafts.flush();
    await nextTick();
    state.content = 'original';
    state.dirty = false;
    await nextTick();
    await vi.advanceTimersByTimeAsync(150);
    expect(storage.records.get('n')).toBeUndefined();
    expect(drafts.savedAt.value).toBeUndefined();
  });

  test('cleaning waits for the version from its still-pending first write', async () => {
    let release!: () => void;
    storage.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    state.content = 'pending unsaved edit';
    state.dirty = true;
    const writing = drafts.flush();
    await Promise.resolve();
    state.content = 'original';
    state.dirty = false;
    const cleaning = drafts.flush();
    release();
    await Promise.all([writing, cleaning]);
    expect(storage.records.get('n')).toBeUndefined();
    expect(drafts.savedAt.value).toBeUndefined();
  });

  test('typing after a queued clean snapshot stays durable', async () => {
    let release!: () => void;
    storage.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    state.content = 'earlier edit';
    state.dirty = true;
    const writing = drafts.flush();
    state.content = 'original';
    state.dirty = false;
    const cleaning = drafts.flush();
    state.content = 'later edit';
    state.dirty = true;
    const later = drafts.flush();
    release();
    await Promise.all([writing, cleaning, later]);
    expect(storage.records.get('n')?.content).toBe('later edit');
    expect(drafts.savedAt.value).toEqual(expect.any(Number));
  });

  test('undo cleanup preserves a newer draft from another page and reports the conflict', async () => {
    state.content = 'own edit';
    state.dirty = true;
    await drafts.flush();
    storage.records.set('n', {
      ...storage.records.get('n'),
      content: 'newer foreign edit',
      version: 'foreign',
    });
    state.content = 'original';
    state.dirty = false;
    await drafts.flush();
    expect(storage.records.get('n')?.content).toBe('newer foreign edit');
    expect(drafts.error.value).toContain('其他页面');
    expect(drafts.savedAt.value).toBeUndefined();
  });

  test('a failed undo cleanup leaves the durable draft available and reports the failure', async () => {
    state.content = 'own edit';
    state.dirty = true;
    await drafts.flush();
    storage.removeFailure = new Error('本地草稿清理失败');
    state.content = 'original';
    state.dirty = false;
    await drafts.flush();
    expect(storage.records.get('n')?.content).toBe('own edit');
    expect(drafts.error.value).toBe('本地草稿清理失败');
    expect(drafts.savedAt.value).toBeUndefined();
  });

  test.each(['disabled', 'loading', 'recovered'])(
    'clean snapshots preserve existing drafts while %s',
    async (gate) => {
      state.content = 'own edit';
      state.dirty = true;
      await drafts.flush();
      state.content = 'original';
      state.dirty = false;
      if (gate === 'disabled') state.enabled = false;
      else {
        drafts.prepare();
        if (gate === 'recovered') await drafts.load('n', 'base-2', 'remote source');
      }
      await drafts.flush();
      expect(storage.records.get('n')?.content).toBe('own edit');
    },
  );

  test('a rejected latest write clears its earlier durable timestamp and returns no saved version', async () => {
    state.content = 'earlier own durable text';
    state.dirty = true;
    await drafts.flush();
    expect(drafts.savedAt.value).toEqual(expect.any(Number));
    storage.records.set('n', {
      noteId: 'n',
      content: 'foreign durable text',
      version: 'foreign',
      baseRevision: 'base-1',
      kind: 'note',
      updatedAt: 1,
      scope: { ownerId: 'o', knowledgeId: 'k' },
    });
    storage.failure = Object.assign(new Error('本地草稿已在其他页面变化，本页未覆盖。'), {
      code: 'conflict',
    });
    state.content = 'latest current unsaved text';
    const version = await drafts.flush();
    expect(version).toBeUndefined();
    expect(drafts.savedAt.value).toBeUndefined();
    expect(drafts.error.value).toContain('其他页面');
    expect(state.content).toBe('latest current unsaved text');
  });

  test('an earlier large-file fragment stays copyable when the current note becomes a full document', async () => {
    storage.records.set('n', {
      noteId: 'n',
      kind: 'fragment',
      content: 'earlier fragment',
      baseRevision: 'large-base',
      version: 'fragment-version',
      updatedAt: 1,
      scope: { ownerId: 'o', knowledgeId: 'k' },
      range: {
        startLine: 101,
        endLine: 200,
        startByte: 1000,
        endByte: 2000,
        lineByteOffset: 0,
        rangeHash: 'range',
      },
    });
    state.content = 'current complete source';
    drafts.prepare();
    await drafts.load('n', 'small-base', 'current complete source');
    expect(drafts.recovered.value?.content).toBe('earlier fragment');
    expect(drafts.recovered.value?.kind).toBe('fragment');
    drafts.restore();
    expect(state.content).toBe('current complete source');
    expect(drafts.recovered.value?.version).toBe('fragment-version');
  });
  test('discard waits for its own pending write and deletes the version that actually reached storage', async () => {
    let release!: () => void;
    storage.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    state.content = 'unsaved';
    state.dirty = true;
    const saving = drafts.flush();
    await Promise.resolve();
    const discarding = drafts.discard();
    release();
    await Promise.all([saving, discarding]);
    expect(storage.records.get('n')).toBeUndefined();
    expect(drafts.error.value).toBe('');
  });

  test('flush identifies its original snapshot and clearing that save preserves subsequent typing', async () => {
    let release!: () => void;
    storage.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    state.content = 'submitted';
    state.dirty = true;
    const submittedVersion = drafts.flush();
    await Promise.resolve();
    state.content = 'typed during save';
    const nextVersion = drafts.flush();
    release();
    const [submitted, next] = await Promise.all([submittedVersion, nextVersion]);
    expect(submitted).toEqual(expect.any(String));
    expect(next).not.toBe(submitted);
    await drafts.clearSaved('n', submitted);
    expect(storage.records.get('n')?.content).toBe('typed during save');
  });

  test('prepare blocks persistence until recovery has been loaded for the selected note', async () => {
    state.content = 'loading transient content';
    state.dirty = true;
    drafts.prepare();
    await drafts.flush();
    expect(storage.records.get('n')).toBeUndefined();
    expect(drafts.loading.value).toBe(true);
    await drafts.load('n', 'base-1', 'original');
    await nextTick();
    expect(drafts.loading.value).toBe(false);
    await drafts.flush();
    expect(storage.records.get('n')?.content).toBe('loading transient content');
  });

  test('changed source is never overwritten during load and restore only updates the editor callback', async () => {
    storage.records.set('n', {
      noteId: 'n',
      kind: 'note',
      content: 'local text',
      baseRevision: 'old-base',
      version: 'saved',
      updatedAt: 1,
      scope: { ownerId: 'o', knowledgeId: 'k' },
    });
    state.baseRevision = 'new-base';
    state.content = 'new source';
    drafts.prepare();
    await drafts.load('n', 'new-base', 'new source');
    expect(state.content).toBe('new source');
    expect(drafts.recovered.value?.baseRevision).toBe('old-base');
    drafts.restore();
    expect(state.content).toBe('local text');
    expect(state.baseRevision).toBe('new-base');
    await drafts.flush();
    expect(storage.records.get('n')?.content).toBe('local text');
    expect(storage.records.get('n')?.baseRevision).toBe('new-base');
  });
});
