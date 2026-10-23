import { it, expect } from 'vitest';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createFixture, loginFixtureOwner } from './support/fixture.js';
import { agentConfig } from './support/agent.js';
import { readyRead } from './support/read.js';
import { openDatabase } from '../packages/core/db.js';
import { TokenizerClient } from '../packages/core/indexing/tokenizer-client.js';
import { chunkService } from '../packages/core/indexing/chunks.js';

const scene = (text = '用户登录架构') =>
  JSON.stringify({
    type: 'excalidraw',
    version: 2,
    source: 'https://excalidraw.com',
    elements: [{ id: 'label-1', type: 'text', text, x: 10, y: 20, width: 180, height: 30 }],
    appState: { viewBackgroundColor: '#ffffff' },
    files: {},
  });

it('indexes only board labels rather than serialized scene coordinates and image data', async () => {
  const f = await createFixture({ agent: agentConfig }),
    tokenizer = new TokenizerClient();
  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    const headers = await loginFixtureOwner(f);
    const n = (
      await f.app.inject({
        method: 'POST',
        url: '/api/notes',
        headers,
        payload: {
          folderPath: '00-Inbox',
          fileName: '搜索白板.excalidraw',
          content: scene('应当检索的架构标签'),
        },
      })
    ).json();
    expect(n.id).toBeTruthy();
    const result = (await readyRead(f, n.id)).json().data.data;
    db = openDatabase(f.dataRoot);
    const chunks = [];
    for await (const chunk of chunkService(f.config, db, tokenizer).chunkDocument(
      result.snapshotId,
      'board-v1',
    ))
      chunks.push(chunk);
    expect(chunks.map((c) => c.content).join('')).toBe('应当检索的架构标签');
    expect(chunks.every((c) => c.embeddingTokenCount <= 512)).toBe(true);
  } finally {
    db?.close();
    await tokenizer.close();
    await f.close();
  }
});

it('creates a whiteboard as a durable document and exposes its kind in tree and metadata', async () => {
  const f = await createFixture();
  try {
    const headers = await loginFixtureOwner(f),
      content = scene();
    const create = () =>
      f.app.inject({
        method: 'POST',
        url: '/api/notes',
        headers,
        payload: {
          folderPath: '00-Inbox',
          fileName: '系统架构.excalidraw',
          content,
          requestId: 'create-board',
        },
      });
    const first = await create();
    expect(first.statusCode, first.body).toBe(201);
    const n = first.json();
    expect(n).toMatchObject({ title: '系统架构', documentType: 'whiteboard' });
    expect(JSON.parse(n.content)).toEqual({ ...JSON.parse(content), dooknow: { id: n.id } });
    expect((await create()).json().id).toBe(n.id);
    expect(await readFile(join(f.knowledgeRoot, n.relativePath), 'utf8')).toBe(n.content);
    const tree = (await f.app.inject({ url: '/api/tree', headers })).json();
    expect(tree[0].children).toContainEqual(
      expect.objectContaining({ id: n.id, documentType: 'whiteboard' }),
    );
    const meta = await f.app.inject({ url: `/api/notes/${n.id}/meta`, headers });
    expect(meta.json()).toMatchObject({
      documentType: 'whiteboard',
      editorMode: 'full',
      readState: 'ready',
    });
  } finally {
    await f.close();
  }
});

it('retains whiteboard identity when source files are cloned into a fresh library without a database', async () => {
  const source = await createFixture(),
    target = await createFixture();
  try {
    const headers = await loginFixtureOwner(source),
      targetHeaders = await loginFixtureOwner(target);
    const created = await source.app.inject({
      method: 'POST',
      url: '/api/notes',
      headers,
      payload: { folderPath: '00-Inbox', fileName: '可迁移白板.excalidraw', content: scene() },
    });
    expect(created.statusCode, created.body).toBe(201);
    const board = created.json();
    const bytes = await readFile(join(source.knowledgeRoot, board.relativePath), 'utf8');
    await writeFile(join(target.knowledgeRoot, board.relativePath), bytes);
    const tree = (await target.app.inject({ url: '/api/tree', headers: targetHeaders })).json();
    expect(tree[0].children[0].id).toBe(board.id);
    expect(
      (await target.app.inject({ url: '/api/notes/' + board.id, headers: targetHeaders }))
        .statusCode,
    ).toBe(200);
    expect(await readFile(join(target.knowledgeRoot, board.relativePath), 'utf8')).toBe(bytes);
  } finally {
    await source.close();
    await target.close();
  }
});

