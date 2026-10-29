import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { AppConfig } from '../../../shared/contracts.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import type { AppDatabase } from '../db.js';
import { safePath } from '../files.js';
import { assertRoot } from '../indexing/reconcile.js';
import { assertOrganizationReadable, operationHasLiveWorkspaceWriter } from '../workspace/gate.js';
import { canAccessPath, requireScope } from '../agent/auth.js';
import { fail } from '../knowledge/errors.js';
export const hash = (v: string) => createHash('sha256').update(v).digest('hex');
export const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const fingerprint = (s: any) =>
  [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.nlink].map(String).join(':');
export type SourceVersion = {
  id: string;
  path: string;
  source_revision: number | null;
  managed_hash: string | null;
};
export function sourceAccess(config: AppConfig, db: AppDatabase) {
  function barrier() {
    assertOrganizationReadable(db);
    assertRoot(config, db);
    if (
      (db.prepare('SELECT active FROM maintenance WHERE id=1').get() as any)?.active ||
      db.prepare("SELECT 1 FROM sync_runs WHERE status IN ('running','needs_reconciliation')").get()
    )
      fail(503, 'SYNC_IN_PROGRESS');
  }
  function authorize(p: Principal, owner = false) {
    if (p.id.startsWith('share:') || (owner && p.id !== 'web-owner')) fail(403, 'FORBIDDEN');
    requireScope(p, 'knowledge:read');
    barrier();
  }
  function current(id: string): SourceVersion | undefined {
    const row = db
      .prepare(
        `SELECT n.id,n.path,n.active,d.source_revision,d.content_hash AS managed_hash,d.active AS source_active,d.conflict FROM notes n LEFT JOIN document_state d ON d.note_id=n.id WHERE n.id=?`,
      )
      .get(id) as any;
    if (!row?.active || row.source_active === 0 || row.conflict || !/\.md$/i.test(row.path)) return;
    if (
      db
        .prepare(
          `SELECT 1 FROM write_intents WHERE note_id=? AND status IN ('prepared','conflicted') UNION ALL SELECT 1 FROM file_operations WHERE note_id=? AND status IN ('queued','running','committing','needs_reconciliation') LIMIT 1`,
        )
        .get(id, id)
    )
      return;
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='note_write_leases'").get()) {
      const lease = db
        .prepare('SELECT owner,lease_until FROM note_write_leases WHERE note_id=?')
        .get(id) as any;
      if (
        lease &&
        (lease.lease_until > Date.now() ||
          operationHasLiveWorkspaceWriter(db, lease.owner.split(':')[0]))
      )
        return;
    }
    return row;
  }
  function inspect(path: string) {
    const file = safePath(config.knowledgeRoot, path, 'note'),
      stat = lstatSync(file, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw Error('UNSAFE_SOURCE');
    if (stat.size > BigInt(MAX_SOURCE_BYTES)) throw Error('SOURCE_TOO_LARGE');
    return { file, fingerprint: fingerprint(stat), size: Number(stat.size) };
  }
  function read(path: string) {
    const info = inspect(path),
      fd = openSync(info.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (fingerprint(fstatSync(fd, { bigint: true })) !== info.fingerprint)
        throw Error('SOURCE_CHANGED');
      const buffer = Buffer.alloc(info.size + 1);
      let size = 0;
      while (size < buffer.length) {
        const n = readSync(fd, buffer, size, buffer.length - size, null);
        if (!n) break;
        size += n;
      }
      if (
        size !== info.size ||
        fingerprint(fstatSync(fd, { bigint: true })) !== info.fingerprint ||
        inspect(path).fingerprint !== info.fingerprint
      )
        throw Error('SOURCE_CHANGED');
      return {
        ...info,
        text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
          buffer.subarray(0, size),
        ),
      };
    } finally {
      closeSync(fd);
    }
  }
  function valid(row: SourceVersion & { fingerprint: string }) {
    const now = current(row.id);
    if (
      !now ||
      now.path !== row.path ||
      now.source_revision !== row.source_revision ||
      now.managed_hash !== row.managed_hash
    )
      return false;
    try {
      return inspect(row.path).fingerprint === row.fingerprint;
    } catch {
      return false;
    }
  }
  function allowed(p: Principal, path: string) {
    return canAccessPath(p, path);
  }
  return { barrier, authorize, current, inspect, read, valid, allowed };
}
