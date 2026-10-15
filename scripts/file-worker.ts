import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../server/config.js';
import { openDatabase } from '../server/db.js';
import { noteService } from '../server/notes.js';
import { mutationCore } from '../server/knowledge/core.js';
import { snapshotService } from '../server/knowledge/snapshots.js';
import { fileJobService } from '../server/knowledge/file-jobs.js';
const config = { ...loadConfig(), fileTasks: { embedded: true } },
  db = openDatabase(config.dataRoot,'file-worker'),
  notes = noteService(config, db),
  snapshots = snapshotService(config, db, notes),
  files = fileJobService(config, db, notes, snapshots);
let stopped = false;
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    stopped = true;
  });
try {
  do {
    await mutationCore(config, db).recover();
    await snapshots.recover();
    await files.recover();
    await files.drain();
    await snapshots.drain();
    await snapshots.clean();
    if (process.argv.includes('--once')) break;
    await delay(1000);
  } while (!stopped);
} finally {
  await files.close();
  await snapshots.close();
  db.close();
}
