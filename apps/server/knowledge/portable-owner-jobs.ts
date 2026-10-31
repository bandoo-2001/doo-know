import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '../../../packages/core/db.js';
import { fail } from '../../../packages/core/knowledge/errors.js';
import { workspaceProcess, processIsAlive } from '../../../packages/core/workspace/gate.js';
import type { PortableOwnerJob } from '../../../shared/portable-delivery-contracts.js';

type Row = {
  id: string;
  owner: string;
  request_id: string;
  kind: PortableOwnerJob['kind'];
  input: string;
  state: PortableOwnerJob['state'];
  result: string | null;
  error: string | null;
  updated: number;
  pid: number;
  process_start: string;
  pending: string | null;
};
const active = new WeakMap<AppDatabase, Map<string, AbortController>>();
/** Durable owner receipts; uploaded source bytes are deliberately not retained after a request. */
export function portableOwnerJobs(db: AppDatabase) {
  db.exec(
    `CREATE TABLE IF NOT EXISTS portable_owner_jobs(id TEXT PRIMARY KEY,owner TEXT NOT NULL,request_id TEXT NOT NULL,kind TEXT NOT NULL,input TEXT NOT NULL,state TEXT NOT NULL,result TEXT,error TEXT,updated INTEGER NOT NULL,pid INTEGER NOT NULL,process_start TEXT NOT NULL,UNIQUE(owner,request_id));`,
  );
  if (
    !(db.prepare('PRAGMA table_info(portable_owner_jobs)').all() as { name: string }[]).some(
      (column) => column.name === 'pending',
    )
  )
    db.exec('ALTER TABLE portable_owner_jobs ADD COLUMN pending TEXT');
  let controllers = active.get(db);
  if (!controllers) active.set(db, (controllers = new Map()));
  const recover = () => {
    for (const row of db
      .prepare("SELECT * FROM portable_owner_jobs WHERE state='running'")
      .all() as Row[]) {
      if (!processIsAlive(row.pid, row.process_start))
        db.prepare(
          "UPDATE portable_owner_jobs SET state='interrupted',error='PORTABLE_INTERRUPTED',updated=? WHERE id=?",
        ).run(Date.now(), row.id);
    }
  };
  const own = (owner: string, id: string) => {
    recover();
    const row = db
      .prepare('SELECT * FROM portable_owner_jobs WHERE id=? AND owner=?')
      .get(id, owner) as Row | undefined;
    if (!row) fail(404, 'PORTABLE_JOB_NOT_FOUND');
    return row;
  };
  const view = (row: Row): PortableOwnerJob => {
    let result = row.result ? JSON.parse(row.result) : undefined;
    if (row.kind === 'export' && row.state !== 'completed') {
      const table = db
        .prepare("SELECT 1 FROM sqlite_master WHERE name='portable_deliveries'")
        .get();
      const delivery = table
        ? (db
            .prepare(
              "SELECT result FROM portable_deliveries WHERE principal=? AND client=? AND request_id=? AND status='ready'",
            )
            .get(row.owner, 'portable-owner', row.request_id) as { result: string } | undefined)
        : undefined;
      if (delivery) {
        result = JSON.parse(delivery.result);
        row.state = 'completed';
        row.error = null;
        db.prepare(
          "UPDATE portable_owner_jobs SET state='completed',result=?,error=NULL WHERE id=?",
        ).run(delivery.result, row.id);
      }
    }
    // Core persists partial imports independently. Recover those receipts after a lost response.
    if (row.kind !== 'export') {
      const table = db
        .prepare("SELECT 1 FROM sqlite_master WHERE name='portable_import_jobs'")
        .get();
      const receipt = table
        ? (db
            .prepare(
              'SELECT result,complete FROM portable_import_jobs WHERE principal=? AND client=? AND request_id=?',
            )
            .get(row.owner, 'portable-owner', row.request_id) as
            | { result: string; complete: number }
            | undefined)
        : undefined;
      if (receipt) {
        result = JSON.parse(receipt.result);
        if (receipt.complete && row.state !== 'completed') {
          row.state = 'completed';
          row.error = null;
          db.prepare(
            "UPDATE portable_owner_jobs SET state='completed',result=?,error=NULL WHERE id=?",
          ).run(receipt.result, row.id);
        }
      }
      if (result?.notes)
        result.notes = result.notes.map((note: any) => {
          const current = db
            .prepare('SELECT id,path FROM notes WHERE id=? AND active=1')
            .get(note.noteId) as { id: string; path: string } | undefined;
          return current ? { ...note, relativePath: current.path } : { ...note, unavailable: true };
        });
    }
    return {
      ...(row.kind !== 'export' ? { folderPath: JSON.parse(row.input).folderPath } : {}),
      id: row.id,
      requestId: row.request_id,
      kind: row.kind,
      state: row.state,
      updatedAt: row.updated,
      needsSource: row.kind !== 'export' && row.state !== 'completed',
      ...(result ? { result } : {}),
      ...(row.error ? { error: row.error } : {}),
      ...(row.pending && row.state !== 'completed'
        ? { portablePreviews: JSON.parse(row.pending) }
        : {}),
    };
  };
  return {
    list(owner: string) {
      recover();
      return (
        db
          .prepare(
            'SELECT * FROM portable_owner_jobs WHERE owner=? ORDER BY updated DESC LIMIT 100',
          )
          .all(owner) as Row[]
      ).map(view);
    },
    read(owner: string, id: string) {
      return view(own(owner, id));
    },
    input(owner: string, id: string) {
      return JSON.parse(own(owner, id).input);
    },
    cancel(owner: string, id: string) {
      const row = own(owner, id);
      if (row.state === 'completed') fail(409, 'PORTABLE_JOB_ALREADY_COMPLETED');
      db.prepare(
        "UPDATE portable_owner_jobs SET state='cancelled',error='PORTABLE_CANCELLED',pending=NULL,updated=? WHERE id=?",
      ).run(Date.now(), id);
      controllers!.get(id)?.abort(Error('PORTABLE_CANCELLED'));
      return view(own(owner, id));
    },
    async run<T>(
      owner: string,
      requestId: string,
      kind: Row['kind'],
      input: unknown,
      operation: (signal: AbortSignal, check: () => void) => Promise<T>,
      outerSignal?: AbortSignal,
    ): Promise<T> {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestId)) fail(400, 'INVALID_REQUEST_ID');
      recover();
      const old = db
          .prepare('SELECT * FROM portable_owner_jobs WHERE owner=? AND request_id=?')
          .get(owner, requestId) as Row | undefined,
        serialized = JSON.stringify(input);
      if (old && (old.kind !== kind || old.input !== serialized)) fail(409, 'REQUEST_ID_CONFLICT');
      if (old && (old.state === 'running' || controllers!.has(old.id)))
        fail(409, 'PORTABLE_JOB_IN_PROGRESS');
      const id = old?.id || randomUUID(),
        process = workspaceProcess(),
        controller = new AbortController();
      const abort = () => controller.abort(outerSignal?.reason || Error('PORTABLE_CANCELLED'));
      outerSignal?.addEventListener('abort', abort, { once: true });
      if (outerSignal?.aborted) abort();
      db.prepare(
        `INSERT INTO portable_owner_jobs(id,owner,request_id,kind,input,state,result,error,updated,pid,process_start) VALUES(?,?,?,?,?,'running',NULL,NULL,?,?,?) ON CONFLICT(id) DO UPDATE SET state='running',error=NULL,pending=NULL,updated=excluded.updated,pid=excluded.pid,process_start=excluded.process_start`,
      ).run(id, owner, requestId, kind, serialized, Date.now(), process.pid, process.start);
      controllers!.set(id, controller);
      const check = () => {
        if (controller.signal.aborted || own(owner, id).state === 'cancelled')
          fail(409, 'PORTABLE_CANCELLED');
      };
      try {
        check();
        const result = await operation(controller.signal, check);
        check();
        db.prepare(
          "UPDATE portable_owner_jobs SET state='completed',result=?,error=NULL,pending=NULL,updated=? WHERE id=?",
        ).run(JSON.stringify(result), Date.now(), id);
        return result;
      } catch (error) {
        const cancelled = controller.signal.aborted || (error as any).code === 'PORTABLE_CANCELLED';
        db.prepare(
          'UPDATE portable_owner_jobs SET state=?,error=?,updated=?,pending=? WHERE id=?',
        ).run(
          cancelled ? 'cancelled' : 'failed',
          cancelled ? 'PORTABLE_CANCELLED' : (error as any).code || 'PORTABLE_OPERATION_FAILED',
          Date.now(),
          (error as any).code === 'DIAGRAM_PREVIEW_REQUIRED' &&
            Array.isArray((error as any).details?.portablePreviews)
            ? JSON.stringify((error as any).details.portablePreviews)
            : null,
          id,
        );
        throw error;
      } finally {
        controllers!.delete(id);
        outerSignal?.removeEventListener('abort', abort);
      }
    },
  };
}
