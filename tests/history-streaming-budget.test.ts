import { expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { organizationFixture } from './support/organization-fixture';
import { snapshotService } from '../packages/core/knowledge/snapshots';
import { fileJobService } from '../packages/core/knowledge/file-jobs';
import {
  revisionContext,
  revisionRestoreSource,
} from '../packages/core/knowledge/revision-context';
import { sha256 } from '../packages/core/knowledge/operations';
const fault = vi.hoisted(() => ({ historyRoot: '', fullReads: 0, maxRead: 0 }));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  const historical = (file: unknown) => {
    if (!fault.historyRoot) return false;
    try {
      return (
        typeof file === 'number' ? fs.readlinkSync('/proc/self/fd/' + file) : String(file)
      ).startsWith(fault.historyRoot + '/');
    } catch {
      return false;
    }
  };
  return {
    ...fs,
    readFileSync: (file: any, ...args: any[]) => {
      if (historical(file)) {
        fault.fullReads++;
        throw Error('unbounded history read');
      }
      return (fs.readFileSync as any)(file, ...args);
    },
    readSync: (fd: number, buffer: Buffer, ...args: any[]) => {
      if (historical(fd)) fault.maxRead = Math.max(fault.maxRead, buffer.byteLength);
      return (fs.readSync as any)(fd, buffer, ...args);
    },
  };
});
it('captures, relocates and restores a 20 MiB reference-free history with bounded reads and no whole-file history allocation', async () => {
  const f = organizationFixture(),
    snapshots = snapshotService(f.config, f.db, f.notes),
    files = fileJobService(f.config, f.db, f.notes, snapshots);
  try {
    const original = '# Historical\n' + 'x'.repeat(20 * 1024 * 1024 - 128),
      note = f.create('00-Inbox/budget.md', original);
    await snapshots.read(f.p, note.noteId, {}, 'web');
    await snapshots.drain();
    const page = await snapshots.read(f.p, note.noteId, {}, 'web');
    if (page.kind !== 'ready') throw Error('snapshot');
    fault.historyRoot = join(f.config.dataRoot, 'history');
    fault.fullReads = 0;
    fault.maxRead = 0;
    const patch = await files.submit(
      f.p,
      note.noteId,
      {
        snapshotId: page.data.snapshotId,
        expectedModifiedAt: page.data.modifiedAt,
        expectedContentHash: page.data.sourceHash,
        requestId: randomUUID(),
        edits: [{ type: 'replace_text', before: '# Historical', after: '# Current000' }],
      },
      'web',
    );
    if (patch.kind !== 'accepted') throw Error('operation');
    await files.drain();
    const updated = files.operation(f.p, patch.operation.operationId);
    expect(updated.status).toBe('succeeded');
    const revision = (
      f.db
        .prepare('SELECT id FROM revisions WHERE note_id=? ORDER BY rowid DESC LIMIT 1')
        .get(note.noteId) as any
    ).id;
    expect(revisionContext(f.config, f.db, note.noteId, revision).references).toEqual({
      version: 1,
      complete: true,
      items: [],
    });
    const moved = revisionRestoreSource(
      f.config,
      f.db,
      note.noteId,
      revision,
      'Topic/after.md',
      f.p,
    );
    expect(moved.content).toBeUndefined();
    expect(moved.edits).toBeUndefined();
    const restore = await files.restore(
      f.p,
      note.noteId,
      revision,
      (updated.result as any).modifiedAt,
      randomUUID(),
    );
    if (restore.kind !== 'accepted') throw Error('operation');
    await files.drain();
    expect(files.operation(f.p, restore.operation.operationId).status).toBe('succeeded');
    expect(fault.fullReads).toBe(0);
    expect(fault.maxRead).toBeLessThanOrEqual(65536);
    fault.historyRoot = '';
    expect(sha256(readFileSync(join(f.config.knowledgeRoot, '00-Inbox/budget.md')))).toBe(
      sha256(original),
    );
  } finally {
    fault.historyRoot = '';
    await files.close();
    await snapshots.close();
    f.close();
  }
}, 30000);