it('preserves scene files and long data lines, retries saves idempotently, and rejects conflicts and malformed replacements', async () => {
  const f = await createFixture();
  try {
    const headers = await loginFixtureOwner(f);
    const content = scene('x'.repeat(2_200_000));
    const created = await f.app.inject({
      method: 'POST',
      url: '/api/notes',
      headers,
      payload: { folderPath: '00-Inbox', fileName: '长白板.excalidraw', content },
    });
    expect(created.statusCode, created.body).toBe(201);
    const n = created.json(),
      updated = scene('更新后的架构');
    const save = () =>
      f.app.inject({
        method: 'PUT',
        url: `/api/notes/${n.id}`,
        headers,
        payload: { content: updated, expectedModifiedAt: n.modifiedAt, requestId: 'save-board' },
      });
    const saved = await save();
    expect(saved.statusCode, saved.body).toBe(200);
    expect((await save()).json().modifiedAt).toBe(saved.json().modifiedAt);
    const malformed = await f.app.inject({
      method: 'PUT',
      url: `/api/notes/${n.id}`,
      headers,
      payload: {
        content: '{"type":"excalidraw","elements":"broken"}',
        expectedModifiedAt: saved.json().modifiedAt,
      },
    });
    expect(malformed.statusCode).toBe(400);
    expect(await readFile(join(f.knowledgeRoot, n.relativePath), 'utf8')).toBe(
      saved.json().content,
    );
    expect(JSON.parse(saved.json().content)).toEqual({
      ...JSON.parse(updated),
      dooknow: { id: n.id },
    });
    await writeFile(join(f.knowledgeRoot, n.relativePath), scene('外部修改'));
    const conflict = await f.app.inject({
      method: 'PUT',
      url: `/api/notes/${n.id}`,
      headers,
      payload: { content: updated, expectedModifiedAt: saved.json().modifiedAt },
    });
    expect(conflict.statusCode).toBe(409);
    expect(await readFile(join(f.knowledgeRoot, n.relativePath), 'utf8')).toBe(scene('外部修改'));
  } finally {
    await f.close();
  }
});

it('keeps whiteboard identity and content across rename, move, trash and restore', async () => {
  const f = await createFixture();
  try {
    const headers = await loginFixtureOwner(f),
      content = scene();
    const result = await f.app.inject({
      method: 'POST',
      url: '/api/notes',
      headers,
      payload: { folderPath: '00-Inbox', fileName: '架构.excalidraw', content },
    });
    expect(result.statusCode, result.body).toBe(201);
    let n = result.json();
    const storedContent = n.content;
    await mkdir(join(f.knowledgeRoot, '00-Inbox/design'));
    const moved = await f.app.inject({
      method: 'POST',
      url: `/api/notes/${n.id}/move`,
      headers,
      payload: {
        folderPath: '00-Inbox/design',
        fileName: '新版架构.excalidraw',
        expectedModifiedAt: n.modifiedAt,
        requestId: randomUUID(),
      },
    });
    expect(moved.statusCode, moved.body).toBe(200);
    n = (await f.app.inject({ url: `/api/notes/${n.id}`, headers })).json();
    expect(n).toMatchObject({
      relativePath: '00-Inbox/design/新版架构.excalidraw',
      content: storedContent,
    });
    const deleted = await f.app.inject({
      method: 'DELETE',
      url: `/api/notes/${n.id}`,
      headers,
      payload: { expectedModifiedAt: n.modifiedAt, requestId: randomUUID() },
    });
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect((await f.app.inject({ url: `/api/notes/${n.id}`, headers })).statusCode).toBe(404);
    const restored = await f.app.inject({
      method: 'POST',
      url: `/api/notes/${n.id}/restore`,
      headers,
      payload: { requestId: randomUUID() },
    });
    expect(restored.statusCode, restored.body).toBe(200);
    expect(restored.json()).toMatchObject({
      id: n.id,
      content: storedContent,
      documentType: 'whiteboard',
    });
  } finally {
    await f.close();
  }
});

it('only shares explicitly referenced boards and revokes access with the parent share', async () => {
  const f = await createFixture();
  try {
    const headers = await loginFixtureOwner(f);
    const create = async (name: string, content: string) => {
      const r = await f.app.inject({
        method: 'POST',
        url: '/api/notes',
        headers,
        payload: { folderPath: '00-Inbox', fileName: name, content },
      });
      expect(r.statusCode, r.body).toBe(201);
      return r.json();
    };
    const a = await create('公开图.excalidraw', scene('可分享内容'));
    const b = await create('私密图.excalidraw', scene('私密内容'));
    const note = await create('说明.md', '# 说明\n\n```excalidraw\n' + a.id + '\n```\n');
    const sharing = (
      await f.app.inject({ method: 'POST', url: `/api/notes/${note.id}/share`, headers })
    ).json();
    const url = `/api/public/shares/${sharing.token}/whiteboards/`;
    expect((await f.app.inject({ url: url + a.id })).json()).toMatchObject({
      content: a.content,
    });
    expect((await f.app.inject({ url: url + b.id })).statusCode).toBe(404);
    await f.app.inject({ method: 'DELETE', url: `/api/notes/${note.id}/share`, headers });
    expect((await f.app.inject({ url: url + a.id })).statusCode).toBe(404);
  } finally {
    await f.close();
  }
});

it('backs up and restores native scene files including embedded images and stable identities', async () => {
  const f = await createFixture();
  try {
    const headers = await loginFixtureOwner(f);
    const source = JSON.parse(scene());
    source.files = {
      image1: {
        id: 'image1',
        mimeType: 'image/png',
        dataURL: 'data:image/png;base64,iVBORw0KGgo=',
      },
    };
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/notes',
      headers,
      payload: {
        folderPath: '00-Inbox',
        fileName: '可恢复白板.excalidraw',
        content: JSON.stringify(source),
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    const board = response.json();
    await f.app.close();
    const { backup, restore } = await import('../apps/server/backup');
    const destination = join(f.root, 'backup'),
      knowledgeRoot = join(f.root, 'restored-knowledge'),
      dataRoot = join(f.root, 'restored-data');
    await backup(f.config, destination);
    await restore(destination, { ...f.config, knowledgeRoot, dataRoot });
    const content = await readFile(join(knowledgeRoot, board.relativePath), 'utf8');
    expect(content).toBe(board.content);
    expect(JSON.parse(content)).toMatchObject({ dooknow: { id: board.id }, files: source.files });
  } finally {
    await f.close();
  }
});
