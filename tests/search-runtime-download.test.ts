import { it, expect } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createFixture, loginFixtureOwner } from './support/fixture.js';
const base = {
  version: 'bge-zh-cpu-20261015',
  pythonVersion: '3.14.4',
  platform: 'linux-x64',
  spaceId: '6fabd979756dff4dc79f1430da4cdff500badfb47db0eb8c0d4b07b02770faf5',
  modelRevision: '7999e1d3359715c523056ef9478215996d62a620',
};
async function fixture(mode: 'cancel' | 'corrupt') {
  const root = await mkdtemp(join(tmpdir(), 'search-download-')),
    bytes = Buffer.alloc(mode === 'cancel' ? 2 * 1024 * 1024 : 32, 65);
  const server = createServer((_req, res) => {
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': bytes.length,
    });
    if (mode === 'cancel') {
      res.write(bytes.subarray(0, 1024 * 1024));
      res.on('close', () => {});
    } else res.end(bytes);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port;
  const config = {
    searchDistribution: {
      ...base,
      url: `http://127.0.0.1:${port}/search.tar.gz`,
      bytes: bytes.length,
      sha256: mode === 'cancel' ? createHash('sha256').update(bytes).digest('hex') : '0'.repeat(64),
    },
    searchCacheRoot: join(root, 'cache'),
    searchRuntimeRoot: join(root, 'runtime'),
    searchModelsRoot: join(root, 'models'),
  };
  const f = await createFixture(config),
    headers = await loginFixtureOwner(f);
  const state = async () => {
    const response = await f.app.inject({ url: '/api/platform/search-runtime', headers });
    expect(response.statusCode).toBe(200);
    return response.json();
  };
  return {
    ...f,
    headers,
    state,
    close: async () => {
      await f.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await rm(root, { recursive: true, force: true });
    },
  };
}
it('cancels an interrupted download, preserves the original task receipt, and rejects overlapping preparations', async () => {
  const f = await fixture('cancel');
  try {
    const prepare = (requestId: string) =>
      f.app.inject({
        method: 'POST',
        url: '/api/platform/search-runtime/prepare',
        headers: f.headers,
        payload: { requestId },
      });
    const first = await prepare('download-one');
    expect(first.statusCode).toBe(200);
    const id = first.json().taskId;
    expect((await prepare('download-one')).json().taskId).toBe(id);
    expect((await prepare('download-two')).statusCode).toBe(409);
    for (let i = 0; i < 50 && (await f.state()).task.phase !== 'downloading'; i++)
      await new Promise((r) => setTimeout(r, 10));
    const cancel = await f.app.inject({
      method: 'POST',
      url: `/api/platform/search-runtime/tasks/${id}/cancel`,
      headers: f.headers,
      payload: {},
    });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().state).toBe('cancelled');
    expect((await prepare('download-one')).json().taskId).toBe(id);
    expect((await f.state()).task.state).toBe('cancelled');
  } finally {
    await f.close();
  }
});
it('reports a corrupt distribution as failed before extracting or installing it', async () => {
  const f = await fixture('corrupt');
  try {
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/platform/search-runtime/prepare',
          headers: f.headers,
          payload: { requestId: 'corrupted' },
        })
      ).statusCode,
    ).toBe(200);
    let state: any;
    for (let i = 0; i < 100; i++) {
      state = await f.state();
      if (state.task.state === 'failed') break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(state.task).toMatchObject({ state: 'failed', error: 'SEARCH_CHECKSUM_MISMATCH' });
    expect((await f.app.inject({ url: '/readyz' })).statusCode).toBe(200);
  } finally {
    await f.close();
  }
});
