import { describe, expect, it, vi } from 'vitest';
import { createGitHistoryModel } from '../packages/plugin-ui/git-history';

const a = 'a'.repeat(40),
  b = 'b'.repeat(40);
const entry = (commit: string) => ({
  commit,
  at: '2026-10-29T12:00:00Z',
  author: 'Fixture',
  message: commit,
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture(
  options: {
    expectedModifiedAt?: string;
    onRestored?: (noteId: string) => void | Promise<void>;
  } = {},
) {
  const context = {
    noteId: 'note',
    expectedModifiedAt: 'expectedModifiedAt' in options ? options.expectedModifiedAt : 'v1',
  };
  const calls: { kind: string; id: string; input: any }[] = [];
  const handler = vi.fn(async (_kind: string, id: string, input: any): Promise<any> => {
    if (id === 'git.history') return { items: [entry(a)], nextCursor: 'older' };
    if (id === 'git.diff')
      return { diff: 'change at ' + input.commit, restore: { supported: true } };
    if (id === 'git.restore') return { noteId: input.noteId, modifiedAt: 'v2' };
    throw Error('Unexpected call ' + id);
  });
  const model = createGitHistoryModel({
    context: () => ({ ...context }),
    call: async (kind, id, input) => {
      calls.push({ kind, id, input });
      return handler(kind, id, input);
    },
    onRestored: options.onRestored,
  });
  return { model, context, calls, handler };
}
async function confirming(model: ReturnType<typeof createGitHistoryModel>) {
  await model.show(a);
  model.confirmRestore.value = true;
}

describe('shared Git history model', () => {
  it('loads pages with the note and cursor and clears an earlier list error on retry', async () => {
    const { model, calls, handler } = fixture();
    handler.mockRejectedValueOnce(Error('history unavailable'));
    await model.load();
    expect(model.error.value).toContain('history unavailable');
    await model.load();
    handler.mockResolvedValueOnce({ items: [entry(b)] });
    await model.load(true);
    expect(model.rows.value.map((row) => row.commit)).toEqual([a, b]);
    expect(calls.at(-1)).toEqual({
      kind: 'provider',
      id: 'git.history',
      input: { noteId: 'note', cursor: 'older' },
    });
    expect(model.cursor.value).toBeUndefined();
    expect(model.loading.value).toBe(false);
    expect(model.error.value).toBe('');
  });

  it.each(['note', 'baseline', 'reset', 'dispose'])(
    'ignores late lists and differences after %s changes',
    async (change) => {
      const { model, context, handler } = fixture();
      const list = deferred<any>(),
        diff = deferred<any>();
      handler.mockImplementationOnce(() => list.promise).mockImplementationOnce(() => diff.promise);
      const loading = model.load(),
        showing = model.show(a);
      if (change === 'note') context.noteId = 'another-note';
      if (change === 'baseline') context.expectedModifiedAt = 'v2';
      if (change === 'reset') model.reset();
      if (change === 'dispose') model.dispose();
      list.resolve({ items: [entry(a)], nextCursor: 'stale' });
      diff.resolve({
        diff: 'stale patch',
        restore: { supported: false, code: 'GIT_VERSION_NOT_FOUND' },
      });
      await Promise.all([loading, showing]);
      expect(model.rows.value).toEqual([]);
      expect(model.cursor.value).toBeUndefined();
      expect(model.diff.value).toBe('');
      expect(model.diffCommit.value).toBeUndefined();
      expect(model.restoreBlockedCode.value).toBe('');
    },
  );

  it('does not let an old list overwrite a newer reload or an old patch overwrite the selection', async () => {
    const { model, handler } = fixture();
    const oldList = deferred<any>(),
      oldDiff = deferred<any>();
    handler.mockImplementationOnce(() => oldList.promise);
    const firstList = model.load();
    handler.mockResolvedValueOnce({ items: [entry(b)] });
    await model.load();
    oldList.resolve({ items: [entry(a)], nextCursor: 'old' });
    await firstList;
    expect(model.rows.value.map((row) => row.commit)).toEqual([b]);
    handler.mockImplementationOnce(() => oldDiff.promise);
    const firstDiff = model.show(a);
    await model.show(b);
    oldDiff.resolve({ diff: 'old patch' });
    await firstDiff;
    expect(model.selected.value).toBe(b);
    expect(model.diffCommit.value).toBe(b);
    expect(model.diff.value).toBe('change at ' + b);
  });

  it('keeps a selected failed difference unrestorable until a new difference succeeds', async () => {
    const { model, handler, calls } = fixture();
    await model.show(a);
    handler.mockRejectedValueOnce(Error('diff unavailable'));
    await model.show(b);
    model.confirmRestore.value = true;
    expect(await model.restore()).toBe(false);
    expect(model.diffCommit.value).toBeUndefined();
    expect(calls.filter((call) => call.id === 'git.restore')).toEqual([]);
    await model.show(b);
    expect(model.diffCommit.value).toBe(b);
  });

  it.each(['GIT_RESTORE_UNSUPPORTED', 'GIT_RESTORE_VERSION_TOO_LARGE', 'GIT_VERSION_NOT_FOUND'])(
    'keeps %s readable while rejecting restoration',
    async (code) => {
      const { model, handler, calls } = fixture();
      handler.mockResolvedValueOnce({
        diff: 'readable patch',
        restore: { supported: false, code },
      });
      await confirming(model);
      expect(model.diff.value).toBe('readable patch');
      expect(model.restoreBlockedCode.value).toBe(code);
      expect(await model.restore()).toBe(false);
      expect(calls.filter((call) => call.id === 'git.restore')).toEqual([]);
      await model.show(b);
      expect(model.restoreBlockedCode.value).toBe('');
    },
  );

  it('separates truncated difference display from restore capability', async () => {
    const { model, handler } = fixture();
    handler.mockResolvedValueOnce({ diff: '', truncated: true, restore: { supported: true } });
    await confirming(model);
    expect(model.diffTruncated.value).toBe(true);
    expect(model.diff.value).toContain('256 KiB');
    expect(model.restoreBlockedCode.value).toBe('');
    expect(await model.restore()).toBe(true);
  });

  it('refuses restoration without the saved-note baseline', async () => {
    const { model, calls } = fixture({ expectedModifiedAt: undefined });
    await confirming(model);
    expect(await model.restore()).toBe(false);
    expect(model.restoreNeedsReload.value).toBe(true);
    expect(model.confirmRestore.value).toBe(false);
    expect(calls.filter((call) => call.id === 'git.restore')).toEqual([]);
  });

  it('keeps the original request and target locked through transport failures and reset attempts', async () => {
    const { model, handler, calls } = fixture();
    await confirming(model);
    const result = deferred<any>();
    handler.mockImplementationOnce(() => result.promise);
    const restoring = model.restore();
    const original = { ...model.pendingRestore.value };
    expect(original).toMatchObject({
      noteId: 'note',
      commit: a,
      expectedModifiedAt: 'v1',
      requestId: expect.any(String),
    });
    model.cancelRestore();
    await model.show(b);
    model.reset();
    expect(model.pendingRestore.value).toEqual(original);
    expect(model.selected.value).toBe(a);
    expect(await model.restore()).toBe(false);
    result.reject(Error('connection interrupted'));
    expect(await restoring).toBe(false);
    model.cancelRestore();
    model.reset();
    expect(model.confirmRestore.value).toBe(true);
    expect(model.pendingRestore.value).toEqual(original);
    await model.show(b);
    expect(model.selected.value).toBe(a);
    expect(await model.restore()).toBe(true);
    expect(calls.filter((call) => call.id === 'git.restore').map((call) => call.input)).toEqual([
      original,
      original,
    ]);
    expect(model.pendingRestore.value).toBeUndefined();
  });

  it.each([
    { status: 503, data: { code: 'SERVER_ERROR' } },
    { status: 409, data: { code: 'RESTORE_OUTCOME_UNKNOWN', retryable: false } },
    { statusCode: 409, data: { error: { code: 'WORKSPACE_BUSY', retryable: true } } },
  ])('keeps uncertain or retryable failures pending: %j', async (failure) => {
    const { model, handler } = fixture();
    await confirming(model);
    handler.mockRejectedValueOnce(failure);
    expect(await model.restore()).toBe(false);
    expect(model.pendingRestore.value?.commit).toBe(a);
    expect(model.confirmRestore.value).toBe(true);
    expect(model.restoreNeedsReload.value).toBe(false);
  });

  it('clears a terminal rejection and prevents restoring again with stale note metadata', async () => {
    const { model, handler, calls } = fixture();
    await confirming(model);
    handler.mockRejectedValueOnce({
      status: 409,
      data: { code: 'VERSION_CONFLICT', retryable: false },
    });
    expect(await model.restore()).toBe(false);
    expect(model.pendingRestore.value).toBeUndefined();
    expect(model.restoreNeedsReload.value).toBe(true);
    await model.show(b);
    model.confirmRestore.value = true;
    expect(await model.restore()).toBe(false);
    expect(calls.filter((call) => call.id === 'git.restore')).toHaveLength(1);
  });

  it('does not lose a confirmed write or repeat it when the refresh callback fails', async () => {
    const restored: string[] = [];
    const { model, calls } = fixture({
      onRestored: async (noteId) => {
        restored.push(noteId);
        throw Error('refresh failed');
      },
    });
    await confirming(model);
    expect(await model.restore()).toBe(true);
    expect(restored).toEqual(['note']);
    expect(model.pendingRestore.value).toBeUndefined();
    expect(model.confirmRestore.value).toBe(false);
    expect(model.error.value).toContain('refresh failed');
    expect(await model.restore()).toBe(false);
    expect(calls.filter((call) => call.id === 'git.restore')).toHaveLength(1);
  });

  it('resets per-note state and never applies stale errors after disposal', async () => {
    const { model, handler } = fixture();
    await model.load();
    await confirming(model);
    model.reset();
    expect(model.rows.value).toEqual([]);
    expect(model.cursor.value).toBeUndefined();
    expect(model.selected.value).toBeUndefined();
    expect(model.confirmRestore.value).toBe(false);
    const response = deferred<any>();
    handler.mockImplementationOnce(() => response.promise);
    const loading = model.load();
    model.dispose();
    response.reject(Error('late error'));
    await loading;
    expect(model.error.value).toBe('');
    const count = handler.mock.calls.length;
    await model.load();
    await model.show(a);
    expect(await model.restore()).toBe(false);
    expect(handler.mock.calls).toHaveLength(count);
  });
});
