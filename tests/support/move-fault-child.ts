import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const [id, expected, stage] = process.argv.slice(3);
const source = config.knowledgeRoot + '/00-Inbox/source.md',
  dest = config.knowledgeRoot + '/10-Projects/destination.md';
const exit = () => process.exit(73);
const copy = fs.copyFileSync,
  link = fs.linkSync,
  unlink = fs.unlinkSync;
fs.copyFileSync = ((...args: any[]) => {
  (copy as any)(...args);
  if (stage === 'copy') exit();
}) as any;
fs.linkSync = ((a: any, b: any) => {
  if (stage === 'occupied') fs.writeFileSync(dest, '# external target');
  link(a, b);
  if (stage === 'publish') exit();
  if (stage === 'source-changed') fs.writeFileSync(source, '# external source');
}) as any;
fs.unlinkSync = ((path: any) => {
  unlink(path);
  if (stage === 'unlink' && path === source) exit();
}) as any;
syncBuiltinESMExports();
const { openDatabase } = await import('../../packages/core/db.js');
const { mutationCore, webPrincipal } = await import('../../packages/core/knowledge/core.js');
const db = openDatabase(config.dataRoot);
const prepare = db.prepare.bind(db);
let intentInserted = false;
db.prepare = ((sql: string) => {
  const stmt = prepare(sql),
    run = stmt.run.bind(stmt);
  stmt.run = ((...args: any[]) => {
    const result = run(...args);
    if (sql.includes('INSERT INTO write_intents')) intentInserted = true;
    if (stage === 'db-update' && sql.includes('UPDATE notes SET path=')) exit();
    return result;
  }) as any;
  return stmt;
}) as any;
const transaction = db.transaction.bind(db);
db.transaction = ((fn: any) => {
  const txn = transaction(fn),
    immediate = txn.immediate.bind(txn);
  const wrapped = (...args: any[]) => txn(...args);
  return Object.assign(wrapped, {
    deferred: txn.deferred.bind(txn),
    exclusive: txn.exclusive.bind(txn),
    immediate: (...args: any[]) => {
      const result = immediate(...args);
      if (stage === 'intent' && intentInserted) exit();
      return result;
    },
  });
}) as any;
try {
  const core = mutationCore(config, db);
  if (stage === 'recover') await core.recover();
  else core.move(webPrincipal, id, '10-Projects', 'destination.md', expected, 'crash-move');
  if (stage === 'commit') exit();
  process.exit(0);
} catch (error) {
  if (['occupied', 'source-changed'].includes(stage)) process.exit(73);
  console.error(error);
  process.exit(74);
}
