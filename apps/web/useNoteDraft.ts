import { ref, shallowRef, watch, onBeforeUnmount } from 'vue';
import {
  createDraftStore,
  clearOwnerDrafts,
  type DraftRecord,
  type DraftScope,
  type DraftStore,
} from './drafts';
type Context = {
  noteId?: string;
  baseRevision: string;
  content: string;
  dirty: boolean;
  enabled: boolean;
};
export function useNoteDraft(context: () => Context, restoreContent: (text: string) => void) {
  const scope = shallowRef<DraftScope>(),
    recovered = shallowRef<DraftRecord>();
  const loading = ref(false),
    busy = ref(false),
    error = ref(''),
    savedAt = ref<number>();
  const versions = new Map<string, DraftRecord>();
  let store: DraftStore | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let queue: Promise<void> = Promise.resolve(),
    epoch = 0,
    stopped = false;
  function setup(value: DraftScope) {
    clearTimeout(timer);
    epoch++;
    stopped = false;
    recovered.value = undefined;
    versions.clear();
    savedAt.value = undefined;
    scope.value = value;
    store = createDraftStore({ scope: value });
  }
  function prepare() {
    clearTimeout(timer);
    epoch++;
    recovered.value = undefined;
    savedAt.value = undefined;
    loading.value = !!store;
  }
  function report(cause: unknown) {
    error.value = cause instanceof Error ? cause.message : '本地草稿暂未保存，请手动保存原文。';
  }
  function persist(snapshot = context()): Promise<DraftRecord | undefined> {
    const target = store,
      current = epoch;
    if (
      stopped ||
      !target ||
      !snapshot.enabled ||
      !snapshot.noteId ||
      recovered.value ||
      loading.value ||
      busy.value
    )
      return queue.then(() => undefined);
    const isDirty = snapshot.dirty;
    const input = {
      noteId: snapshot.noteId,
      kind: 'note' as const,
      content: snapshot.content,
      baseRevision: snapshot.baseRevision,
    };
    const write = queue
      .then(async () => {
        if (!isDirty) {
          if (target !== store) return undefined;
          // An earlier queued write may only now have supplied our version.
          const previous = versions.get(input.noteId);
          if (!previous) return undefined;
          const removed = await target.remove(input.noteId, previous.version);
          if (!removed) throw new Error('本地草稿已在其他页面变化，请重新打开笔记核对。');
          if (target === store && versions.get(input.noteId)?.version === previous.version)
            versions.delete(input.noteId);
          if (target === store && current === epoch && context().noteId === input.noteId) {
            savedAt.value = undefined;
            error.value = '';
          }
          return undefined;
        }
        const saved = await target.put(input);
        if (target === store) versions.set(input.noteId, saved);
        if (target === store && current === epoch && context().noteId === input.noteId) {
          savedAt.value = saved.updatedAt;
          error.value = '';
        }
        return saved;
      })
      .catch((cause) => {
        if (target === store && current === epoch) {
          savedAt.value = undefined;
          report(cause);
        }
        return undefined;
      });
    queue = write.then(() => undefined);
    return write;
  }
  async function flush() {
    clearTimeout(timer);
    timer = undefined;
    const snapshot = { ...context() };
    const saved = await persist(snapshot);
    return saved &&
      saved.noteId === snapshot.noteId &&
      saved.content === snapshot.content &&
      saved.baseRevision === snapshot.baseRevision
      ? saved.version
      : undefined;
  }
  async function load(noteId: string, baseRevision: string, original: string) {
    const current = epoch,
      target = store;
    if (!target) {
      loading.value = false;
      return;
    }
    try {
      await queue;
      const saved = await target.load(noteId);
      if (current !== epoch || context().noteId !== noteId) return;
      if (saved?.kind === 'note' || saved?.kind === 'fragment') {
        versions.set(noteId, saved);
        if (saved.kind === 'note' && saved.content === original) {
          const removed = await target.remove(noteId, saved.version);
          if (current !== epoch || target !== store) return;
          if (!removed) throw new Error('本地草稿已在其他页面变化，请重新打开笔记核对。');
          if (versions.get(noteId)?.version === saved.version) versions.delete(noteId);
        } else recovered.value = saved;
      }
      error.value = '';
    } catch (cause) {
      if (current === epoch) report(cause);
    } finally {
      if (current === epoch) loading.value = false;
    }
  }
  async function clearSaved(noteId: string, version?: string) {
    if (!store || !version) return;
    const target = store;
    try {
      await queue;
      const removed = await target.remove(noteId, version);
      if (target === store && removed && versions.get(noteId)?.version === version) {
        versions.delete(noteId);
        if (context().noteId === noteId) savedAt.value = undefined;
      }
    } catch (cause) {
      report(cause);
    }
  }
  async function discard() {
    clearTimeout(timer);
    timer = undefined;
    busy.value = true;
    const target = context().noteId,
      targetStore = store,
      current = epoch;
    try {
      await queue;
      if (current !== epoch || targetStore !== store) return;
      const record = recovered.value || (target ? versions.get(target) : undefined);
      if (record && targetStore) {
        const removed = await targetStore.remove(record.noteId, record.version);
        if (!removed) throw new Error('本地草稿已在其他页面变化，请重新打开笔记核对。');
        versions.delete(record.noteId);
      }
      if (current === epoch) {
        recovered.value = undefined;
        savedAt.value = undefined;
        error.value = '';
      }
    } catch (cause) {
      report(cause);
      throw cause;
    } finally {
      busy.value = false;
    }
  }
  function restore() {
    const record = recovered.value;
    if (
      !record ||
      record.kind !== 'note' ||
      busy.value ||
      loading.value ||
      stopped ||
      record.noteId !== context().noteId
    )
      return;
    recovered.value = undefined;
    restoreContent(record.content);
    void persist();
  }
  async function logout() {
    clearTimeout(timer);
    stopped = true;
    epoch++;
    await queue;
    if (scope.value) await clearOwnerDrafts(scope.value.ownerId);
    versions.clear();
    recovered.value = undefined;
  }
  watch(
    () => {
      const c = context();
      return [c.noteId, c.content, c.dirty, c.enabled] as const;
    },
    () => {
      clearTimeout(timer);
      const c = context();
      if (!stopped && !busy.value && c.enabled && !recovered.value && !loading.value)
        timer = setTimeout(() => void persist(), 150);
    },
    { flush: 'post' },
  );
  function hidden() {
    if (document.visibilityState === 'hidden') void flush();
  }
  function pagehide() {
    void flush();
  }
  window.addEventListener('pagehide', pagehide);
  document.addEventListener('visibilitychange', hidden);
  onBeforeUnmount(() => {
    void flush();
    window.removeEventListener('pagehide', pagehide);
    document.removeEventListener('visibilitychange', hidden);
  });
  return {
    scope,
    recovered,
    loading,
    busy,
    error,
    savedAt,
    setup,
    prepare,
    load,
    flush,
    clearSaved,
    discard,
    restore,
    logout,
  };
}
