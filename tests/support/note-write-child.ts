import fs from 'node:fs';
import promises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { openDatabase } from '../../packages/core/db.js';
import { mutationCore, webPrincipal } from '../../packages/core/knowledge/core.js';
import { noteService } from '../../packages/core/notes.js';
import { snapshotService } from '../../packages/core/knowledge/snapshots.js';
import { fileJobService } from '../../packages/core/knowledge/file-jobs.js';

const { config, id, expected, root, label, mode, barrier } = JSON.parse(
  fs.readFileSync(process.argv[2], 'utf8'),
);
const db = openDatabase(config.dataRoot, mode === 'worker' ? 'file-worker' : 'server');
let stopped = false;
function pause(point: string) {
  if (stopped || barrier !== point) return;
  stopped = true;
  fs.writeFileSync(join(root, `${label}.ready`), point);
  const deadline = Date.now() + 20000;
  while (!fs.existsSync(join(root, `${label}.release`))) {
    if (Date.now() > deadline) throw new Error(`barrier timed out: ${label}/${point}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}
// Only add deterministic scheduling barriers. All filesystem and database work remains real.
const fsync = fs.fsyncSync;
fs.fsyncSync = (fd) => {
  if (fs.readlinkSync(`/proc/self/fd/${fd}`).includes('/history/')) pause('history');
  return fsync(fd);
};
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
  if (String(to).endsWith('/race.md')) pause('rename');
  rename(from, to);
  if (String(to).endsWith('/race.md')) pause('record');
};
const renameAsync = promises.rename;
promises.rename = async (from, to) => {
  if (String(to).endsWith('/race.md')) pause('rename');
  await renameAsync(from, to);
  if (String(to).endsWith('/race.md')) pause('record');
};
const copy = fs.copyFileSync;
fs.copyFileSync = (from, to, mode) => {
  if (String(to).includes('.doo-restore-')) pause('restore-copy');
  if (String(to).includes('.doo-move-')) pause('move-copy');
  return copy(from, to, mode);
};
syncBuiltinESMExports();
if (barrier === 'recovery-checked') {
  const prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    const statement = prepare(sql);
    if (
      sql.startsWith(
        "SELECT 1 FROM file_operations WHERE id=? AND status IN ('running','committing')",
      )
    ) {
      const get = statement.get.bind(statement);
      statement.get = ((...args: any[]) => {
        const result = get(...args);
        pause('recovery-checked');
        return result;
      }) as any;
    }
    return statement;
  }) as any;
}
try {
  if (mode === 'worker') {
    const notes = noteService(config, db),
      snapshots = snapshotService(config, db, notes);
    const jobs = fileJobService({ ...config, fileTasks: { embedded: true } }, db, notes, snapshots);
    try {
      await jobs.recover();
      await jobs.drain();
      const operation = db
        .prepare("SELECT status,error FROM operations WHERE kind='patch'")
        .get() as any;
      fs.writeFileSync(
        join(root, `${label}.result`),
        JSON.stringify({ ok: operation.status === 'succeeded', code: operation.error }),
      );
    } finally {
      await jobs.close();
      await snapshots.close();
    }
  } else if (mode === 'recover') {
    const result = await mutationCore(config, db).recover();
    fs.writeFileSync(join(root, `${label}.result`), JSON.stringify({ ok: true, result }));
  } else if (mode === 'move') {
    const result = mutationCore(config, db).move(
      webPrincipal,
      id,
      '00-Inbox',
      'moved.md',
      expected,
      'move-once',
    );
    fs.writeFileSync(join(root, `${label}.result`), JSON.stringify({ ok: true, result }));
  } else if (mode === 'restore') {
    const result = mutationCore(config, db).restore(webPrincipal, id, undefined, 'restore-once');
    fs.writeFileSync(join(root, `${label}.result`), JSON.stringify({ ok: true, result }));
  } else {
    const result = mutationCore(config, db).update(
      webPrincipal,
      id,
      `# ${label}`,
      expected,
      `save-${label}`,
    );
    fs.writeFileSync(join(root, `${label}.result`), JSON.stringify({ ok: true, result }));
  }
} catch (error: any) {
  fs.writeFileSync(
    join(root, `${label}.result`),
    JSON.stringify({ ok: false, code: error.code, message: error.message }),
  );
} finally {
  db.close();
}
