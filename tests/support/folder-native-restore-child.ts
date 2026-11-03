import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { openDatabase } from '../../packages/core/db.js';
import { restoreFolder } from '../../packages/core/folders.js';
import { workspaceExclusive } from '../../packages/core/workspace/gate.js';
const [configJson, id, name, requestId, point] = process.argv.slice(2),
  config = JSON.parse(configJson),
  db = openDatabase(config.dataRoot);
if (point === 'directory_renamed_known_time') {
  const open = fs.openSync.bind(fs),
    sync = fs.fsyncSync.bind(fs),
    paths = new Map<number, string>();
  fs.openSync = ((path, ...args: any[]) => {
    const fd = (open as any)(path, ...args);
    if (String(path).includes('.doo-folder-restore-') && args[0] === 'wx')
      paths.set(fd, String(path));
    return fd;
  }) as typeof fs.openSync;
  fs.fsyncSync = ((fd) => {
    const path = paths.get(fd);
    if (path) {
      fs.utimesSync(path, 1000000000, 1000000000);
      paths.delete(fd);
    }
    sync(fd);
  }) as typeof fs.fsyncSync;
}
const rename = fs.renameSync.bind(fs);
fs.renameSync = ((source, target) => {
  rename(source, target);
  if (
    (point === 'archived_note' && String(target).endsWith('/board.md')) ||
    (point === 'active_note' && String(target).endsWith('/outside.md')) ||
    (['directory_renamed', 'directory_renamed_known_time'].includes(point) &&
      String(target).endsWith('/Restored'))
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
