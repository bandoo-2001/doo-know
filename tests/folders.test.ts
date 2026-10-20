import { it, expect } from 'vitest';
import { mkdir, writeFile, readFile, readdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture, loginFixtureOwner } from './support/fixture.js';
import { openDatabase } from '../packages/core/db.js';
import { beginOperation } from '../packages/core/knowledge/operations.js';
import { webPrincipal } from '../packages/core/knowledge/core.js';

it('archives a complete folder and restores its tree, original note IDs and unrelated files', async () => {
  const f = await createFixture();
  try {
    const headers = await loginFixtureOwner(f);
    await mkdir(join(f.knowledgeRoot, '00-Inbox/资料/子目录/空目录'), { recursive: true });
    await writeFile(join(f.knowledgeRoot, '00-Inbox/资料/子目录/笔记.md'), '# 原文');
    await writeFile(join(f.knowledgeRoot, '00-Inbox/资料/附件.bin'), Buffer.from([0, 255, 3]));
    const tree = (await f.app.inject({ url: '/api/tree', headers })).json();
    const original = tree[0].children[0].children
      .find((x: any) => x.name === '子目录')
      .children.find((x: any) => x.name === '笔记.md');
    expect(
      (await f.app.inject({ method: 'POST', url: `/api/notes/${original.id}/share`, headers }))
        .statusCode,
    ).toBe(200);
    const archive = () =>
      f.app.inject({
        method: 'DELETE',
        url: '/api/folders',
        headers,
        payload: { path: '00-Inbox/资料', requestId: 'archive-tree' },
      });
    const removed = await archive();
    expect(removed.statusCode, removed.body).toBe(200);
    const id = removed.json().id;
    expect(await readdir(join(f.knowledgeRoot, '00-Inbox'))).toEqual([]);
    expect((await f.app.inject({ url: `/api/notes/${original.id}`, headers })).statusCode).toBe(
      404,
    );
    const trash = (await f.app.inject({ url: '/api/manage/trash', headers })).json();
    expect(trash.items).toMatchObject([
      { id, type: 'folder', relativePath: '00-Inbox/资料', available: true },
    ]);
    await mkdir(join(f.knowledgeRoot, '00-Inbox/资料'));
    expect((await archive()).json().id).toBe(id);
    expect(await readdir(join(f.knowledgeRoot, '00-Inbox'))).toEqual(['资料']);
    const restore = (requestId: string, fileNames?: Record<string, string>) =>
      f.app.inject({
        method: 'POST',
        url: '/api/manage/trash/restore',
        headers,
        payload: { ids: [id], requestId, fileNames },
      });
    expect((await restore('restore-conflict')).json().results).toMatchObject([
      { id, ok: false, code: 'NAME_CONFLICT' },
    ]);
    const restored = await restore('restore-renamed', { [id]: '恢复资料' });
    expect(restored.json().results).toEqual([{ id, ok: true, relativePath: '00-Inbox/恢复资料' }]);
    expect((await restore('restore-renamed', { [id]: '恢复资料' })).json()).toEqual(
      restored.json(),
    );
    expect(await readdir(join(f.knowledgeRoot, '00-Inbox/恢复资料/子目录'))).toEqual([
      '空目录',
      '笔记.md',
    ]);
    expect(await readFile(join(f.knowledgeRoot, '00-Inbox/恢复资料/附件.bin'))).toEqual(
      Buffer.from([0, 255, 3]),
    );
    const note = await f.app.inject({ url: `/api/notes/${original.id}`, headers });
    expect(note.statusCode, note.body).toBe(200);
    expect(note.json()).toMatchObject({
      content: '# 原文',
      relativePath: '00-Inbox/恢复资料/子目录/笔记.md',
      shared: false,
    });
    expect((await f.app.inject({ url: '/api/manage/trash', headers })).json().items).toEqual([]);
  } finally {
    await f.close();
  }
});

