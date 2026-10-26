import { expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { openDatabase } from '../../packages/core/db.js';
import { mutationCore, webPrincipal } from '../../packages/core/knowledge/core.js';
import { noteService } from '../../packages/core/notes.js';
import { snapshotService } from '../../packages/core/knowledge/snapshots.js';
import { fileJobService } from '../../packages/core/knowledge/file-jobs.js';

type ChildHandle = {
  child: ChildProcess;
  exited: Promise<void>;
  wait: (suffix: string) => Promise<string>;
  release: () => void;
  result: () => Promise<{ ok: boolean; code?: string; result?: unknown }>;
};

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'doo-note-write-'));
  const config = {
    knowledgeRoot: join(root, 'knowledge'),
    dataRoot: join(root, 'data'),
    origin: 'http://fixture.invalid',
    secret: 'fixture-only-secret-at-least-thirty-two-characters',
    indexing: { enabled: false },
    fileTasks: { embedded: false },
  };
  mkdirSync(join(config.knowledgeRoot, '00-Inbox'), { recursive: true });
  const db = openDatabase(config.dataRoot),
    notes = noteService(config, db);
  const note = notes.createNote('00-Inbox', 'race.md', '# Original', 'create-race');
  const snapshots = snapshotService({ ...config, fileTasks: { embedded: true } }, db, notes),
    jobs = fileJobService(config, db, notes, snapshots);
  await snapshots.available(webPrincipal, note.id, {});
  await snapshots.drain();
  const snapshot = await snapshots.available(webPrincipal, note.id, {});
  if ('operation' in snapshot) throw new Error('snapshot not ready');
  const children: ChildHandle[] = [];
  function launch(label: string, mode = 'web', barrier?: string): ChildHandle {
    const payload = join(root, `${label}.json`);
    writeFileSync(
      payload,
      JSON.stringify({
        config,
        id: note.id,
        expected: note.modifiedAt,
        root,
        label,
        mode,
        barrier,
      }),
    );
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        fileURLToPath(new URL('../support/note-write-child.ts', import.meta.url)),
        payload,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (data) => (stderr += data));
    const exited = new Promise<void>((resolve, reject) => {
      child.on('exit', () => resolve());
      child.on('error', reject);
    });
    async function wait(suffix: string) {
      const deadline = Date.now() + 15000,
        path = join(root, `${label}.${suffix}`);
      while (!existsSync(path)) {
        if (child.exitCode !== null || child.signalCode || Date.now() >= deadline)
          throw new Error(`child ${label} missing ${suffix}: ${stderr}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return readFileSync(path, 'utf8');
    }
    const handle = {
      child,
      exited,
      wait,
      release: () => writeFileSync(join(root, `${label}.release`), 'go'),
      result: async () => JSON.parse(await wait('result')),
    };
    children.push(handle);
    return handle;
  }
  return {
    root,
    config,
    db,
    note,
    jobs,
    launch,
    content: () => readFileSync(join(config.knowledgeRoot, '00-Inbox/race.md'), 'utf8'),
    history: () =>
      (db.prepare('SELECT file FROM revisions ORDER BY rowid').all() as any[]).map((r) =>
        readFileSync(join(config.dataRoot, 'history', r.file), 'utf8'),
      ),
    queue: () =>
      jobs.submit(
        webPrincipal,
        note.id,
        {
          requestId: 'worker-patch',
          snapshotId: snapshot.id,
          expectedModifiedAt: snapshot.modified_at,
          expectedContentHash: snapshot.source_hash,
          edits: [
            {
              type: 'replace_range',
              startByte: 0,
              endByte: snapshot.size_bytes,
              expectedRangeHash: snapshot.source_hash,
              insert: '# WORKER',
            },
          ],
        },
        'web',
      ),
    close: async () => {
      for (const child of children) child.child.kill('SIGKILL');
      await Promise.all(children.map((child) => child.exited));
      await jobs.close();
      await snapshots.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

// Removing atomic ownership before staging lets two writers publish the same base
// version and both record Original, losing the first successful write from history.
for (const barrier of ['history', 'rename', 'record'])
  for (const contender of ['web', 'worker'])
    it(`rejects competing ${contender} while web save is paused at ${barrier}`, async () => {
      const f = await fixture();
      try {
        if (contender === 'worker') await f.queue();
        const first = f.launch('FIRST', 'web', barrier);
        await first.wait('ready');
        const second = f.launch('SECOND', contender);
        const loser = await second.result();
        first.release();
        expect(await first.result()).toMatchObject({ ok: true });
        expect(loser).toMatchObject({ ok: false });
        expect([
          'OPERATION_IN_PROGRESS',
          'OPERATION_OUTCOME_UNKNOWN',
          'VERSION_CONFLICT',
          'STALE_CURSOR',
        ]).toContain(loser.code);
        expect(f.content()).toBe('# FIRST');
        expect(f.history()).toEqual(['# Original']);
        expect(f.db.prepare('SELECT * FROM note_write_leases').all()).toEqual([]);
      } finally {
        await f.close();
      }
    });

for (const barrier of ['rename', 'record'])
  it(`keeps a live worker exclusive beyond lease expiry at ${barrier}`, async () => {
    const f = await fixture();
    try {
      await f.queue();
      const worker = f.launch('WORKER', 'worker', barrier);
      await worker.wait('ready');
      f.db.prepare('UPDATE note_write_leases SET lease_until=0').run();
      f.db.prepare('UPDATE file_operations SET lease_until=0').run();
      await mutationCore(f.config, f.db).recover();
      await f.jobs.recover();
      const web = f.launch('WEB');
      expect(await web.result()).toMatchObject({ ok: false });
      worker.release();
      expect(await worker.result()).toMatchObject({ ok: true });
      expect(f.content()).toBe('# WORKER');
      expect(f.history()).toEqual(['# Original']);
    } finally {
      await f.close();
    }
  });

for (const barrier of ['history', 'rename', 'record'])
  it(`recovers a killed web writer at ${barrier} without losing durable content or blocking later saves`, async () => {
    const f = await fixture();
    try {
      const writer = f.launch('CRASHED', 'web', barrier);
      await writer.wait('ready');
      writer.child.kill('SIGKILL');
      await writer.exited;
      const recovered = await mutationCore(f.config, f.db).recover();
      expect(recovered).toMatchObject(
        barrier === 'record' ? { recovered: 1, conflicted: 0 } : { unapplied: 1, conflicted: 0 },
      );
      expect(f.content()).toBe(barrier === 'record' ? '# CRASHED' : '# Original');
      const expected = notesModified(f);
      mutationCore(f.config, f.db).update(
        webPrincipal,
        f.note.id,
        '# After recovery',
        expected,
        'after-recovery',
      );
      expect(f.content()).toBe('# After recovery');
      expect(f.history()).toEqual(
        barrier === 'record' ? ['# Original', '# CRASHED'] : ['# Original'],
      );
      expect(f.db.prepare('SELECT * FROM note_write_leases').all()).toEqual([]);
    } finally {
      await f.close();
    }
  });

function notesModified(f: Awaited<ReturnType<typeof fixture>>) {
  return noteService(f.config, f.db).getNote(f.note.id).modifiedAt;
}

it('does not let a retry of the same restore steal a live original writer', async () => {
  const f = await fixture();
  try {
    mutationCore(f.config, f.db).archive(
      webPrincipal,
      f.note.id,
      f.note.modifiedAt,
      'before-restore',
    );
    const first = f.launch('RESTORE', 'restore', 'restore-copy');
    await first.wait('ready');
    const retry = f.launch('RETRY', 'restore');
    const result = await retry.result();
    first.release();
    expect(await first.result()).toMatchObject({ ok: true });
    expect(result).toMatchObject({ ok: false, code: 'OPERATION_IN_PROGRESS' });
    expect(f.content()).toBe('# Original');
    const replay = f.launch('REPLAY', 'restore');
    expect(await replay.result()).toMatchObject({ ok: true });
    expect(f.db.prepare('SELECT * FROM note_write_leases').all()).toEqual([]);
  } finally {
    await f.close();
  }
});

for (const action of ['archive', 'move'])
  it(`rejects ${action} before a live web writer has registered its intent even after lease expiry`, async () => {
    const f = await fixture();
    try {
      const writer = f.launch('SAVE', 'web', 'history');
      await writer.wait('ready');
      f.db.prepare('UPDATE note_write_leases SET lease_until=0').run();
      await mutationCore(f.config, f.db).recover();
      const core = mutationCore(f.config, f.db);
      expect(() =>
        action === 'archive'
          ? core.archive(webPrincipal, f.note.id, f.note.modifiedAt, 'competing-archive')
          : core.move(
              webPrincipal,
              f.note.id,
              '00-Inbox',
              'moved.md',
              f.note.modifiedAt,
              'competing-move',
            ),
      ).toThrowError(expect.objectContaining({ code: 'OPERATION_IN_PROGRESS' }));
      writer.release();
      expect(await writer.result()).toMatchObject({ ok: true });
      expect(f.content()).toBe('# SAVE');
      expect(f.history()).toEqual(['# Original']);
      expect(f.db.prepare('SELECT * FROM note_write_leases').all()).toEqual([]);
    } finally {
      await f.close();
    }
  });

for (const barrier of ['rename', 'record'])
  it(`recovers a dead worker at ${barrier} and releases its abandoned lease`, async () => {
    const f = await fixture();
    try {
      await f.queue();
      const worker = f.launch('WORKER', 'worker', barrier);
      await worker.wait('ready');
      worker.child.kill('SIGKILL');
      await worker.exited;
      // Preserve the existing worker timeout/recovery policy after actual death.
      f.db.prepare('UPDATE file_operations SET lease_until=0').run();
      const report = await mutationCore(f.config, f.db).recover();
      expect(report).toMatchObject(
        barrier === 'record' ? { recovered: 1, conflicted: 0 } : { unapplied: 1, conflicted: 0 },
      );
      mutationCore(f.config, f.db).update(
        webPrincipal,
        f.note.id,
        '# After worker',
        notesModified(f),
        'after-worker',
      );
      expect(f.content()).toBe('# After worker');
      expect(f.history()).toEqual(
        barrier === 'record' ? ['# Original', '# WORKER'] : ['# Original'],
      );
      expect(f.db.prepare('SELECT * FROM note_write_leases').all()).toEqual([]);
    } finally {
      await f.close();
    }
  });

it('resumes the same restore request after the original process dies without waiting for its lease', async () => {
  const f = await fixture();
  try {
    mutationCore(f.config, f.db).archive(
      webPrincipal,
      f.note.id,
      f.note.modifiedAt,
      'before-restore',
    );
    const writer = f.launch('RESTORE', 'restore', 'restore-copy');
    await writer.wait('ready');
    writer.child.kill('SIGKILL');
    await writer.exited;
    const retry = f.launch('RETRY', 'restore');
    expect(await retry.result()).toMatchObject({ ok: true });
    expect(f.content()).toBe('# Original');
    expect(f.db.prepare('SELECT * FROM note_write_leases').all()).toEqual([]);
  } finally {
    await f.close();
  }
});

for (const kind of ['restore', 'move'])
  for (const contender of kind === 'restore' ? ['restore', 'recover'] : ['recover'])
    it(`owns ${kind} recovery while a concurrent ${contender} attempts the same intent`, async () => {
      const f = await fixture();
      try {
        if (kind === 'restore')
          mutationCore(f.config, f.db).archive(
            webPrincipal,
            f.note.id,
            f.note.modifiedAt,
            'before-restore',
          );
        const original = f.launch('ORIGINAL', kind, `${kind}-copy`);
        await original.wait('ready');
        original.child.kill('SIGKILL');
        await original.exited;
        const recovery = f.launch('RECOVERY', 'recover', `${kind}-copy`);
        await recovery.wait('ready');
        // Paused recovery must retain ownership even after its timestamp expires.
        f.db.prepare('UPDATE note_write_leases SET lease_until=0').run();
        const competing = f.launch('CONTENDER', contender);
        const contenderResult = await competing.result();
        recovery.release();
        expect(await recovery.result()).toEqual({
          ok: true,
          result: { recovered: 1, unapplied: 0, conflicted: 0 },
        });
        expect(contenderResult).toEqual(
          contender === 'recover'
            ? { ok: true, result: { recovered: 0, unapplied: 0, conflicted: 0 } }
            : expect.objectContaining({ ok: false, code: 'OPERATION_IN_PROGRESS' }),
        );
        expect(f.db.prepare('SELECT status,error FROM operations WHERE kind=?').all(kind)).toEqual([
          { status: 'succeeded', error: null },
        ]);
        expect(f.db.prepare('SELECT status FROM write_intents WHERE kind=?').all(kind)).toEqual([
          { status: 'recorded' },
        ]);
        const replay = f.launch('REPLAY', kind);
        expect(await replay.result()).toMatchObject({ ok: true });
        expect(
          readFileSync(
            join(f.config.knowledgeRoot, '00-Inbox', kind === 'move' ? 'moved.md' : 'race.md'),
            'utf8',
          ),
        ).toBe('# Original');
        expect(f.db.prepare('SELECT * FROM note_write_leases').all()).toEqual([]);
      } finally {
        await f.close();
      }
    });

for (const kind of ['restore', 'move'])
  it(`benignly skips ${kind} recovery ownership lost after the initial liveness check`, async () => {
    const f = await fixture();
    try {
      if (kind === 'restore')
        mutationCore(f.config, f.db).archive(
          webPrincipal,
          f.note.id,
          f.note.modifiedAt,
          'before-restore',
        );
      const original = f.launch('ORIGINAL', kind, `${kind}-copy`);
      await original.wait('ready');
      original.child.kill('SIGKILL');
      await original.exited;
      const delayed = f.launch('DELAYED', 'recover', 'recovery-checked');
      await delayed.wait('ready');
      const winner = f.launch('WINNER', 'recover', `${kind}-copy`);
      await winner.wait('ready');
      delayed.release();
      expect(await delayed.result()).toEqual({
        ok: true,
        result: { recovered: 0, unapplied: 0, conflicted: 0 },
      });
      winner.release();
      expect(await winner.result()).toEqual({
        ok: true,
        result: { recovered: 1, unapplied: 0, conflicted: 0 },
      });
      expect(f.db.prepare('SELECT status,error FROM operations WHERE kind=?').all(kind)).toEqual([
        { status: 'succeeded', error: null },
      ]);
      expect(f.db.prepare('SELECT status FROM write_intents WHERE kind=?').all(kind)).toEqual([
        { status: 'recorded' },
      ]);
      expect(f.db.prepare('SELECT * FROM note_write_leases').all()).toEqual([]);
    } finally {
      await f.close();
    }
  });
