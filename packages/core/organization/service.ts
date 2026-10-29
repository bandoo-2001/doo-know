import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { readFileSync, existsSync, rmSync, lstatSync } from 'node:fs';
import type { AppConfig } from '../../../shared/contracts.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import type {
  DirectoryListInput,
  DirectoryPage,
  HistoryInput,
  HistoryPage,
  OrganizeInput,
  OrganizationContext,
  OrganizationOperation,
  OrganizationReply,
  UndoOrganizationInput,
} from '../../../shared/organization-contracts.js';
import type { AppDatabase } from '../db.js';
import type { NoteService } from '../notes.js';
import { requireScope, canAccessPath, checkTokenCutoff } from '../agent/auth.js';
import { currentPrincipalPolicy } from '../agent/config.js';
import {
  projectPermissionPrincipal,
  intersectPermissionPolicies,
  resourceContains,
} from '../auth/permissions.js';
import { fail, KnowledgeError } from '../knowledge/errors.js';
import { beginOperation, sha256 } from '../knowledge/operations.js';
import { decodeCursor, signCursor } from '../agent/budgets.js';
import {
  workspaceExclusive,
  workspaceWriteSync,
  workspaceProcess,
  processIsAlive,
  assertOrganizationReadable,
} from '../workspace/gate.js';
import { migrateOrganization } from './schema.js';
import { syncDirectoryCatalog, libraryIdentity, resolveDirectory } from './catalog.js';
import {
  prepareOrganization,
  revalidateManifest,
  requireOrganization,
  checkPermissions,
  organizationLimits,
  evidence,
  readBody,
  inventory,
  sameIdentity,
  type OrganizationManifest,
  type Change,
} from './plan.js';
import { rewriteLibraryReferences } from './references.js';
import { organizationResponseFits, assertOrganizationReceiptFits } from './response-budget.js';
import {
  stageOrganization,
  commitOrganization,
  journalDirectory,
  outputInventory,
} from './journal.js';
export function organizationService(config: AppConfig, db: AppDatabase, notes: NoteService) {
  migrateOrganization(db);
  let tail = Promise.resolve(),
    closing = false;
  const callbacks = new Map<string, () => Principal>();
  function projected(p: Principal) {
    checkTokenCutoff(db, p);
    return p.permissionPolicy ? projectPermissionPrincipal(db, p, p.permissionPolicy) : p;
  }
  function live(p: Principal, recheck?: () => Principal) {
    const refreshed = recheck
      ? recheck()
      : p.id === 'web-owner'
        ? p
        : currentPrincipalPolicy(config, db, p);
    if (!refreshed || refreshed.id !== p.id || refreshed.clientId !== p.clientId)
      fail(403, 'FORBIDDEN');
    const original = projected(p),
      current = projected(refreshed);
    const scopes = current.scopes.filter((scope) => original.scopes.includes(scope));
    if (original.permissionPolicy && current.permissionPolicy) {
      return projectPermissionPrincipal(
        db,
        { ...current, scopes },
        intersectPermissionPolicies(
          original.permissionPolicy,
          current.permissionPolicy,
          resourceContains(db),
        ),
      );
    }
    const refs = (principal: Principal) =>
      principal.knowledgeResourcePaths ??
      principal.allowedPrefixes.map((path) => ({
        kind: path.endsWith('.md') ? 'note' : 'directory',
        id: path,
        path,
      }));
    const left = refs(original),
      right = refs(current),
      knowledgeAll = !!original.knowledgeAll && !!current.knowledgeAll;
    const contains = (a: (typeof left)[number], b: (typeof right)[number]) =>
      a.path === b.path || (a.kind !== 'note' && b.path.startsWith(a.path + '/'));
    const selected = original.knowledgeAll
      ? right
      : current.knowledgeAll
        ? left
        : left.flatMap((a) =>
            right.flatMap((b) => (contains(a, b) ? [b] : contains(b, a) ? [a] : [])),
          );
    return {
      ...current,
      scopes,
      knowledgeAll,
      knowledgeResourcePaths: selected,
      allowedPrefixes: [...new Set(selected.map((ref) => ref.path))],
    };
  }
  function context(p: Principal): OrganizationContext {
    p = projected(p);
    requireScope(p, 'knowledge:read');
    assertOrganizationReadable(db);
    syncDirectoryCatalog(config, db);
    const state = libraryIdentity(db)!,
      row = db
        .prepare('SELECT inbox_directory_id FROM organization_library WHERE id=1')
        .get() as any;
    return {
      ...state,
      inboxDirectoryId:
        row.inbox_directory_id &&
        resolveDirectory(db, row.inbox_directory_id) &&
        canAccessPath(p, resolveDirectory(db, row.inbox_directory_id)!.path)
          ? row.inbox_directory_id
          : null,
      limits: { ...organizationLimits },
    };
  }
  function list(p: Principal, input: DirectoryListInput = {}): DirectoryPage {
    const c = context(p);
    p = projected(p);
    const limit = input.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) fail(400, 'INVALID_LIMIT');
    const parent = input.parentId == null ? null : resolveDirectory(db, input.parentId);
    if (input.parentId != null && !parent) fail(404, 'DIRECTORY_NOT_FOUND');
    const visible = (path: string) =>
      canAccessPath(p, path) || p.allowedPrefixes.some((prefix) => prefix.startsWith(path + '/'));
    if (parent && !visible(parent.path)) fail(403, 'FORBIDDEN');
    const fingerprint = sha256(
      JSON.stringify([
        p.id,
        p.clientId,
        p.permissionPolicy,
        p.allowedPrefixes,
        (p as any).knowledgeAll,
        c.libraryId,
        c.bindingVersion,
        c.structureRevision,
        input.parentId ?? null,
        limit,
      ]),
    );
    let offset = 0;
    if (input.cursor) {
      const cursor = decodeCursor(config.secret, input.cursor);
      if (cursor.fingerprint !== fingerprint) fail(409, 'CURSOR_INVALIDATED');
      if (cursor.expires <= Date.now()) fail(410, 'CURSOR_EXPIRED');
      offset = cursor.offset;
      if (!Number.isSafeInteger(offset) || offset < 0) fail(400, 'INVALID_CURSOR');
    }
    const rows = (
      db
        .prepare(
          'SELECT id,path,parent_id,subtree_revision FROM organization_directories WHERE active=1 AND parent_id IS ? ORDER BY path,id',
        )
        .all(input.parentId ?? null) as any[]
    ).filter((row) => visible(row.path));
    const items = rows.slice(offset, offset + limit).map((row) => ({
      id: row.id,
      path: row.path,
      name: basename(row.path),
      parentId: row.parent_id,
      subtreeRevision: row.subtree_revision,
      writable: canAccessPath(p, row.path) && p.scopes.includes('knowledge:write'),
      organizable:
        canAccessPath(p, row.path) &&
        p.scopes.includes('knowledge:organize') &&
        !['90-Archive', '99-System'].includes(row.path),
    }));
    const output = (): DirectoryPage => ({
      libraryId: c.libraryId,
      structureRevision: c.structureRevision,
      items,
      ...(offset + items.length < rows.length
        ? {
            nextCursor: signCursor(config.secret, {
              fingerprint,
              offset: offset + items.length,
              expires: Date.now() + 15 * 60000,
            }),
          }
        : {}),
    });
    while (
      items.length &&
      (Buffer.byteLength(JSON.stringify(output())) > 28672 || !organizationResponseFits(output()))
    )
      items.pop();
    if (!items.length && offset < rows.length) fail(413, 'RESPONSE_TOO_LARGE');
    return output();
  }
  function rowFor(p: Principal, key: { operationId?: string; requestId?: string }) {
    p = projected(p);
    requireScope(p, 'knowledge:read');
    const row = (
      key.operationId
        ? db
            .prepare(
              'SELECT o.*,j.manifest,j.cleaned,j.expires_at,j.undo_id FROM operations o JOIN organization_jobs j ON j.id=o.id WHERE o.id=? AND o.principal=? AND o.client_id=?',
            )
            .get(key.operationId, p.id, p.clientId)
        : db
            .prepare(
              'SELECT o.*,j.manifest,j.cleaned,j.expires_at,j.undo_id FROM operations o JOIN organization_jobs j ON j.id=o.id WHERE o.request_id=? AND o.principal=? AND o.client_id=? ORDER BY o.created_at DESC LIMIT 1',
            )
            .get(key.requestId, p.id, p.clientId)
    ) as any;
    if (!row) fail(404, 'OPERATION_NOT_FOUND');
    return row;
  }
  function operation(
    p: Principal,
    key: { operationId?: string; requestId?: string },
  ): OrganizationOperation {
    const row = rowFor(p, key),
      result = row.result ? JSON.parse(row.result) : undefined;
    p = projected(p);
    if (result) {
      const m = JSON.parse(row.manifest) as OrganizationManifest;
      for (const o of m.objects) {
        const path =
          o.kind === 'file' && o.note
            ? (db.prepare('SELECT path FROM notes WHERE id=? AND active=1').get(o.id) as any)?.path
            : o.kind === 'directory'
              ? resolveDirectory(db, o.id)?.path
              : o.kind === 'file'
                ? (db.prepare('SELECT path FROM assets WHERE id=?').get(o.id) as any)?.path
                : o.from;
        if ((!path && !p.knowledgeAll) || (path && !canAccessPath(p, path))) fail(403, 'FORBIDDEN');
      }
      result.undoAvailable =
        !!result.undoAvailable && !row.cleaned && !row.undo_id && row.expires_at > Date.now();
    }
    return {
      operationId: row.id,
      requestId: row.request_id,
      kind: row.kind,
      status: row.status,
      ...(result ? { result } : {}),
      ...(row.error
        ? { error: { code: row.error, retryable: row.status === 'needs_reconciliation' } }
        : {}),
    };
  }
  function history(p: Principal, input: HistoryInput = {}): HistoryPage {
    p = projected(p);
    requireScope(p, 'knowledge:read');
    const limit = input.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) fail(400, 'INVALID_LIMIT');
    const fingerprint = sha256(
      JSON.stringify([
        p.id,
        p.clientId,
        p.permissionPolicy,
        p.allowedPrefixes,
        libraryIdentity(db),
      ]),
    );
    let offset = 0;
    if (input.cursor) {
      const c = decodeCursor(config.secret, input.cursor);
      if (c.fingerprint !== fingerprint || c.expires <= Date.now()) fail(409, 'CURSOR_INVALIDATED');
      offset = c.offset;
      if (!Number.isSafeInteger(offset) || offset < 0) fail(400, 'INVALID_CURSOR');
    }
    const rows = db
      .prepare(
        "SELECT id FROM operations WHERE principal=? AND client_id=? AND kind IN ('organization.organize','organization.undo') ORDER BY created_at DESC,id LIMIT ? OFFSET ?",
      )
      .all(p.id, p.clientId, limit + 1, offset) as any[];
    const items: OrganizationOperation[] = [];
    let consumed = 0;
    const output = (): HistoryPage => ({
      items,
      ...(consumed < rows.length
        ? {
            nextCursor: signCursor(config.secret, {
              fingerprint,
              offset: offset + consumed,
              expires: Date.now() + 15 * 60000,
            }),
          }
        : {}),
    });
    for (const row of rows.slice(0, limit)) {
      let item: OrganizationOperation;
      try {
        item = operation(p, { operationId: row.id });
      } catch (e) {
        if (!(e instanceof KnowledgeError && e.statusCode === 403)) throw e;
        consumed++;
        continue;
      }
      items.push(item);
      consumed++;
      if (
        Buffer.byteLength(JSON.stringify({ items })) > 27648 ||
        !organizationResponseFits(output())
      ) {
        items.pop();
        consumed--;
        break;
      }
    }
    if (!consumed && rows.length) fail(413, 'RESPONSE_TOO_LARGE');
    return output();
  }
  function setFailure(id: string, error: unknown) {
    const status = (db.prepare('SELECT status FROM organization_jobs WHERE id=?').get(id) as any)
      ?.status;
    const code =
      error instanceof KnowledgeError
        ? error.code
        : (error as any)?.code === 'ENOSPC'
          ? 'INSUFFICIENT_STORAGE'
          : 'ORGANIZATION_FAILED';
    const next =
      status === 'cancelled'
        ? 'cancelled'
        : ['committing', 'needs_reconciliation'].includes(status)
          ? 'needs_reconciliation'
          : 'failed';
    db.transaction(() => {
      db.prepare(
        'UPDATE organization_jobs SET status=?,error=?,finished_at=?,owner_pid=NULL,owner_start=NULL WHERE id=?',
      ).run(next, code, Date.now(), id);
      db.prepare('UPDATE operations SET status=?,error=?,updated_at=? WHERE id=?').run(
        next,
        code,
        Date.now(),
        id,
      );
    }).immediate();
    if (next === 'failed' || next === 'cancelled')
      rmSync(journalDirectory(config, id), { recursive: true, force: true });
  }
  function checkRunning(id: string, epoch: number) {
    const row = db
      .prepare('SELECT status,lease_epoch FROM organization_jobs WHERE id=?')
      .get(id) as any;
    if (!row || row.status !== 'running' || row.lease_epoch !== epoch) fail(409, 'TASK_CANCELLED');
  }
  function prepareUndo(p: Principal, originalId: string, id: string): OrganizationManifest {
    const original = rowFor(p, { operationId: originalId });
    if (
      original.kind === 'organization.undo' ||
      original.status !== 'succeeded' ||
      original.cleaned ||
      original.undo_id ||
      original.expires_at <= Date.now()
    )
      fail(409, 'UNDO_CONFLICT');
    const old = JSON.parse(original.manifest) as OrganizationManifest;
    try {
      if (outputInventory(config, old) !== old.outputInventory) fail(409, 'UNDO_CONFLICT');
    } catch {
      fail(409, 'UNDO_CONFLICT');
    }
    const state = syncDirectoryCatalog(config, db),
      binding = libraryIdentity(db)!;
    if (state.libraryId !== old.libraryId) fail(409, 'UNDO_CONFLICT');
    const objects: Change[] = [],
      permissions: OrganizationManifest['permissions'] = [];
    for (const o of old.objects) {
      if (o.kind === 'file') {
        if (!o.backup) fail(409, 'UNDO_CONFLICT');
        const source = join(config.knowledgeRoot, o.to),
          target = o.from;
        if (o.to !== target && existsSync(join(config.knowledgeRoot, target)))
          fail(409, 'UNDO_CONFLICT');
        const before = evidence(source);
        before.hash = o.afterHash;
        const backup = join(journalDirectory(config, old.operationId), o.backup);
        if (!existsSync(backup)) fail(409, 'UNDO_CONFLICT');
        objects.push({
          kind: 'file',
          id: o.id,
          note: o.note,
          from: o.to,
          to: target,
          before,
          afterHash: o.before.hash!,
          ...(o.note ? { afterContent: readFileSync(backup, 'utf8') } : { contentSource: backup }),
        } as any);
        permissions.push(
          { path: o.to, scope: 'knowledge:write' },
          { path: target, scope: 'knowledge:write' },
        );
      } else if (o.kind === 'directory') {
        const current = evidence(join(config.knowledgeRoot, o.to));
        if (!o.published || !sameIdentity(current, o.published)) fail(409, 'UNDO_CONFLICT');
        if (o.from) {
          if (existsSync(join(config.knowledgeRoot, o.from))) fail(409, 'UNDO_CONFLICT');
          objects.push({
            kind: 'directory',
            id: o.id,
            business: o.business,
            from: o.to,
            to: o.from,
            before: current,
          });
          permissions.push(
            { path: o.to, scope: 'knowledge:organize' },
            { path: dirname(o.from) === '.' ? '' : dirname(o.from), scope: 'knowledge:organize' },
          );
        } else {
          objects.push({ kind: 'remove_directory', id: o.id, from: o.to, before: current });
          permissions.push({ path: o.to, scope: 'knowledge:organize' });
        }
      }
    }
    checkPermissions(p, permissions);
    const inverseMoves = old.changes
      .filter((c) => c.from && c.type.startsWith('move_'))
      .map((c) => ({ from: c.to, to: c.from! }));
    let readBytes = 0;
    const coverage = (
      db.prepare('SELECT id,path FROM notes WHERE active=1 ORDER BY path').all() as any[]
    ).map((n) => {
      const b = readBody(config, n.path);
      readBytes += b.evidence.size;
      if (readBytes > organizationLimits.bodyBytes) fail(413, 'ORGANIZATION_LIMIT');
      const mapped = inverseMoves
        .filter((move) => n.path === move.from || n.path.startsWith(move.from + '/'))
        .sort((a, b) => b.from.length - a.from.length)[0];
      const destination = mapped ? mapped.to + n.path.slice(mapped.from.length) : n.path;
      const rewritten = rewriteLibraryReferences(
        b.content,
        n.path,
        destination,
        inverseMoves,
        n.path.endsWith('.excalidraw'),
      );
      if (rewritten.changed && !objects.some((o) => o.kind === 'file' && o.id === n.id))
        fail(409, 'UNDO_CONFLICT');
      return { path: n.path, id: n.id, hash: b.hash, evidence: b.evidence };
    });
    const m: OrganizationManifest = {
      version: 1,
      operationId: id,
      libraryId: state.libraryId,
      bindingVersion: binding.bindingVersion,
      structureRevision: state.structureRevision,
      graphRevision: sha256(JSON.stringify(coverage.map((c) => [c.id, c.path, c.hash]))),
      inventory: inventory(config),
      coverage,
      objects,
      permissions,
      undoOf: old.operationId,
      changes: old.changes.map((c) => ({
        type: 'undo_' + c.type,
        id: c.id,
        from: c.to,
        to: c.from || c.to,
      })),
    };
    const receipt = db.prepare('SELECT request_id,kind FROM operations WHERE id=?').get(id) as {
      request_id: string;
      kind: string;
    };
    assertOrganizationReceiptFits(m, receipt.request_id, receipt.kind);
    return m;
  }
  async function run(id: string) {
    const self = workspaceProcess();
    let epoch = 0;
    try {
      const job = db.prepare('SELECT * FROM organization_jobs WHERE id=?').get(id) as any;
      if (!job || job.status !== 'queued') return;
      const payload = JSON.parse(job.payload),
        p = live(payload.principal, callbacks.get(id));
      requireOrganization(p);
      const claim = db
        .prepare(
          "UPDATE organization_jobs SET status='running',owner_pid=?,owner_start=?,lease_epoch=lease_epoch+1 WHERE id=? AND status='queued'",
        )
        .run(self.pid, self.start, id);
      if (!claim.changes) return;
      epoch = (db.prepare('SELECT lease_epoch FROM organization_jobs WHERE id=?').get(id) as any)
        .lease_epoch;
      db.prepare("UPDATE operations SET status='running' WHERE id=?").run(id);
      // Preparation observes complete sources outside the exclusive gate. It yields before the final validation.
      notes.scan();
      const m = payload.undoOf
        ? prepareUndo(p, payload.undoOf, id)
        : prepareOrganization(config, db, p, payload.input, id);
      await new Promise<void>((resolve) => setImmediate(resolve));
      checkRunning(id, epoch);
      await workspaceExclusive(db, { kind: 'organization.commit', operationId: id }, async () => {
        checkRunning(id, epoch);
        const current = live(payload.principal, callbacks.get(id));
        revalidateManifest(config, db, current, m);
        stageOrganization(config, db, m);
        checkRunning(id, epoch);
        revalidateManifest(config, db, live(payload.principal, callbacks.get(id)), m);
        db.transaction(() => {
          db.prepare(
            "UPDATE organization_jobs SET status='committing',manifest=? WHERE id=? AND lease_epoch=?",
          ).run(JSON.stringify(m), id, epoch);
          db.prepare("UPDATE operations SET status='committing' WHERE id=?").run(id);
        }).immediate();
        commitOrganization(config, db, m);
      });
    } catch (error) {
      setFailure(id, error);
    } finally {
      callbacks.delete(id);
    }
  }
  function schedule(id: string, force = false) {
    if (!closing && (force || config.fileTasks?.embedded !== false))
      tail = tail.then(() => run(id));
  }
  async function submit(
    p: Principal,
    input: OrganizeInput,
    recheck?: () => Principal,
  ): Promise<OrganizationReply> {
    p = projected(p);
    requireOrganization(p);
    if (
      !input ||
      !Array.isArray(input.actions) ||
      input.actions.length < 1 ||
      input.actions.length > organizationLimits.actions ||
      Buffer.byteLength(JSON.stringify(input)) > 128 * 1024
    )
      fail(413, 'ORGANIZATION_LIMIT');
    assertOrganizationReadable(db);
    const op = workspaceWriteSync(db, { kind: 'organization.submit' }, () =>
      db
        .transaction(() => {
          const op = beginOperation(db, p, 'organization.organize', input.requestId, {
            libraryId: input.libraryId,
            expectedStructureRevision: input.expectedStructureRevision,
            actions: input.actions,
          });
          if (op.fresh) {
            db.prepare(
              'INSERT INTO organization_jobs(id,status,payload,created_at) VALUES(?,?,?,?)',
            ).run(op.operation.id, 'queued', JSON.stringify({ principal: p, input }), Date.now());
            db.prepare("UPDATE operations SET status='queued' WHERE id=?").run(op.operation.id);
          }
          return op;
        })
        .immediate(),
    );
    if (op.fresh) {
      if (recheck) callbacks.set(op.operation.id, recheck);
      schedule(op.operation.id);
    }
    return { kind: 'accepted', operation: operation(p, { operationId: op.operation.id }) };
  }
  async function undo(
    p: Principal,
    input: UndoOrganizationInput,
    recheck?: () => Principal,
  ): Promise<OrganizationReply> {
    p = projected(p);
    requireOrganization(p);
    rowFor(p, { operationId: input.operationId });
    assertOrganizationReadable(db);
    const op = workspaceWriteSync(db, { kind: 'organization.undo' }, () =>
      db
        .transaction(() => {
          const op = beginOperation(db, p, 'organization.undo', input.requestId, {
            operationId: input.operationId,
          });
          if (op.fresh) {
            db.prepare(
              'INSERT INTO organization_jobs(id,status,payload,created_at,undo_of) VALUES(?,?,?,?,?)',
            ).run(
              op.operation.id,
              'queued',
              JSON.stringify({ principal: p, undoOf: input.operationId }),
              Date.now(),
              input.operationId,
            );
            db.prepare("UPDATE operations SET status='queued' WHERE id=?").run(op.operation.id);
          }
          return op;
        })
        .immediate(),
    );
    if (op.fresh) {
      if (recheck) callbacks.set(op.operation.id, recheck);
      schedule(op.operation.id);
    }
    return { kind: 'accepted', operation: operation(p, { operationId: op.operation.id }) };
  }
  function cancel(p: Principal, input: { operationId: string }) {
    const row = rowFor(p, input);
    if (
      !['committing', 'needs_reconciliation', 'succeeded', 'failed', 'cancelled'].includes(
        row.status,
      )
    ) {
      db.transaction(() => {
        db.prepare(
          "UPDATE organization_jobs SET status='cancelled',error='TASK_CANCELLED' WHERE id=? AND status IN ('queued','running')",
        ).run(row.id);
        db.prepare(
          "UPDATE operations SET status='cancelled',error='TASK_CANCELLED' WHERE id=? AND status IN ('queued','running')",
        ).run(row.id);
      }).immediate();
    }
    return operation(p, input);
  }
  async function recover() {
    const pending = db
      .prepare(
        "SELECT * FROM organization_jobs WHERE status IN ('committing','needs_reconciliation') ORDER BY created_at,id",
      )
      .all() as any[];
    for (const row of pending) {
      if (row.owner_pid && row.owner_start && processIsAlive(row.owner_pid, row.owner_start))
        continue;
      await workspaceExclusive(
        db,
        { kind: 'organization.recover', operationId: row.id, recovery: true },
        async () => {
          try {
            if (!row.manifest) fail(409, 'ORGANIZATION_EVIDENCE_CONFLICT');
            const m = JSON.parse(row.manifest) as OrganizationManifest;
            const current = libraryIdentity(db);
            if (
              !current ||
              m.libraryId !== current.libraryId ||
              m.bindingVersion !== current.bindingVersion
            )
              fail(409, 'LIBRARY_BINDING_CHANGED');
            commitOrganization(config, db, m);
          } catch (e) {
            setFailure(row.id, e);
          }
        },
      );
    }
    for (const row of db
      .prepare("SELECT * FROM organization_jobs WHERE status='running'")
      .all() as any[]) {
      if (row.owner_pid && row.owner_start && processIsAlive(row.owner_pid, row.owner_start))
        continue;
      rmSync(journalDirectory(config, row.id), { recursive: true, force: true });
      db.prepare('DELETE FROM organization_objects WHERE operation_id=?').run(row.id);
      db.prepare(
        "UPDATE organization_jobs SET status='queued',manifest=NULL,lease_epoch=lease_epoch+1 WHERE id=?",
      ).run(row.id);
      db.prepare("UPDATE operations SET status='queued' WHERE id=?").run(row.id);
    }
    for (const row of db
      .prepare("SELECT id FROM organization_jobs WHERE status='queued' ORDER BY created_at,id")
      .all() as any[])
      schedule(row.id, true);
  }
  async function cleanup() {
    for (const row of db
      .prepare(
        "SELECT id FROM organization_jobs WHERE status='succeeded' AND cleaned=0 AND expires_at<=? AND NOT EXISTS(SELECT 1 FROM organization_jobs active WHERE active.undo_of=organization_jobs.id AND active.status IN ('queued','running','committing','needs_reconciliation'))",
      )
      .all(Date.now()) as any[]) {
      rmSync(journalDirectory(config, row.id), { recursive: true, force: true });
      db.prepare("UPDATE organization_jobs SET cleaned=1 WHERE id=? AND status='succeeded'").run(
        row.id,
      );
    }
  }
  async function drain() {
    await tail;
  }
  async function close() {
    closing = true;
    await tail;
  }
  return {
    context,
    list,
    submit,
    history,
    undo,
    operation,
    cancel,
    recover,
    cleanup,
    drain,
    close,
  };
}