it('archives and restores an empty root category', async () => {
  const f = await createFixture();
  try {
    const headers = await loginFixtureOwner(f);
    const response = await f.app.inject({
      method: 'DELETE',
      url: '/api/folders',
      headers,
      payload: { path: '00-Inbox', requestId: 'empty-category' },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(
      (await f.app.inject({ url: '/api/tree', headers }))
        .json()
        .some((item: any) => item.path === '00-Inbox'),
    ).toBe(false);
    const restored = await f.app.inject({
      method: 'POST',
      url: '/api/manage/trash/restore',
      headers,
      payload: { ids: [response.json().id], requestId: 'restore-empty' },
    });
    expect(restored.json().results[0].ok).toBe(true);
    expect(await readdir(join(f.knowledgeRoot, '00-Inbox'))).toEqual([]);
  } finally {
    await f.close();
  }
});

it('refuses unauthenticated, traversing, linked and protected folder deletions without touching their contents', async () => {
  const f = await createFixture();
  try {
    const headers = await loginFixtureOwner(f);
    await mkdir(join(f.knowledgeRoot, '00-Inbox/linked'));
    await mkdir(join(f.root, 'outside'));
    await writeFile(join(f.root, 'outside/keep.txt'), 'outside');
    await symlink(join(f.root, 'outside'), join(f.knowledgeRoot, '00-Inbox/linked/link'));
    for (const path of [
      '',
      '.',
      '../outside',
      '/tmp',
      '00-Inbox/linked',
      '90-Archive',
      '99-System',
    ]) {
      const result = await f.app.inject({
        method: 'DELETE',
        url: '/api/folders',
        headers,
        payload: { path, requestId: 'unsafe-' + path },
      });
      expect(result.statusCode, result.body).toBeGreaterThanOrEqual(400);
      expect(result.statusCode, result.body).toBeLessThan(500);
    }
    const anonymous = await f.app.inject({
      method: 'DELETE',
      url: '/api/folders',
      payload: { path: '00-Inbox', requestId: 'anonymous' },
    });
    expect(anonymous.statusCode).toBe(401);
    expect(await readFile(join(f.root, 'outside/keep.txt'), 'utf8')).toBe('outside');
    expect(await readdir(join(f.knowledgeRoot, '00-Inbox/linked'))).toEqual(['link']);
  } finally {
    await f.close();
  }
});

it('recovers both sides of an interrupted directory rename without replacing note IDs', async () => {
  const f = await createFixture();
  const db = openDatabase(f.dataRoot);
  try {
    const headers = await loginFixtureOwner(f);
    await mkdir(join(f.knowledgeRoot, '00-Inbox/recovery'));
    await writeFile(join(f.knowledgeRoot, '00-Inbox/recovery/keep.md'), '# 保留标识');
    const before = (await f.app.inject({ url: '/api/tree', headers })).json()[0].children[0]
      .children[0];
    const archived = await f.app.inject({
      method: 'DELETE',
      url: '/api/folders',
      headers,
      payload: { path: '00-Inbox/recovery', requestId: 'interrupt-archive' },
    });
    expect(archived.statusCode, archived.body).toBe(200);
    const id = archived.json().id;
    // Simulate the durable journal just after rename, before metadata commit.
    db.prepare("UPDATE folder_trash SET state='archiving' WHERE id=?").run(id);
    db.prepare('UPDATE notes SET active=1 WHERE id=?').run(before.id);
    db.prepare(
      "UPDATE operations SET status='prepared',result=NULL WHERE request_id='interrupt-archive'",
    ).run();
    await mkdir(join(f.knowledgeRoot, '00-Inbox/recovery'));
    await writeFile(join(f.knowledgeRoot, '00-Inbox/recovery/keep.md'), '# 新文件夹');
    await f.app.inject({ url: '/api/tree', headers });
    expect(db.prepare('SELECT active FROM notes WHERE id=?').get(before.id)).toEqual({ active: 0 });
    const restored = await f.app.inject({
      method: 'POST',
      url: '/api/manage/trash/restore',
      headers,
      payload: { ids: [id], requestId: 'interrupt-restore', fileNames: { [id]: 'recovered' } },
    });
    expect(restored.json().results[0].ok).toBe(true);
    db.prepare("UPDATE folder_trash SET state='restoring' WHERE id=?").run(id);
    db.prepare('UPDATE notes SET active=0 WHERE id=?').run(before.id);
    await f.app.inject({ url: '/api/tree', headers });
    const live = await f.app.inject({ url: `/api/notes/${before.id}`, headers });
    expect(live.statusCode, live.body).toBe(200);
    expect(live.json().content).toBe('# 保留标识');
    expect(
      db
        .prepare('SELECT id FROM notes WHERE path=? AND active=1')
        .all('00-Inbox/recovered/keep.md'),
    ).toEqual([{ id: before.id }]);
    expect(await readFile(join(f.knowledgeRoot, '00-Inbox/recovery/keep.md'), 'utf8')).toBe(
      '# 新文件夹',
    );
  } finally {
    db.close();
    await f.close();
  }
});

it('retries the original requests after a metadata failure following the directory move', async () => {
  const f = await createFixture();
  const db = openDatabase(f.dataRoot);
  try {
    const headers = await loginFixtureOwner(f);
    await mkdir(join(f.knowledgeRoot, '00-Inbox/fault'));
    db.exec(
      "CREATE TRIGGER interrupt_archive BEFORE UPDATE OF state ON folder_trash WHEN NEW.state='trashed' BEGIN SELECT RAISE(ABORT,'injected metadata failure'); END",
    );
    const remove = () =>
      f.app.inject({
        method: 'DELETE',
        url: '/api/folders',
        headers,
        payload: { path: '00-Inbox/fault', requestId: 'retry-archive' },
      });
    const uncertain = await remove();
    expect(uncertain.statusCode, uncertain.body).toBe(503);
    expect(uncertain.json().code).toBe('OPERATION_OUTCOME_UNKNOWN');
    db.exec('DROP TRIGGER interrupt_archive');
    const removed = await remove();
    expect(removed.statusCode, removed.body).toBe(200);
    const id = removed.json().id;
    db.exec(
      "CREATE TRIGGER interrupt_restore BEFORE UPDATE OF state ON folder_trash WHEN NEW.state='restored' BEGIN SELECT RAISE(ABORT,'injected metadata failure'); END",
    );
    const restore = () =>
      f.app.inject({
        method: 'POST',
        url: '/api/manage/trash/restore',
        headers,
        payload: { ids: [id], requestId: 'retry-restore' },
      });
    const pending = await restore();
    expect(pending.statusCode, pending.body).toBe(503);
    db.exec('DROP TRIGGER interrupt_restore');
    const restored = await restore();
    expect(restored.statusCode, restored.body).toBe(200);
    expect(restored.json().results).toEqual([{ id, ok: true, relativePath: '00-Inbox/fault' }]);
    expect(await readdir(join(f.knowledgeRoot, '00-Inbox/fault'))).toEqual([]);
  } finally {
    db.close();
    await f.close();
  }
});

it('checks conflicting note metadata before moving a restored folder out of trash', async () => {
  const f = await createFixture();
  const db = openDatabase(f.dataRoot);
  try {
    const headers = await loginFixtureOwner(f);
    await mkdir(join(f.knowledgeRoot, '00-Inbox/source'));
    await writeFile(join(f.knowledgeRoot, '00-Inbox/source/keep.md'), '# Keep');
    const archived = await f.app.inject({
      method: 'DELETE',
      url: '/api/folders',
      headers,
      payload: { path: '00-Inbox/source', requestId: 'metadata-source' },
    });
    const id = archived.json().id;
    db.prepare('INSERT INTO notes(id,path) VALUES(?,?)').run(
      'other-note',
      '00-Inbox/destination/keep.md',
    );
    const restored = await f.app.inject({
      method: 'POST',
      url: '/api/manage/trash/restore',
      headers,
      payload: { ids: [id], requestId: 'metadata-conflict', fileNames: { [id]: 'destination' } },
    });
    expect(restored.json().results).toMatchObject([{ id, ok: false, code: 'NAME_CONFLICT' }]);
    expect((await f.app.inject({ url: '/api/manage/trash', headers })).json().items).toMatchObject([
      { id, available: true },
    ]);
  } finally {
    db.close();
    await f.close();
  }
});

it('resolves a request interrupted before its folder journal was created', async () => {
  const f = await createFixture();
  const db = openDatabase(f.dataRoot);
  try {
    const headers = await loginFixtureOwner(f);
    beginOperation(db, webPrincipal, 'folder.archive', 'before-journal', { path: '00-Inbox' });
    const retry = await f.app.inject({
      method: 'DELETE',
      url: '/api/folders',
      headers,
      payload: { path: '00-Inbox', requestId: 'before-journal' },
    });
    expect(retry.statusCode, retry.body).toBe(409);
    expect(retry.json().code).toBe('OPERATION_UNAPPLIED');
    expect(await readdir(join(f.knowledgeRoot, '00-Inbox'))).toEqual([]);
  } finally {
    db.close();
    await f.close();
  }
});
