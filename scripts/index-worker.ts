import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../server/config.js';
import { openDatabase } from '../server/db.js';
import { noteService } from '../server/notes.js';
import { snapshotService } from '../server/knowledge/snapshots.js';
import { indexWorker } from '../server/indexing/worker.js';
const config = loadConfig(),
  db = openDatabase(config.dataRoot),
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
