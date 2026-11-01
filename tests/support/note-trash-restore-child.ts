import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const [configuration, noteId, requestId, stage] = process.argv.slice(2),
  config = JSON.parse(configuration);
const exit = () => process.exit(92),
  copy = fs.copyFileSync,
  link = fs.linkSync,
  unlink = fs.unlinkSync,
  fsync = fs.fsyncSync;
fs.copyFileSync = ((a: any, b: any, ...args: any[]) => {
  (copy as any)(a, b, ...args);
}) as any;
fs.fsyncSync = ((fd: number) => {
  fsync(fd);
  if (
    stage === 'asset_copy' &&
    fs.fstatSync(fd).size > 0 &&
    fs.readlinkSync('/proc/self/fd/' + fd).includes('.doo-note-restore-')
  )
    exit();
}) as any;
fs.linkSync = ((a: any, b: any, ...args: any[]) => {
  (link as any)(a, b, ...args);
  if (stage === 'asset_link' && String(a).includes('.doo-note-restore-')) exit();
  if (stage === 'main_link' && String(a).includes('.doo-restore-')) exit();
}) as any;
fs.unlinkSync = ((path: any) => {
  unlink(path);
  if (stage === 'trash_unlink' && String(path).includes('/.trash/')) exit();
}) as any;
syncBuiltinESMExports();
const { openDatabase } = await import('../../packages/core/db.js'),
  { mutationCore } = await import('../../packages/core/knowledge/core.js');
const db = openDatabase(config.dataRoot),
  prepare = db.prepare.bind(db);
db.prepare = ((sql: string) => {
  const stmt = prepare(sql),
    run = stmt.run.bind(stmt);
  stmt.run = ((...args: any[]) => {
    const result = run(...args);
    if (stage === 'unauthorized_intent' && sql.includes('INSERT INTO write_intents')) exit();
    if (stage === 'activate' && sql.includes('UPDATE notes SET path=?,active=1')) exit();
    return result;
  }) as any;
  return stmt;
}) as any;
mutationCore(config, db).restore(config.agent.policies[0], noteId, undefined, requestId);
if (stage === 'complete') exit();
process.exit(0);
