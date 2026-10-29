import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../apps/server/config.js';
import { openDatabase } from '../packages/core/db.js';
import { noteService } from '../packages/core/notes.js';
import { mutationCore } from '../packages/core/knowledge/core.js';
import { snapshotService } from '../packages/core/knowledge/snapshots.js';
import { fileJobService } from '../packages/core/knowledge/file-jobs.js';
import { organizationService } from '../packages/core/organization/service.js';
const config = { ...loadConfig(), fileTasks: { embedded: true } },
  db = openDatabase(config.dataRoot, 'file-worker'),
  notes = noteService(config, db),
  snapshots = snapshotService(config, db, notes),
  files = fileJobService(config, db, notes, snapshots);
const organization = organizationService(config, db, notes);
let stopped = false;
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    stopped = true;
  });
try {
  do {
    await organization.recover();
    await organization.drain();
    await organization.cleanup();
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
  await organization.close();
  await files.close();
  await snapshots.close();
  db.close();
}
