import { expect, it, vi } from 'vitest';
import { createFixture } from './support/fixture.js';
import * as collections from '../packages/core/collections/service.js';
import nodefs from 'node:fs';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { loginFixtureOwner } from './support/fixture.js';
import * as source from '../packages/core/collections/source.js';

it('stops runtime intervals when collection initialization fails', async () => {
  const realInterval = global.setInterval;
  const realClear = global.clearInterval;
  const timers: ReturnType<typeof setInterval>[] = [];
  let closed = false,
    callbacksAfterClose = 0;
  const intervalSpy = vi.spyOn(global, 'setInterval').mockImplementation(((
    callback: (...args: any[]) => void,
    delay: number,
    ...args: any[]
  ) => {
    const timer = realInterval(() => {
      if (closed) callbacksAfterClose++;
      else callback(...args);
    }, delay);
    timers.push(timer);
    return timer;
  }) as typeof setInterval);
  const fault = vi.spyOn(collections, 'collectionService').mockImplementation(() => {
    throw new Error('injected collection initialization failure');
  });
  const f = await createFixture();
  try {
    expect((await f.app.inject('/readyz')).statusCode).toBe(503);
    await f.app.close();
    closed = true;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(callbacksAfterClose).toBe(0);
  } finally {
    for (const timer of timers) realClear(timer);
    intervalSpy.mockRestore();
    fault.mockRestore();
    await f.close();
  }
});

it('keeps the knowledge runtime available when filesystem watching cannot start', async () => {
  const fault = vi.spyOn(nodefs, 'watch').mockImplementation(() => {
    throw Object.assign(new Error('watch limit'), { code: 'ENOSPC' });
  });
  const f = await createFixture({ fileTasks: { embedded: false } });
  try {
    expect((await f.app.inject('/readyz')).statusCode).toBe(200);
    const headers = await loginFixtureOwner(f);
    await fs.writeFile(join(f.knowledgeRoot, '00-Inbox/fallback.md'), '# Fallback\n\nReadable');
    await vi.waitFor(
      async () => {
        const result = (
          await f.app.inject({ url: '/api/collections/status?kind=recent', headers })
        ).json();
        expect(result.total).toBe(1);
      },
      { timeout: 5000, interval: 40 },
    );
  } finally {
    fault.mockRestore();
    await f.close();
  }
});

it('coalesces child events beneath their directory and yields while observing a large burst', async () => {
  const listeners: { path: string; callback: (event: string, name: string) => void }[] = [];
  const originalWatch = nodefs.watch.bind(nodefs);
  const watchSpy = vi.spyOn(nodefs, 'watch').mockImplementation(((
    path: string,
    options: object,
    callback: (event: string, name: string) => void,
  ) => {
    if ((options as { recursive?: boolean }).recursive)
      listeners.push({ path: String(path), callback });
    return originalWatch(path, options, () => {});
  }) as typeof nodefs.watch);
  const f = await createFixture({ fileTasks: { embedded: false } });
  const observed = new Map<string, number>();
  const originalObserve = source.observeCollectionSource;
  const observeSpy = vi.spyOn(source, 'observeCollectionSource').mockImplementation((...args) => {
    observed.set(args[1], (observed.get(args[1]) || 0) + 1);
    return originalObserve(...args);
  });
  let yielded = false;
  const heartbeat = setInterval(() => {
    if (observed.size > 0 && observed.size < 128) yielded = true;
  }, 1);
  try {
    const headers = await loginFixtureOwner(f);
    await fs.mkdir(join(f.knowledgeRoot, '00-Inbox/burst'));
    await Promise.all(
      Array.from({ length: 128 }, (_, index) =>
        fs.writeFile(join(f.knowledgeRoot, `00-Inbox/burst/note-${index}.md`), '# Card\n\nBody'),
      ),
    );
    const listener = listeners.filter((entry) => entry.path === f.knowledgeRoot).at(-1)!.callback;
    for (let index = 0; index < 128; index++) listener('rename', `00-Inbox/burst/note-${index}.md`);
    listener('rename', '00-Inbox/burst');
    await vi.waitFor(
      async () => {
        expect(
          (await f.app.inject({ url: '/api/collections/status?kind=recent', headers })).json()
            .total,
        ).toBe(128);
      },
      { timeout: 7000, interval: 40 },
    );
    expect(observed.size).toBe(128);
    expect([...observed.values()].every((count) => count === 1)).toBe(true);
    expect(yielded).toBe(true);
  } finally {
    clearInterval(heartbeat);
    observeSpy.mockRestore();
    watchSpy.mockRestore();
    await f.close();
  }
});

it('falls back to bounded metadata observation after an active watcher emits an error', async () => {
  const watches: { path: string; watcher: nodefs.FSWatcher }[] = [];
  const originalWatch = nodefs.watch.bind(nodefs);
  const spy = vi.spyOn(nodefs, 'watch').mockImplementation(((...args: any[]) => {
    const watcher = (originalWatch as any)(...args) as nodefs.FSWatcher;
    if (args[1]?.recursive) watches.push({ path: String(args[0]), watcher });
    return watcher;
  }) as typeof nodefs.watch);
  const f = await createFixture({ fileTasks: { embedded: false } });
  try {
    const headers = await loginFixtureOwner(f);
    watches
      .filter((entry) => entry.path === f.knowledgeRoot)
      .at(-1)!
      .watcher.emit('error', Object.assign(new Error('watch failed'), { code: 'ENOSPC' }));
    await fs.writeFile(join(f.knowledgeRoot, '00-Inbox/late.md'), '# Late\n\nDiscovered');
    await vi.waitFor(
      async () => {
        expect(
          (await f.app.inject({ url: '/api/collections/status?kind=recent', headers })).json()
            .total,
        ).toBe(1);
      },
      { timeout: 5000, interval: 40 },
    );
    expect((await f.app.inject('/readyz')).statusCode).toBe(200);
    expect(
      (await f.app.inject({ url: '/api/collections?kind=recent', headers })).json().items[0]
        .summary,
    ).toBe('Discovered');
  } finally {
    spy.mockRestore();
    await f.close();
  }
});
