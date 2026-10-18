import { it, expect } from 'vitest';
import { writeFile, rename, stat, utimes, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createFixture, loginFixtureOwner } from '../support/fixture.js';
import { agentConfig, agentHeaders } from '../support/agent.js';
import { openDatabase } from '../../packages/core/db.js';
import { reconcileService } from '../../packages/core/indexing/reconcile.js';
import { noteService } from '../../packages/core/notes.js';
import { shareService } from '../../packages/core/shares.js';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
it('preserves a note and its share when it is created after the reconciliation file snapshot', async () => {
  const f = await createFixture(),
    db = openDatabase(f.dataRoot);
  try {
    const notes = noteService(f.config, db),
      shares = shareService(db, notes);
    const reconciliation = reconcileService(f.config, db).reconcile();
    // perform() has taken its synchronous file snapshot and is awaiting real Git IO.
    await Promise.resolve();
    const note = notes.createNote('00-Inbox', 'created-during-scan.md', '# Keep this identity');
    const share = shares.create(note.id);
    await reconciliation;
    expect(
      (db.prepare('SELECT active FROM notes WHERE id=?').get(note.id) as { active: number }).active,
    ).toBe(1);
    expect(notes.tree()[0].children?.find((entry) => entry.path === note.relativePath)?.id).toBe(
      note.id,
    );
    expect(shares.document(share.token!).id).toBe(note.id);
    expect(notes.getNote(note.id).content).toBe('# Keep this identity');
  } finally {
    db.close();
    await f.close();
  }
});
it('all listing and document entrances preserve identities when an empty replacement root appears', async () => {
  const f = await createFixture({ agent: agentConfig }),
    held = f.knowledgeRoot + '-held',
    db = openDatabase(f.dataRoot);
  try {
    const h = await loginFixtureOwner(f);
    const n = (
      await f.app.inject({
        method: 'POST',
        url: '/api/notes',
        headers: h,
        payload: { folderPath: '00-Inbox', fileName: 'root-fence.md', content: '# Root identity' },
      })
    ).json();
    const share = (
      await f.app.inject({
        method: 'POST',
        url: `/api/notes/${n.id}/share`,
        headers: h,
        payload: {},
      })
    ).json();
    await f.app.inject({
      method: 'POST',
      url: '/api/agent/v1/index/refresh',
      headers: agentHeaders(),
      payload: { requestId: 'bind-root', scope: '00-Inbox' },
    });
    expect(db.prepare("SELECT value FROM index_meta WHERE key='root_identity'").get()).toBeTruthy();
    await rename(f.knowledgeRoot, held);
    await mkdir(f.knowledgeRoot);
    for (const request of [
      { url: '/api/agent/v1/notes', headers: agentHeaders() },
      { url: '/api/notes', headers: h },
      { url: '/api/tree', headers: h },
      { url: `/api/notes/${n.id}`, headers: h },
      { url: `/api/public/shares/${share.token}/meta` },
    ]) {
      const r = await f.app.inject(request);
      expect(r.statusCode).toBe(request.url.startsWith('/api/public/') ? 404 : 503);
    }
    expect((db.prepare('SELECT active FROM notes WHERE id=?').get(n.id) as any).active).toBe(1);
    expect(
      (db.prepare('SELECT enabled FROM shares WHERE note_id=?').get(n.id) as any).enabled,
    ).toBe(1);
    await rm(f.knowledgeRoot, { recursive: true });
    await rename(held, f.knowledgeRoot);
    expect(
      (await f.app.inject({ url: '/api/agent/v1/notes', headers: agentHeaders() })).json().data
        .items[0].id,
    ).toBe(n.id);
  } finally {
    db.close();
    await f.close();
  }
});
it('full reconciliation detects equal-size content with identical nanosecond mtime and atomic saves', async () => {
  const f = await createFixture({ agent: agentConfig });
  try {
    const file = join(f.knowledgeRoot, '00-Inbox/source.md');
    await writeFile(file, 'AAAA');
    await utimes(file, 1700000000, 1700000000);
    const headers = agentHeaders();
    const refresh = (requestId: string) =>
      f.app.inject({
        method: 'POST',
        url: '/api/agent/v1/index/refresh',
        headers,
        payload: { scope: '00-Inbox', requestId },
      });
    expect((await refresh('observe-a')).statusCode).toBe(200);
    const first = (
      await f.app.inject({ url: '/api/agent/v1/index/status?scope=00-Inbox', headers })
    ).json().data;
    expect(first.documents[0].sourceHash).toBe(hash('AAAA'));
    const before = await stat(file, { bigint: true });
    await writeFile(file, 'BBBB');
    await utimes(file, 1700000000, 1700000000);
    const after = await stat(file, { bigint: true });
    expect(after.mtimeNs).toBe(before.mtimeNs);
    expect(after.size).toBe(before.size);
    expect((await refresh('observe-b')).statusCode).toBe(200);
    let status = (
      await f.app.inject({ url: '/api/agent/v1/index/status?scope=00-Inbox', headers })
    ).json().data;
    expect(status.documents[0].sourceHash).toBe(hash('BBBB'));
    expect(status.documents[0].sourceRevision).toBe(2);
    const temp = join(f.knowledgeRoot, '00-Inbox/.editor.tmp');
    await writeFile(temp, 'ATOMIC');
    await rename(temp, file);
    await refresh('observe-atomic');
    status = (
      await f.app.inject({ url: '/api/agent/v1/index/status?scope=00-Inbox', headers })
    ).json().data;
    expect(status.documents[0].sourceHash).toBe(hash('ATOMIC'));
  } finally {
    await f.close();
  }
});
it('unavailable root never publishes a deletion set or revokes live share identities', async () => {
  const f = await createFixture({ agent: agentConfig });
  const held = f.knowledgeRoot + '-held';
  try {
    const h = await loginFixtureOwner(f),
      n = (
        await f.app.inject({
          method: 'POST',
          url: '/api/notes',
          headers: h,
          payload: { folderPath: '00-Inbox', fileName: 'keep.md', content: 'PRESERVE' },
        })
      ).json();
    await f.app.inject({
      method: 'POST',
      url: `/api/notes/${n.id}/share`,
      headers: h,
      payload: {},
    });
    await f.app.inject({
      method: 'POST',
      url: '/api/agent/v1/index/refresh',
      headers: agentHeaders(),
      payload: { scope: '00-Inbox', requestId: 'root-before' },
    });
    await rename(f.knowledgeRoot, held);
    const r = await f.app.inject({
      method: 'POST',
      url: '/api/agent/v1/index/refresh',
      headers: agentHeaders(),
      payload: { scope: '00-Inbox', requestId: 'root-unavailable' },
    });
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe('SOURCE_UNAVAILABLE');
    const tree = await f.app.inject({ url: '/api/tree', headers: h });
    expect(tree.statusCode).toBe(503);
    const db = openDatabase(f.dataRoot);
    expect((db.prepare('SELECT active FROM notes WHERE id=?').get(n.id) as any).active).toBe(1);
    expect(
      (db.prepare('SELECT enabled FROM shares WHERE note_id=?').get(n.id) as any).enabled,
    ).toBe(1);
    db.close();
    await rename(held, f.knowledgeRoot);
  } finally {
    await rename(held, f.knowledgeRoot).catch(() => {});
    await f.close();
  }
});
it('external rename allocates a private identity and deactivates original indexed visibility', async () => {
  const f = await createFixture({ agent: agentConfig });
  try {
    const h = await loginFixtureOwner(f),
      n = (
        await f.app.inject({
          method: 'POST',
          url: '/api/notes',
          headers: h,
          payload: { folderPath: '00-Inbox', fileName: 'old.md', content: '# Rename' },
        })
      ).json();
    const share = (
      await f.app.inject({
        method: 'POST',
        url: `/api/notes/${n.id}/share`,
        headers: h,
        payload: {},
      })
    ).json();
    await rename(
      join(f.knowledgeRoot, '00-Inbox/old.md'),
      join(f.knowledgeRoot, '00-Inbox/中文 空格.md'),
    );
    const r = await f.app.inject({
      method: 'POST',
      url: '/api/agent/v1/index/refresh',
      headers: agentHeaders(),
      payload: { scope: '00-Inbox', requestId: 'renamed' },
    });
    expect(r.statusCode).toBe(200);
    const notes = (
      await f.app.inject({ url: '/api/agent/v1/notes', headers: agentHeaders() })
    ).json().data.items;
    expect(notes[0].id).not.toBe(n.id);
    expect(notes[0].shared).toBe(false);
    expect((await f.app.inject({ url: `/api/public/shares/${share.token}` })).statusCode).toBe(404);
  } finally {
    await f.close();
  }
});
