import { it, expect } from 'vitest';
import { readFile, mkdir, copyFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixture, loginFixtureOwner } from './support/fixture.js';
import { createApp } from '../apps/server/app.js';
const artifact = process.env.DOOKNOW_SEARCH_ARTIFACT;
it.skipIf(!artifact)(
  'installs the actual bundled CPython/CPU wheels and model offline at final paths, keeps editing available, and starts again offline',
  async () => {
    const metadata = JSON.parse(await readFile(resolve(artifact!), 'utf8'));
    metadata.url = pathToFileURL(
      join(resolve(artifact!, '..'), new URL(metadata.url).pathname.split('/').at(-1)!),
    ).href;
    const parent = resolve('.local/platform-execution/search-runtime-tests');
    await mkdir(parent, { recursive: true });
    const f = await createFixture(
      { searchDistribution: metadata, indexing: { enabled: true, watch: false, embedded: true } },
      parent,
    );
    // This runtime source copy has no developer .venv or interpreter.
    const source = join(f.root, 'source');
    await mkdir(source);
    for (const file of await readdir('runtime/vector-service'))
      if (file.endsWith('.py'))
        await copyFile(join('runtime/vector-service', file), join(source, file));
    await f.app.close();
    Object.assign(f.config, {
      vectorRuntimeRoot: source,
      searchRuntimeRoot: join(f.root, 'managed-runtime'),
      searchModelsRoot: join(f.root, 'managed-models'),
      searchCacheRoot: join(f.root, 'cache'),
    });
    let app = await createApp(f.config);
    f.app = app;
    try {
      const headers = await loginFixtureOwner(f);
      const before = (await app.inject({ url: '/api/platform/search-runtime', headers })).json();
      expect(before.components.tokenizerReady).toBe(false);
      const started = await app.inject({
        method: 'POST',
        url: '/api/platform/search-runtime/prepare',
        headers,
        payload: { requestId: 'real-offline-search' },
      });
      expect(started.statusCode).toBe(200);
      const id = started.json().taskId;
      const retry = await app.inject({
        method: 'POST',
        url: '/api/platform/search-runtime/prepare',
        headers,
        payload: { requestId: 'real-offline-search' },
      });
      expect(retry.json().taskId).toBe(id);
      const note = await app.inject({
        method: 'POST',
        url: '/api/notes',
        headers,
        payload: {
          folderPath: '00-Inbox',
          fileName: 'while-preparing.md',
          content: '# 知识库仍可编辑\n\n检索准备期间写入。',
          requestId: 'during-preparation',
        },
      });
      expect(note.statusCode).toBe(201);
      let state: any;
      const deadline = Date.now() + 150000;
      do {
        await new Promise((r) => setTimeout(r, 250));
        const reply = await app.inject({ url: '/api/platform/search-runtime', headers });
        expect(reply.statusCode).toBe(200);
        state = reply.json();
        await writeFile(
          '.local/platform-execution/search-install-progress.json',
          JSON.stringify({ root: f.root, task: state.task }),
        );
        if (['failed', 'cancelled'].includes(state.task?.state))
          throw Error(state.task.phase + ':' + state.task.error);
      } while (state.task?.state !== 'succeeded' && Date.now() < deadline);
      expect(state.task.state).toBe('succeeded');
      expect(state.components).toMatchObject({ tokenizerReady: true, vectorReady: true });
      const pyvenv = await readFile(
        join(f.root, 'managed-runtime', metadata.version, 'venv/pyvenv.cfg'),
        'utf8',
      );
      expect(pyvenv).toContain(join(f.root, 'managed-runtime', metadata.version, 'python'));
      expect(
        (await app.inject({ url: '/api/notes/' + note.json().id, headers })).json().content,
      ).toContain('知识库仍可编辑');
      await app.close();
      app = await createApp(f.config);
      await app.ready();
      const restoredDeadline = Date.now() + 30000;
      do {
        await new Promise((r) => setTimeout(r, 250));
        state = (await app.inject({ url: '/api/platform/search-runtime', headers })).json();
      } while (!state.components.vectorReady && Date.now() < restoredDeadline);
      expect(state.components).toMatchObject({ tokenizerReady: true, vectorReady: true });
      expect((await app.inject({ url: '/api/notes/' + note.json().id, headers })).json().id).toBe(
        note.json().id,
      );
    } finally {
      await app.close();
      await f.close();
    }
  },
  180000,
);
