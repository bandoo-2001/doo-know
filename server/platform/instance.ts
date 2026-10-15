import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { openDatabase } from '../db.js';
import type { HostConfig } from '../../shared/platform-contracts.js';
import { workspaceProcess, processIsAlive } from '../workspace/gate.js';
import { fail } from '../knowledge/errors.js';
export function readInstance(dataRoot: string) {
  let db: Database.Database | undefined;
  try {
    db = new Database(join(dataRoot, 'app.sqlite'), { readonly: true, fileMustExist: true });
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='platform_instance'").get()) return;
    const row = db.prepare('SELECT * FROM platform_instance WHERE id=1').get() as any;
    return row && processIsAlive(row.pid, row.process_start) ? row : undefined;
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}
export function acquireInstance(config: HostConfig, version: string) {
  const db = openDatabase(config.dataRoot),
    self = workspaceProcess(),
    token = randomUUID();
  try {
    db.exec(
      'CREATE TABLE IF NOT EXISTS platform_instance(id INTEGER PRIMARY KEY CHECK(id=1),pid INTEGER NOT NULL,process_start TEXT NOT NULL,token TEXT NOT NULL,profile_file TEXT NOT NULL,version TEXT NOT NULL)',
    );
    db.transaction(() => {
      const current = db.prepare('SELECT * FROM platform_instance WHERE id=1').get() as any;
      if (current && processIsAlive(current.pid, current.process_start))
        fail(409, 'INSTANCE_ALREADY_RUNNING', '同一数据目录已有 DooKnow 进程');
      db.prepare(
        'INSERT INTO platform_instance VALUES(1,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET pid=excluded.pid,process_start=excluded.process_start,token=excluded.token,profile_file=excluded.profile_file,version=excluded.version',
      ).run(self.pid, self.start, token, resolve(config.profileFile || ''), version);
    }).immediate();
  } finally {
    db.close();
  }
  return () => {
    const current = openDatabase(config.dataRoot);
    try {
      current.prepare('DELETE FROM platform_instance WHERE id=1 AND token=?').run(token);
    } finally {
      current.close();
    }
  };
}
export function activeDatabaseProcesses(dataRoot: string) {
  const db = openDatabase(dataRoot);
  try {
    return (
      db.prepare('SELECT pid,process_start,role FROM database_processes').all() as any[]
    ).filter((p) => p.pid !== process.pid && processIsAlive(p.pid, p.process_start));
  } finally {
    db.close();
  }
}
