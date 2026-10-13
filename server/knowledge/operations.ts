import { createHash, randomUUID } from 'node:crypto';
import type { AppDatabase } from '../db.js';
import type { Principal } from '../../shared/knowledge-contracts.js';
import { fail } from './errors.js';
export function releaseSnapshotRef(db: AppDatabase, operationId: string) {
  db.transaction(() => {
    const row = db
      .prepare(
        'SELECT snapshot_id,snapshot_ref_released FROM file_operations WHERE id=? AND kind=?',
      )
      .get(operationId, 'patch') as any;
    if (row?.snapshot_id && !row.snapshot_ref_released) {
      db.prepare(
        'UPDATE file_operations SET snapshot_ref_released=1 WHERE id=? AND snapshot_ref_released=0',
      ).run(operationId);
      db.prepare('UPDATE read_snapshots SET refs=max(0,refs-1) WHERE id=?').run(row.snapshot_id);
    }
  })();
}
export const sha256 = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
export interface OperationRow {
  id: string;
  principal: string;
  client_id: string;
  kind: string;
  request_id: string;
  params_hash: string;
  status: string;
  result: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}
export function beginOperation(
  db: AppDatabase,
  p: Principal,
  kind: string,
  requestId: string,
  params: unknown,
) {
  if (
    typeof requestId !== 'string' ||
    !requestId.length ||
    requestId.length > 128 ||
    /[\x00-\x1f]/.test(requestId)
  )
    fail(400, 'INVALID_REQUEST_ID');
  const digest = sha256(JSON.stringify(canonical(params)));
  const existing = db
    .prepare(
      'SELECT * FROM operations WHERE principal=? AND client_id=? AND kind=? AND request_id=?',
    )
    .get(p.id, p.clientId, kind, requestId) as OperationRow | undefined;
  if (existing) {
    if (existing.params_hash !== digest) fail(409, 'IDEMPOTENCY_CONFLICT');
    return { operation: existing, fresh: false };
  }
  const id = randomUUID(),
    now = Date.now();
  db.prepare(
    'INSERT INTO operations(id,principal,client_id,kind,request_id,params_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
  ).run(id, p.id, p.clientId, kind, requestId, digest, 'prepared', now, now);
  return {
    operation: db.prepare('SELECT * FROM operations WHERE id=?').get(id) as OperationRow,
    fresh: true,
  };
}
export function completeOperation(db: AppDatabase, id: string, result: unknown) {
  db.prepare(
    "UPDATE operations SET status='succeeded',result=?,error=NULL,updated_at=? WHERE id=?",
  ).run(JSON.stringify(result), Date.now(), id);
}
export function existingResult(op: OperationRow): any {
  if (op.status === 'succeeded') return JSON.parse(op.result!);
  if (op.status === 'failed' || op.status === 'cancelled')
    return fail(409, op.error || 'OPERATION_FAILED');
  return fail(409, 'OPERATION_OUTCOME_UNKNOWN', '按原 requestId 核对操作结果', true);
}
export function findOperation(
  db: AppDatabase,
  p: Principal,
  key: { id?: string; requestId?: string },
) {
  const op = (
    key.id
      ? db
          .prepare('SELECT * FROM operations WHERE id=? AND principal=? AND client_id=?')
          .get(key.id, p.id, p.clientId)
      : db
          .prepare(
            'SELECT * FROM operations WHERE request_id=? AND principal=? AND client_id=? ORDER BY created_at DESC LIMIT 1',
          )
          .get(key.requestId, p.id, p.clientId)
  ) as OperationRow | undefined;
  if (!op) fail(404, 'OPERATION_NOT_FOUND');
  return {
    operationId: op.id,
    requestId: op.request_id,
    kind: op.kind,
    status: op.status,
    ...(op.result ? { result: JSON.parse(op.result) } : {}),
    ...(op.error
      ? { error: { code: op.error, retryable: op.status === 'needs_reconciliation' } }
      : {}),
  };
}
