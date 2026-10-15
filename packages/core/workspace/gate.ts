import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, existsSync, unlinkSync } from 'node:fs';
import { basename } from 'node:path';
import type { AppDatabase } from '../db.js';
import { fail } from '../knowledge/errors.js';
type Metadata = { kind: string; operationId?: string; waitMs?: number };
type Gate = {
  token: string;
  mode: string;
  pid: number;
  process_start: string;
  operation_id: string | null;
  artifacts: string;
};
const held = new AsyncLocalStorage<{ db: AppDatabase; token: string; exclusive: boolean }>();
let boot: string | undefined;
export function workspaceProcess(pid = process.pid) {
  boot ||= readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'),
    fields = stat
      .slice(stat.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/);
  return { pid, start: boot + ':' + fields[19], zombie: fields[0] === 'Z' || fields[0] === 'X' };
}
export function processIsAlive(pid: number, start: string) {
  if (pid <= 0) return false;
  try {
    const actual = workspaceProcess(pid);
    return !actual.zombie && actual.start === start;
  } catch (e) {
    if (['ENOENT', 'ESRCH'].includes((e as any).code)) return false;
    return true;
  }
}
export function initializeWorkspaceGate(db: AppDatabase) {
  db.exec(`CREATE TABLE IF NOT EXISTS workspace_gate(token TEXT PRIMARY KEY,mode TEXT NOT NULL,pid INTEGER NOT NULL,process_start TEXT NOT NULL,operation_id TEXT,kind TEXT NOT NULL,heartbeat_at INTEGER NOT NULL,lease_until INTEGER NOT NULL,artifacts TEXT NOT NULL DEFAULT '[]');
  CREATE TABLE IF NOT EXISTS workspace_guards(token TEXT NOT NULL,pid INTEGER NOT NULL,process_start TEXT NOT NULL,process_group INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(token,pid,process_start));`);
  if (
    !(db.prepare('PRAGMA table_info(workspace_guards)').all() as any[]).some(
      (c) => c.name === 'process_group',
    )
  )
    db.exec('ALTER TABLE workspace_guards ADD COLUMN process_group INTEGER NOT NULL DEFAULT 0');
}
export function processGroupIsAlive(group: number) {
  if (group <= 0) return false;
  for (const pid of readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
    try {
      const s = readFileSync('/proc/' + pid + '/stat', 'utf8'),
        f = s
          .slice(s.lastIndexOf(')') + 2)
          .trim()
          .split(/\s+/);
      if (Number(f[2]) === group && !['Z', 'X'].includes(f[0])) return true;
    } catch (e) {
      if (!['ENOENT', 'ESRCH'].includes((e as any).code)) return true;
    }
  }
  return false;
}
export function guardIsAlive(p: { pid: number; process_start: string; process_group?: number }) {
  return processIsAlive(p.pid, p.process_start) || processGroupIsAlive(p.process_group || 0);
}
function live(db: AppDatabase, row: Gate) {
  return (
    processIsAlive(row.pid, row.process_start) ||
    (
      db
        .prepare('SELECT pid,process_start,process_group FROM workspace_guards WHERE token=?')
        .all(row.token) as any[]
    ).some(guardIsAlive)
  );
}
function sweep(db: AppDatabase) {
  for (const row of db.prepare('SELECT * FROM workspace_gate').all() as Gate[]) {
    if (live(db, row)) continue;
    if (
      row.operation_id &&
      db
        .prepare("SELECT 1 FROM write_intents WHERE id=? AND status IN ('prepared','conflicted')")
        .get(row.operation_id)
    )
      continue;
    for (const file of JSON.parse(row.artifacts) as string[]) {
      if (!/^\.doo-[a-f0-9-]+\.tmp$/.test(basename(file))) fail(409, 'RECOVERY_REQUIRED');
      if (existsSync(file)) {
        try {
          unlinkSync(file);
        } catch {
          fail(409, 'RECOVERY_REQUIRED');
        }
      }
    }
    db.prepare('DELETE FROM workspace_guards WHERE token=?').run(row.token);
    db.prepare('DELETE FROM workspace_gate WHERE token=?').run(row.token);
  }
}
function insert(db: AppDatabase, token: string, mode: string, meta: Metadata) {
  const self = workspaceProcess();
  db.prepare(
    'INSERT INTO workspace_gate(token,mode,pid,process_start,operation_id,kind,heartbeat_at,lease_until) VALUES(?,?,?,?,?,?,?,?)',
  ).run(
    token,
    mode,
    self.pid,
    self.start,
    meta.operationId || null,
    meta.kind,
    Date.now(),
    Date.now() + 60000,
  );
}
function release(db: AppDatabase, token: string) {
  const guards = db
    .prepare('SELECT pid,process_start,process_group FROM workspace_guards WHERE token=?')
    .all(token) as any[];
  if (guards.some(guardIsAlive)) {
    db.prepare("UPDATE workspace_gate SET pid=0,process_start='abandoned' WHERE token=?").run(
      token,
    );
    fail(409, 'WORKSPACE_PROCESS_RUNNING');
  }
  db.prepare('DELETE FROM workspace_guards WHERE token=?').run(token);
  db.prepare('DELETE FROM workspace_gate WHERE token=?').run(token);
}
function acquireShared(db: AppDatabase, meta: Metadata) {
  initializeWorkspaceGate(db);
  const token = randomUUID();
  db.transaction(() => {
    sweep(db);
    if (db.prepare("SELECT 1 FROM workspace_gate WHERE mode<>'shared'").get())
      fail(503, 'WORKSPACE_BUSY', 'WORKSPACE_BUSY', true);
    insert(db, token, 'shared', meta);
  }).immediate();
  return token;
}
export function workspaceWriteSync<T>(db: AppDatabase, meta: Metadata, work: () => T): T {
  if (held.getStore()?.db === db) return work();
  const token = acquireShared(db, meta);
  try {
    return held.run({ db, token, exclusive: false }, work);
  } finally {
    release(db, token);
  }
}
export async function workspaceWrite<T>(
  db: AppDatabase,
  meta: Metadata,
  work: () => Promise<T>,
): Promise<T> {
  if (held.getStore()?.db === db) return work();
  const token = acquireShared(db, meta);
  const beat = setInterval(() => {
    if (db.open)
      db.prepare('UPDATE workspace_gate SET heartbeat_at=?,lease_until=? WHERE token=?').run(
        Date.now(),
        Date.now() + 60000,
        token,
      );
  }, 15000);
  beat.unref();
  try {
    return await held.run({ db, token, exclusive: false }, work);
  } finally {
    clearInterval(beat);
    release(db, token);
  }
}
export async function workspaceExclusive<T>(
  db: AppDatabase,
  meta: Metadata,
  work: () => Promise<T>,
): Promise<T> {
  const current = held.getStore();
  if (current?.db === db) {
    if (!current.exclusive) fail(409, 'WORKSPACE_LOCK_UPGRADE');
    return work();
  }
  initializeWorkspaceGate(db);
  const token = randomUUID(),
    deadline = Date.now() + (meta.waitMs ?? 30000);
  let inserted = false;
  try {
    for (;;) {
      const ready = db
        .transaction(() => {
          sweep(db);
          if (!inserted) {
            if (db.prepare("SELECT 1 FROM workspace_gate WHERE mode<>'shared'").get()) return false;
            insert(db, token, 'exclusive_pending', meta);
            inserted = true;
          }
          if (db.prepare('SELECT 1 FROM workspace_gate WHERE token<>?').get(token)) {
            const dead = (
              db.prepare('SELECT * FROM workspace_gate WHERE token<>?').all(token) as Gate[]
            ).some((r) => !live(db, r));
            if (dead) fail(409, 'RECOVERY_REQUIRED');
            return false;
          }
          if (
            db
              .prepare("SELECT 1 FROM write_intents WHERE status IN ('prepared','conflicted')")
              .get()
          )
            fail(409, 'RECOVERY_REQUIRED');
          db.prepare("UPDATE workspace_gate SET mode='exclusive' WHERE token=?").run(token);
          return true;
        })
        .immediate();
      if (ready) break;
      if (Date.now() >= deadline) fail(503, 'WORKSPACE_BUSY', 'WORKSPACE_BUSY', true);
      await new Promise((r) => setTimeout(r, Math.min(25, Math.max(1, deadline - Date.now()))));
    }
    return await held.run({ db, token, exclusive: true }, work);
  } finally {
    if (inserted) release(db, token);
  }
}
export function operationHasLiveWorkspaceWriter(db: AppDatabase, operationId: string) {
  initializeWorkspaceGate(db);
  return (
    db.prepare('SELECT * FROM workspace_gate WHERE operation_id=?').all(operationId) as Gate[]
  ).some((r) => live(db, r));
}
export function workspaceArtifact(db: AppDatabase, path: string) {
  const gate = held.getStore();
  if (gate?.db !== db) fail(500, 'WORKSPACE_GATE_REQUIRED');
  const row = db
    .prepare('SELECT artifacts FROM workspace_gate WHERE token=?')
    .get(gate.token) as any;
  const artifacts: string[] = JSON.parse(row.artifacts);
  if (!artifacts.includes(path))
    db.prepare('UPDATE workspace_gate SET artifacts=? WHERE token=?').run(
      JSON.stringify([...artifacts, path]),
      gate.token,
    );
}
export function workspacePermit(db: AppDatabase, exclusive = true) {
  const gate = held.getStore();
  if (gate?.db !== db || (exclusive && !gate.exclusive)) fail(500, 'WORKSPACE_EXCLUSIVE_REQUIRED');
  return gate.token;
}

export function workspaceOperation(db: AppDatabase, id: string) {
  const gate = held.getStore();
  if (gate?.db !== db) fail(500, 'WORKSPACE_GATE_REQUIRED');
  db.prepare('UPDATE workspace_gate SET operation_id=? WHERE token=?').run(id, gate.token);
}
export function workspaceBegin<T extends { operation: { id: string } }>(
  db: AppDatabase,
  work: () => T,
): T {
  return db
    .transaction(() => {
      const result = work();
      workspaceOperation(db, result.operation.id);
      return result;
    })
    .immediate();
}
