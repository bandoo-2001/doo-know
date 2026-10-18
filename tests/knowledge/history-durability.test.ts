import { it, expect, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture } from '../support/fixture.js';
import { openDatabase } from '../../packages/core/db.js';
import { mutationCore, webPrincipal } from '../../packages/core/knowledge/core.js';
import { noteService } from '../../packages/core/notes.js';
import { snapshotService } from '../../packages/core/knowledge/snapshots.js';
import { fileJobService } from '../../packages/core/knowledge/file-jobs.js';
const fault = vi.hoisted(() => ({ historyRoot: '', hits: 0 }));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    fsyncSync: (fd: number) => {
      if (fault.historyRoot && fs.readlinkSync(`/proc/self/fd/${fd}`) === fault.historyRoot) {
        fault.hits++;
        throw Object.assign(new Error('history directory fsync failed'), { code: 'EIO' });
      }
      return fs.fsyncSync(fd);
    },
  };
});

it('refuses full-text publication if the history directory cannot be made durable', async () => {
  const f = await createFixture({ fileTasks: { embedded: false } });
  const db = openDatabase(f.dataRoot);
  try {
    const core = mutationCore(f.config as any, db),
      n = core.create(webPrincipal, '00-Inbox', 'barrier.md', '# original', 'barrier-create');
    fault.historyRoot = join(f.dataRoot, 'history');
    expect(() =>
      core.update(webPrincipal, n.id, '# replacement', n.modifiedAt, 'barrier-update'),
    ).toThrow('history directory fsync failed');
    expect(fault.hits).toBeGreaterThan(0);
    expect(await readFile(join(f.knowledgeRoot, n.relativePath), 'utf8')).toBe('# original');
    expect(db.prepare('SELECT id FROM revisions WHERE note_id=?').all(n.id)).toHaveLength(0);
    expect(
      db.prepare("SELECT status FROM operations WHERE request_id='barrier-update'").get(),
    ).toMatchObject({ status: 'failed' });
  } finally {
    fault.historyRoot = '';
    db.close();
    await f.close();
  }
});

it('refuses a background patch before publication when its history directory fsync fails', async () => {
  const f = await createFixture({ fileTasks: { embedded: false } });
  const db = openDatabase(f.dataRoot);
  const taskConfig = { ...f.config, fileTasks: { embedded: true } } as any;
  const notes = noteService(taskConfig, db),
    snapshots = snapshotService(taskConfig, db, notes),
    files = fileJobService(taskConfig, db, notes, snapshots);
  try {
    const n = mutationCore(f.config as any, db).create(
      webPrincipal,
      '00-Inbox',
      'patch-barrier.md',
      '# original',
      'patch-barrier-create',
    );
    await snapshots.read(webPrincipal, n.id, {}, 'web');
    await snapshots.drain();
    const page = await snapshots.read(webPrincipal, n.id, {}, 'web');
    expect(page.kind).toBe('ready');
    if (page.kind !== 'ready') throw new Error('snapshot not ready');
    fault.historyRoot = join(f.dataRoot, 'history');
    fault.hits = 0;
    const submitted = await files.submit(
      webPrincipal,
      n.id,
      {
        snapshotId: page.data.snapshotId,
        expectedModifiedAt: page.data.modifiedAt,
        expectedContentHash: page.data.sourceHash,
        requestId: 'patch-history-barrier',
        edits: [{ type: 'replace_text', before: '# original', after: '# replacement' }],
      },
      'web',
    );
    expect(submitted.kind).toBe('accepted');
    await files.drain();
    expect(fault.hits).toBeGreaterThan(0);
    expect(await readFile(join(f.knowledgeRoot, n.relativePath), 'utf8')).toBe('# original');
    expect(db.prepare('SELECT id FROM revisions WHERE note_id=?').all(n.id)).toHaveLength(0);
    expect(
      db.prepare("SELECT status FROM operations WHERE request_id='patch-history-barrier'").get(),
    ).toMatchObject({ status: 'failed' });
  } finally {
    fault.historyRoot = '';
    await files.close();
    await snapshots.close();
    db.close();
    await f.close();
  }
});
