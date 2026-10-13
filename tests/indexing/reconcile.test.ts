import { it, expect } from 'vitest';
import { writeFile, rename, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createFixture, loginFixtureOwner } from '../support/fixture.js';
import { agentConfig, agentHeaders } from '../support/agent.js';
import { openDatabase } from '../../server/db.js';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
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
