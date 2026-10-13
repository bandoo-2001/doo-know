import { it, expect } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture } from '../support/fixture.js';
import { agentConfig, agentHeaders } from '../support/agent.js';
import { readyRead } from '../support/read.js';
import { openDatabase } from '../../server/db.js';
import { observeSource } from '../../server/indexing/state.js';
import { sha256 } from '../../server/knowledge/operations.js';
import { snapshotService } from '../../server/knowledge/snapshots.js';
import { noteService } from '../../server/notes.js';

it('preserves a UTF-8 BOM and exact page bytes for patch range hashes', async () => {
  const f = await createFixture({ agent: agentConfig });
  try {
    const content = '\ufeff# 原文\r\n完整正文';
    await writeFile(join(f.knowledgeRoot, '00-Inbox/bom.md'), content);
    const n = (await f.app.inject({ url: '/api/agent/v1/notes', headers: agentHeaders() })).json()
      .data.items[0];
    const page = (await readyRead(f, n.id)).json().data.data;
    expect(page.content).toBe(content);
    expect(page.bytesReturned).toBe(Buffer.byteLength(page.content));
    expect(page.rangeHash).toBe(sha256(page.content));
  } finally {
    await f.close();
  }
});

it('rejects a cursor after an observed A to B to A source revision', async () => {
  const f = await createFixture({ agent: agentConfig });
  try {
    await writeFile(join(f.knowledgeRoot, '00-Inbox/aba.md'), 'original\n'.repeat(100));
    const n = (await f.app.inject({ url: '/api/agent/v1/notes', headers: agentHeaders() })).json()
      .data.items[0];
    const page = (await readyRead(f, n.id, { maxBytes: 64 })).json().data.data;
    const db = openDatabase(f.dataRoot);
    try {
      const state = db.prepare('SELECT * FROM document_state WHERE note_id=?').get(n.id) as any;
      observeSource(db, n.id, sha256('intermediate'), state.mtime_ns, state.size_bytes);
      observeSource(db, n.id, state.content_hash, state.mtime_ns, state.size_bytes);
    } finally {
      db.close();
    }
    const r = await f.app.inject({
      method: 'POST',
      url: `/api/agent/v1/notes/${n.id}/read`,
      headers: agentHeaders(),
      payload: { cursor: page.nextCursor },
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('STALE_CURSOR');
  } finally {
    await f.close();
  }
});

it('retains snapshots with an active read session during expiry cleanup', async () => {
  const f = await createFixture({ agent: agentConfig });
  try {
    await writeFile(join(f.knowledgeRoot, '00-Inbox/pinned.md'), 'active\n'.repeat(100));
    const n = (await f.app.inject({ url: '/api/agent/v1/notes', headers: agentHeaders() })).json()
      .data.items[0];
    const page = (await readyRead(f, n.id, { maxBytes: 64 })).json().data.data;
    const db = openDatabase(f.dataRoot);
    try {
      db.prepare('UPDATE read_snapshots SET expires_at=? WHERE id=?').run(
        Date.now() - 1,
        page.snapshotId,
      );
      await snapshotService(f.config, db, noteService(f.config, db)).clean();
      expect(
        db.prepare('SELECT id FROM read_snapshots WHERE id=?').get(page.snapshotId),
      ).toBeTruthy();
      db.prepare('UPDATE read_sessions SET expires_at=? WHERE snapshot_id=?').run(
        Date.now() - 1,
        page.snapshotId,
      );
      await snapshotService(f.config, db, noteService(f.config, db)).clean();
      expect(
        db.prepare('SELECT id FROM read_snapshots WHERE id=?').get(page.snapshotId),
      ).toBeUndefined();
    } finally {
      db.close();
    }
  } finally {
    await f.close();
  }
});
