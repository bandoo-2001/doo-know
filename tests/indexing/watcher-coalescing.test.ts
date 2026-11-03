import { afterEach, expect, it, vi } from 'vitest';
const observation = vi.hoisted(() => ({
  callback: undefined as undefined | ((event: string, name: string) => void),
}));
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  watch: (_root: unknown, _options: unknown, callback: typeof observation.callback) => {
    observation.callback = callback;
    return {
      on() {
        return this;
      },
      unref() {},
      close() {},
    };
  },
}));
import { startWatcher } from '../../packages/core/indexing/watcher';
afterEach(() => {
  vi.useRealTimers();
});
it('retains a full-hash request when a later asset event joins the same debounce', async () => {
  vi.useFakeTimers();
  const reconcile = vi.fn(async () => ({})),
    db = {
      prepare: (sql: string) => ({
        get: () => (sql.includes('sync_runs') ? undefined : { found: 1 }),
      }),
    },
    stop = startWatcher(
      { knowledgeRoot: '/test-only', indexing: { watch: true } } as any,
      db as any,
      { reconcile } as any,
    );
  try {
    observation.callback!('change', '00-Inbox/edited.md');
    observation.callback!('change', '00-Inbox/_doo-assets/fixed.excalidraw');
    await vi.advanceTimersByTimeAsync(751);
    expect(reconcile).toHaveBeenCalledWith(undefined, true);
  } finally {
    stop();
  }
});
