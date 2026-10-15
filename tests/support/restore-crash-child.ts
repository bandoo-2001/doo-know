import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const [id, stage] = process.argv.slice(3);
const exit = () => process.exit(73);
const copy = fs.copyFileSync,
  link = fs.linkSync,
  unlink = fs.unlinkSync;
fs.copyFileSync = ((a: any, b: any, ...args: any[]) => {
  copy(a, b, ...args);
  if (stage === 'copy') exit();
}) as any;
fs.linkSync = ((a: any, b: any) => {
  link(a, b);
  if (stage === 'publish') exit();
}) as any;
fs.unlinkSync = ((p: any) => {
  unlink(p);
  if (stage === 'unlink' && String(p).includes('/.trash/')) exit();
}) as any;
syncBuiltinESMExports();
const { openDatabase } = await import('../../packages/core/db.js');
const { noteService } = await import('../../packages/core/notes.js');
const { recoveryService } = await import('../../packages/core/recovery.js');
const db = openDatabase(config.dataRoot);
const prepare = db.prepare.bind(db);
db.prepare = ((sql: string) => {
  const stmt = prepare(sql);
  const run = stmt.run.bind(stmt);
  stmt.run = ((...args: any[]) => {
    const result = run(...args);
    if (stage === 'intent' && sql.includes('INSERT INTO write_intents')) exit();
    if (stage === 'db-update' && sql.includes('UPDATE notes SET') && sql.includes('active=1'))
      exit();
    if (stage === 'commit' && sql.includes("UPDATE write_intents SET status='recorded'")) {
      // Exit immediately after the encompassing SQLite transaction commits.
      committed = true;
    }
    return result;
  }) as any;
  return stmt;
}) as any;
let committed = false;
const transaction = db.transaction.bind(db);
db.transaction = ((fn: any) => transaction((...args: any[]) => fn(...args))) as any;
recoveryService(config, db, noteService(config, db)).restore(id, undefined, 'crash-restore');
if (stage === 'commit') {
  const op = prepare("SELECT status FROM operations WHERE request_id='crash-restore'").get() as any;
  if (!committed || db.inTransaction || op?.status !== 'succeeded') process.exit(74);
  exit();
}
process.exit(0);
