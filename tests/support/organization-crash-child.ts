import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { openDatabase } from '../../packages/core/db.js';
import { noteService } from '../../packages/core/notes.js';
import { organizationService } from '../../packages/core/organization/service.js';
const [configJson, inputJson, point] = process.argv.slice(2),
  config = JSON.parse(configJson),
  input = JSON.parse(inputJson),
  db = openDatabase(config.dataRoot),
  notes = noteService(config, db);
let attacked = false;
function attack(source: unknown) {
  if (point === 'symlink' && !attacked && String(source).endsWith('/assets/a.png')) {
    attacked = true;
    fs.unlinkSync(source as string);
    fs.symlinkSync(config.dataRoot + '/private.txt', source as string);
    fs.writeFileSync(config.dataRoot + '/attack-triggered', 'yes');
  }
}
const originalOpen = fs.openSync.bind(fs);
fs.openSync = ((path, ...args: any[]) => {
  attack(path);
  return (originalOpen as any)(path, ...args);
}) as typeof fs.openSync;
const originalCopy = fs.copyFileSync.bind(fs);
if (point === 'symlink')
  fs.copyFileSync = ((source, target, mode) => {
    attack(source);
    originalCopy(source, target, mode);
  }) as typeof fs.copyFileSync;
let copies = 0;
const backupDescriptors = new Set<number>(),
  stageOpen = fs.openSync.bind(fs),
  stageSync = fs.fsyncSync.bind(fs);
if (point === 'stage_copy' || point === 'stage_newlink') {
  fs.openSync = ((path, ...args: any[]) => {
    const fd = (stageOpen as any)(path, ...args);
    if (String(path).endsWith('.before') && args[0] === 'wx') backupDescriptors.add(fd);
    return fd;
  }) as typeof fs.openSync;
  fs.fsyncSync = ((fd) => {
    stageSync(fd);
    if (backupDescriptors.delete(fd)) {
      copies++;
      if (point === 'stage_copy' && copies === 2) process.exit(91);
      if (point === 'stage_newlink' && copies === 1)
        fs.writeFileSync(config.knowledgeRoot + '/Topic/unaffected.md', '[new](../00-Inbox/a.md)');
    }
  }) as typeof fs.fsyncSync;
}
const originalLink = fs.linkSync.bind(fs),
  originalUnlink = fs.unlinkSync.bind(fs),
  originalMkdir = fs.mkdirSync.bind(fs);
if (point === 'late_backlink')
  fs.linkSync = ((source, target) => {
    originalLink(source, target);
    if (String(target).endsWith('moved.md'))
      fs.writeFileSync(config.knowledgeRoot + '/Topic/new-incoming.md', '[new](../00-Inbox/a.md)');
  }) as typeof fs.linkSync;
if (point === 'publish')
  fs.linkSync = ((source, target) => {
    originalLink(source, target);
    if (String(target).endsWith('moved.md')) process.exit(91);
  }) as typeof fs.linkSync;
if (point === 'source_removed')
  fs.unlinkSync = ((path) => {
    originalUnlink(path);
    if (String(path).endsWith('/a.md')) process.exit(91);
  }) as typeof fs.unlinkSync;
if (point === 'directory_unproven')
  fs.mkdirSync = ((path, options) => {
    const result = originalMkdir(path, options as any);
    if (String(path).endsWith('/Moved')) process.exit(91);
    return result;
  }) as typeof fs.mkdirSync;
if (point === 'metadata') {
  const prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    const stmt = prepare(sql),
      run = stmt.run.bind(stmt);
    if (sql.startsWith("UPDATE operations SET status='succeeded'"))
      stmt.run = ((...args: any[]) => {
        const result = run(...args);
        process.exit(91);
        return result;
      }) as typeof stmt.run;
    return stmt;
  }) as typeof db.prepare;
}
syncBuiltinESMExports();
const service = organizationService(config, db, notes);
await service.submit(config.agent.policies[0], input);
await service.drain();
db.close();
process.exit(0);
