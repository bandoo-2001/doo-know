import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { openDatabase } from '../../packages/core/db.js';
import { restoreFolder } from '../../packages/core/folders.js';
import { workspaceExclusive } from '../../packages/core/workspace/gate.js';
const [configJson, id, name, requestId, point] = process.argv.slice(2),
  config = JSON.parse(configJson),
  db = openDatabase(config.dataRoot);
const rename = fs.renameSync.bind(fs);
fs.renameSync = ((source, target) => {
  rename(source, target);
  if (
    (point === 'archived_note' && String(target).endsWith('/board.md')) ||
    (point === 'active_note' && String(target).endsWith('/outside.md')) ||
    (point === 'directory_renamed' && String(target).endsWith('/Restored'))
  )
    process.exit(91);
}) as typeof fs.renameSync;
if (point === 'metadata') {
  const prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    const statement = prepare(sql),
      run = statement.run.bind(statement);
    if (sql.startsWith("UPDATE operations SET status='succeeded'"))
      statement.run = ((...args: any[]) => {
        const result = run(...args);
        process.exit(91);
        return result;
      }) as typeof statement.run;
    return statement;
  }) as typeof db.prepare;
}
syncBuiltinESMExports();
await workspaceExclusive(db, { kind: 'folder.restore' }, async () =>
  restoreFolder(config, db, id, name, requestId),
);
db.close();
