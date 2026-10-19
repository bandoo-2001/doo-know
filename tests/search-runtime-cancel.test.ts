import { expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { createFixture, loginFixtureOwner } from './support/fixture.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'search-cancel-body-'));
  const bytes = Buffer.alloc(2 * 1024 * 1024, 65);
  const checksum = createHash('sha256').update(bytes).digest('hex');
  let openResponses = 0;
  const source = createServer((_request, response) => {
    openResponses++;
    response.once('close', () => {
      openResponses--;
    });
    response.writeHead(200, { 'content-length': bytes.length });
    response.write(bytes.subarray(0, 1024 * 1024 + 1));
    // Deliberately never finish the body. Cancellation must interrupt the pending read.
  });
  await new Promise<void>((resolve) => source.listen(0, '127.0.0.1', resolve));
  const port = (source.address() as { port: number }).port;
  const f = await createFixture({
    searchDistribution: {
      version: 'bge-zh-cpu-20261015',
      pythonVersion: '3.14.4',
      platform: 'linux-x64',
      spaceId: '6fabd979756dff4dc79f1430da4cdff500badfb47db0eb8c0d4b07b02770faf5',
      modelRevision: '7999e1d3359715c523056ef9478215996d62a620',
      url: `http://127.0.0.1:${port}/search.tar.gz`,
      bytes: bytes.length,
      sha256: checksum,
    },
    searchCacheRoot: join(root, 'cache'),
    searchRuntimeRoot: join(root, 'runtime'),
    searchModelsRoot: join(root, 'models'),
  });
  const headers = await loginFixtureOwner(f);
  const endpoint = await f.app.listen({ host: '127.0.0.1', port: 0 });
  const state = async () =>
    (await f.app.inject({ url: '/api/platform/search-runtime', headers })).json();
  const prepare = async (requestId: string) => {
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/platform/search-runtime/prepare',
      headers,
      payload: { requestId },
    });
    expect(response.statusCode).toBe(200);
    await expect
      .poll(async () => (await state()).task.completedBytes, { timeout: 3000, interval: 10 })
      .toBeGreaterThan(1024 * 1024);
    return response.json().taskId as string;
  };
  const cancel = async (id: string) => {
    const response = await fetch(`${endpoint}/api/platform/search-runtime/tasks/${id}/cancel`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: '{}',
    });
    const data = await response.json();
    return { statusCode: response.status, json: () => data };
  };
  return {
    ...f,
    root,
    prepare,
    cancel,
    state,
    openResponses: () => openResponses,
    partial: join(root, 'cache', checksum + '.tar.gz.part'),
    temporary: (id: string) => join(root, 'runtime', 'tmp', id),
    close: async () => {
      // Cleanup must also release a broken implementation's pending body read.
      const closed = new Promise<void>((resolve) => source.close(() => resolve()));
      source.closeAllConnections();
      await closed;
      await f.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function promptly<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(Error('pending HTTP body was not interrupted within 1 second')),
          1000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

it('cancels a download stalled after its first body bytes, releases temporary files and permits another preparation', async () => {
  const f = await fixture();
  try {
    const first = await f.prepare('first-stalled-body');
    expect(f.openResponses()).toBe(1);
    const cancelled = await promptly(f.cancel(first));
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().state).toBe('cancelled');
    expect((await f.state()).task).toMatchObject({
      id: first,
      state: 'cancelled',
      phase: 'cancelled',
    });
    await expect.poll(f.openResponses).toBe(0);
    await expect(stat(f.partial)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(f.temporary(first))).rejects.toMatchObject({ code: 'ENOENT' });
    const second = await f.prepare('second-stalled-body');
    expect(second).not.toBe(first);
    expect((await promptly(f.cancel(second))).json().state).toBe('cancelled');
  } finally {
    await f.close();
  }
});

it('stopping the application interrupts the same stalled HTTP body and records cancellation before closing the database', async () => {
  const f = await fixture();
  try {
    const id = await f.prepare('stop-stalled-body');
    await promptly(f.app.close());
    await expect.poll(f.openResponses).toBe(0);
    const db = new Database(join(f.dataRoot, 'app.sqlite'), {
      readonly: true,
      fileMustExist: true,
    });
    try {
      expect(db.prepare('SELECT state,phase FROM search_preparations WHERE id=?').get(id)).toEqual({
        state: 'cancelled',
        phase: 'cancelled',
      });
    } finally {
      db.close();
    }
    await expect(stat(f.partial)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(f.temporary(id))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await f.close();
  }
});

it.each(['cancel', 'close'] as const)(
  'interrupts a pending body read on %s even when the HTTP transport stops following its abort signal',
  async (action) => {
    const nativeFetch = globalThis.fetch;
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation((input, options) =>
        nativeFetch(input, { ...options, signal: undefined }),
      );
    const f = await fixture();
    try {
      const id = await f.prepare('delayed-stalled-body');
      // Keep the body pending across event-loop and optional explicit GC turns.
      for (let i = 0; i < 3; i++) {
        (globalThis as { gc?: () => void }).gc?.();
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (action === 'cancel')
        expect((await promptly(f.cancel(id))).json().state).toBe('cancelled');
      else await promptly(f.app.close());
      await expect.poll(f.openResponses).toBe(0);
      await expect(stat(f.partial)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(f.temporary(id))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      fetch.mockRestore();
      await f.close();
    }
  },
);
