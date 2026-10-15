import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../apps/server/config.js';
import { openDatabase } from '../packages/core/db.js';
import { noteService } from '../packages/core/notes.js';
import { snapshotService } from '../packages/core/knowledge/snapshots.js';
import { indexWorker } from '../packages/core/indexing/worker.js';
const config = loadConfig(),
  db = openDatabase(config.dataRoot,'index-worker'),
  notes = noteService(config, db),
  snapshots = snapshotService(config, db, notes),
  worker = indexWorker(config, db, notes, snapshots);
let stopped = false;
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    stopped = true;
  });
try {
  do {
    await snapshots.recover();
    await worker.drain();
    await snapshots.clean();
    if (process.argv.includes('--once')) break;
    await delay(1000);
  } while (!stopped);
} finally {
  await worker.close();
  await snapshots.close();
  db.close();
}
