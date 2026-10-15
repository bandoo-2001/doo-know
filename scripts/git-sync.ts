import { loadConfig } from '../apps/server/config.js';
import { openDatabase } from '../packages/core/db.js';
import { reconcileService } from '../packages/core/indexing/reconcile.js';
import { syncService } from '../packages/core/indexing/sync.js';
const config = loadConfig(),
  db = openDatabase(config.dataRoot),
  indexing = reconcileService(config, db);
try {
  const result = await syncService(config, db, indexing).pull();
  process.stdout.write(JSON.stringify(result) + '\n');
  if (result.status !== 'succeeded') process.exitCode = 1;
} catch {
  process.stderr.write('本机同步未完成；保留工作区并检查同步状态。\n');
  process.exitCode = 1;
} finally {
  await indexing.close();
  db.close();
}
