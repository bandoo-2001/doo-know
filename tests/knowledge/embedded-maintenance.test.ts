import { it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { writeFile, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture } from '../support/fixture.js';
import { agentConfig, agentHeaders } from '../support/agent.js';
import { openDatabase } from '../../server/db.js';
import { createApp } from '../../server/app.js';
import { noteService } from '../../server/notes.js';
import { snapshotService } from '../../server/knowledge/snapshots.js';

it.each(['fresh-lease', 'abandoned'])(
  'recovers a %s snapshot attempt in the default embedded lifecycle',
  async (kind) => {
    const f = await createFixture({ agent: agentConfig, fileTasks: { embedded: false } }),
      db = openDatabase(f.dataRoot);
    let restarted: Awaited<ReturnType<typeof createApp>> | undefined;
    const abandoned = randomUUID(),
      abandonedPath = join(f.dataRoot, 'read-snapshots', abandoned + '.md');
    try {
      const n = (
        await f.app.inject({
          method: 'POST',
          url: '/api/agent/v1/notes',
          headers: agentHeaders(),
          payload: {
            directory: '00-Inbox',
            fileName: 'maintenance.md',
            content: '# Snapshot\nBODY',
            requestId: 'maintenance-create',
          },
        })
      ).json().data;
      const accepted = (
        await f.app.inject({
          method: 'POST',
          url: `/api/agent/v1/notes/${n.id}/read`,
          headers: agentHeaders(),
          payload: {},
        })
      ).json().data;
      expect(accepted.kind).toBe('accepted');
      const id = accepted.operation.operationId,
        now = Date.now();
      db.prepare("UPDATE operations SET status='running' WHERE id=?").run(id);
      db.prepare(
        "UPDATE file_operations SET status='running',lease_epoch=1,lease_until=?,deadline=? WHERE id=?",
      ).run(kind === 'fresh-lease' ? now + 500 : 0, now + 300000, id);
      if (kind === 'abandoned') {
        await mkdir(join(f.dataRoot, 'read-snapshots'), { recursive: true });
        await writeFile(abandonedPath, 'PARTIAL');
        db.prepare(
          "INSERT INTO read_snapshots(id,note_id,source_hash,modified_at,path,size_bytes,longest_line_bytes,created_at,expires_at,refs,principal,source_key) VALUES(?,?,'preparing',?,?,?,0,?,0,1,'owner',?)",
        ).run(abandoned, n.id, n.modifiedAt, abandonedPath, n.sizeBytes, now, n.id);
        db.prepare('UPDATE file_operations SET snapshot_id=? WHERE id=?').run(abandoned, id);
      }
      await f.app.close();
      restarted = await createApp({ ...f.config, fileTasks: { embedded: true } });
      let status = '';
      for (let i = 0; i < 80; i++) {
        status = (db.prepare('SELECT status FROM file_operations WHERE id=?').get(id) as any)
          .status;
        if (status === 'succeeded') break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(status).toBe('succeeded');
      if (kind === 'abandoned') {
        const snapshots = snapshotService(
          { ...f.config, fileTasks: { embedded: false } },
          db,
          noteService(f.config, db),
        );
        await snapshots.clean();
        await snapshots.close();
        expect(
          db.prepare('SELECT id FROM read_snapshots WHERE id=?').get(abandoned),
        ).toBeUndefined();
        await expect(access(abandonedPath)).rejects.toMatchObject({ code: 'ENOENT' });
        expect((db.prepare('SELECT count(*) AS n FROM read_snapshots').get() as any).n).toBe(1);
      } else {
        db.prepare('UPDATE read_snapshots SET expires_at=0 WHERE refs=0').run();
        for (let i = 0; i < 60 && db.prepare('SELECT id FROM read_snapshots').get(); i++)
          await new Promise((r) => setTimeout(r, 50));
        expect(db.prepare('SELECT id FROM read_snapshots').get()).toBeUndefined();
      }
    } finally {
      await restarted?.close();
      db.close();
      await f.close();
    }
  },
  15000,
);
