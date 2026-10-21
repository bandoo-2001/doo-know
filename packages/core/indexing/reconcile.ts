import { lstatSync, realpathSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AppConfig } from '../../../shared/contracts.js';
import type { AppDatabase } from '../db.js';
import { scanFiles, safePath, isMissingSource } from '../files.js';
import { fail } from '../knowledge/errors.js';
import { hashFile, stableStat, sameFile } from '../knowledge/file-reader.js';
import { limits } from '../knowledge/limits.js';
import { enqueueSource } from '../knowledge/core.js';
import { underPrefix, requireScope } from '../agent/auth.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import { gitState } from './git-state.js';
import { pathFilter } from './text.js';
import {
  beginOperation,
  completeOperation,
  existingResult,
  sha256,
} from '../knowledge/operations.js';
export function assertRoot(config: AppConfig, db: AppDatabase) {
  try {
    const s = lstatSync(config.knowledgeRoot, { bigint: true });
    if (!s.isDirectory() || s.isSymbolicLink()) throw new Error();
    readdirSync(config.knowledgeRoot);
    const identity = JSON.stringify({
        path: realpathSync(config.knowledgeRoot),
        dev: String(s.dev),
        ino: String(s.ino),
      }),
      stored = db.prepare("SELECT value FROM index_meta WHERE key='root_identity'").get() as
        | { value: string }
        | undefined;
    if (stored && stored.value !== identity) throw new Error();
    if (!stored) db.prepare("INSERT INTO index_meta VALUES('root_identity',?)").run(identity);
  } catch {
    fail(503, 'SOURCE_UNAVAILABLE', '原文目录不可用', true);
  }
}
export function scopeFor(p: Principal, scope?: string) {
  requireScope(p, 'knowledge:index');
  if (
    scope != null &&
    (typeof scope !== 'string' || !p.allowedPrefixes.some((prefix) => underPrefix(scope, prefix)))
  )
    fail(403, 'FORBIDDEN');
  return scope ? [scope] : p.allowedPrefixes;
}
export const scopeKey = (scopes?: string[]) =>
  scopes ? 'scope:' + sha256(JSON.stringify([...scopes].sort())) : 'root';
export function reconcileService(config: AppConfig, db: AppDatabase) {
  let tail = Promise.resolve();
  const setMeta = (key: string, value: unknown) =>
    db
      .prepare(
        'INSERT INTO index_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, typeof value === 'string' ? value : JSON.stringify(value));
  const getMeta = (key: string) =>
    ((db.prepare('SELECT value FROM index_meta WHERE key=?').get(key) as any)?.value || null) as
      | string
      | null;
  async function perform(scopes?: string[], fullHash = true, signal?: AbortSignal) {
    assertRoot(config, db);
    let files: ReturnType<typeof scanFiles>;
    try {
      files = scanFiles(config.knowledgeRoot);
    } catch {
      fail(503, 'SOURCE_UNAVAILABLE', '原文目录不可用', true);
    }
    const managed = files.notes.filter(
        (path) => !scopes || scopes.some((scope) => underPrefix(path, scope)),
      ),
      live = new Set(managed),
      gitInfo = await gitState(config.knowledgeRoot),
      conflicts = new Set(gitInfo.conflicts);
    let added = 0,
      changed = 0,
      removed = 0,
      conflicted = 0;
    function observe(path: string) {
      assertRoot(config, db);
      try {
        const file = safePath(config.knowledgeRoot, path, 'note');
        return { file, stat: lstatSync(file, { bigint: true }) };
      } catch (error) {
        if (isMissingSource(error)) {
          assertRoot(config, db);
          return;
        }
        fail(503, 'SOURCE_UNAVAILABLE', '原文读取不可用', true);
      }
    }
    const protectedPath = (path: string) => !!db
          .prepare(
            "SELECT 1 FROM write_intents WHERE path=? AND status IN ('prepared','conflicted') AND (kind IN ('restore','move') OR (kind='create' AND status='conflicted'))",
          )
          .get(path);
    function identity(path: string) {
      return (db.prepare('SELECT id FROM notes WHERE path=? AND active=1').get(path) || db
        .prepare("SELECT note_id AS id FROM write_intents WHERE path=? AND kind='create' AND status='prepared' LIMIT 1")
        .get(path)) as { id: string } | undefined;
    }
    // No async work inside this transaction. Re-read both source and identity
    // after Git/stat/hash waits, before exposing any new note or source state.
    const publish = db.transaction((path: string, checked: Awaited<ReturnType<typeof stableStat>>,
      write: (noteId: string) => void, cache?: { id: string; hash: string }) => {
      const current = observe(path);
      if (!current) { live.delete(path); return 'missing' as const; }
      if (!sameFile(checked, current.stat)) fail(503, 'SOURCE_UNAVAILABLE', '原文读取期间变化', true);
      if (protectedPath(path)) { conflicted++; return 'conflict' as const; }
      const found = identity(path);
      if (cache) {
        if (found?.id !== cache.id) return 'hash' as const;
        const latest = db.prepare('SELECT * FROM document_state WHERE note_id=?').get(found.id) as any;
        if (!latest?.active || latest.conflict || latest.content_hash !== cache.hash ||
            latest.mtime_ns !== checked.mtimeNs.toString() || latest.size_bytes !== Number(checked.size))
          return 'hash' as const;
      }
      const noteId = found?.id || randomUUID();
      if (!found) {
        db.prepare('INSERT INTO notes(id,path) VALUES(?,?)').run(noteId, path);
        added++;
      }
      write(noteId);
      return 'published' as const;
    });
    function removedDuringRead(path: string, error: unknown) {
      if (!isMissingSource(error) || observe(path)) return false;
      live.delete(path);
      return true;
    }
    for (const path of managed) {
      signal?.throwIfAborted();
      const observed = observe(path);
      if (!observed) { live.delete(path); continue; }
      if (protectedPath(path)) { conflicted++; continue; }
      if (conflicts.has(path)) {
        publish.immediate(path, observed.stat, noteId => {
          db.prepare(
            'INSERT INTO document_state(note_id,conflict) VALUES(?,1) ON CONFLICT(note_id) DO UPDATE SET conflict=1',
          ).run(noteId);
          db.prepare('UPDATE chunks SET active=0 WHERE note_id=?').run(noteId);
          conflicted++;
        });
        continue;
      }
      if (observed.stat.size > BigInt(limits.file)) {
        publish.immediate(path, observed.stat, noteId => {
          db.prepare(
            'INSERT INTO document_state(note_id,mtime_ns,size_bytes,content_hash,source_revision) VALUES(?,?,?,NULL,1) ON CONFLICT(note_id) DO UPDATE SET mtime_ns=excluded.mtime_ns,size_bytes=excluded.size_bytes,content_hash=NULL,source_revision=source_revision+1,text_indexed_hash=NULL,vector_indexed_hash=NULL',
          ).run(noteId, observed.stat.mtimeNs.toString(), Number(observed.stat.size));
          db.prepare('UPDATE chunks SET active=0 WHERE note_id=?').run(noteId);
        });
        continue;
      }
      let before: Awaited<ReturnType<typeof stableStat>>;
      try {
        before = await stableStat(observed.file);
      } catch (error) {
        if (removedDuringRead(path, error)) continue;
        fail(503, 'SOURCE_UNAVAILABLE', '原文读取不可用', true);
      }
      const hint = identity(path);
      const old = hint ? db.prepare('SELECT * FROM document_state WHERE note_id=?').get(hint.id) as any : undefined;
      if (!fullHash && old?.content_hash && old.mtime_ns === before.mtimeNs.toString() &&
          old.size_bytes === Number(before.size) && old.active && !old.conflict && hint) {
        const outcome = publish.immediate(path, before, noteId => {
          db.prepare('UPDATE document_state SET last_checked_at=? WHERE note_id=?').run(new Date().toISOString(), noteId);
        }, { id: hint.id, hash: old.content_hash });
        if (outcome !== 'hash') continue;
      }
      let hash: string;
      try {
        hash = await hashFile(observed.file, signal);
        if (!sameFile(before, await stableStat(safePath(config.knowledgeRoot, path, 'note'))))
          fail(503, 'SOURCE_UNAVAILABLE');
      } catch (error) {
        if (removedDuringRead(path, error)) continue;
        fail(503, 'SOURCE_UNAVAILABLE', '原文读取期间变化', true);
      }
      publish.immediate(path, before, noteId => {
        const latest = db.prepare('SELECT * FROM document_state WHERE note_id=?').get(noteId) as any;
        if (latest?.content_hash !== hash || !latest?.active || latest?.conflict) changed++;
        enqueueSource(db, config, noteId, hash, before.mtimeNs.toString(), Number(before.size));
        db.prepare('UPDATE document_state SET conflict=0 WHERE note_id=?').run(noteId);
      });
    }
    assertRoot(config, db);
    db.transaction(() => {
      for (const row of db.prepare('SELECT id,path FROM notes WHERE active=1').all() as {
        id: string;
        path: string;
      }[]) {
        if (
          !db
            .prepare(
              "SELECT 1 FROM write_intents WHERE note_id=? AND kind='move' AND status IN ('prepared','conflicted')",
            )
            .get(row.id) &&
          (!scopes || scopes.some((scope) => underPrefix(row.path, scope))) &&
          !live.has(row.path)
        ) {
          // The scan predates asynchronous Git/hash reads. A writer may have
          // created or restored this file while those reads were in progress.
          try {
            if (lstatSync(join(config.knowledgeRoot, row.path)).isFile()) {
              safePath(config.knowledgeRoot, row.path, 'note');
              continue;
            }
          } catch (e) {
            if (!['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code || ''))
              fail(503, 'SOURCE_UNAVAILABLE', '原文读取不可用', true);
          }
          db.prepare('UPDATE notes SET active=0 WHERE id=?').run(row.id);
          db.prepare('UPDATE shares SET enabled=0 WHERE note_id=?').run(row.id);
          db.prepare(
            'UPDATE document_state SET active=0,source_revision=source_revision+1 WHERE note_id=?',
          ).run(row.id);
          db.prepare('UPDATE chunks SET active=0 WHERE note_id=?').run(row.id);
          db.prepare(
            "UPDATE index_jobs SET status='superseded' WHERE note_id=? AND status<>'done'",
          ).run(row.id);
          removed++;
        }
      }
    }).immediate();
    const at = new Date().toISOString(),
      key = scopeKey(scopes),
      prior = getMeta(key),
      previous = prior ? JSON.parse(prior) : {};
    setMeta(key, {
      lastReconciledAt: at,
      lastFullHashAt: fullHash ? at : previous.lastFullHashAt || null,
    });
    setMeta('known_head', gitInfo.head || '');
    setMeta('source_error', '');
    return { added, changed, removed, conflicted, complete: true };
  }
  async function reconcile(scopes?: string[], fullHash = true, signal?: AbortSignal) {
    let result: any;
    const run = tail.then(async () => {
      try {
        result = await perform(scopes, fullHash, signal);
      } catch (e) {
        setMeta('source_error', 'SOURCE_UNAVAILABLE');
        throw e;
      }
    });
    tail = run.catch(() => {});
    await run;
    return result as {
      added: number;
      changed: number;
      removed: number;
      conflicted: number;
      complete: boolean;
    };
  }
  async function refresh(p: Principal, input: { scope?: string; requestId: string }) {
    const scopes = scopeFor(p, input?.scope),
      op = beginOperation(db, p, 'refresh_index', input.requestId, { scopes });
    if (!op.fresh) return existingResult(op.operation);
    try {
      const result = await reconcile(scopes, true, AbortSignal.timeout(10000)),
        reply = { jobId: op.operation.id, ...result, indexState: 'pending' };
      completeOperation(db, op.operation.id, reply);
      return reply;
    } catch (e) {
      db.prepare("UPDATE operations SET status='failed',error='SOURCE_UNAVAILABLE' WHERE id=?").run(
        op.operation.id,
      );
      throw e;
    }
  }
  function status(p: Principal, input: { scope?: string; jobId?: string; noteId?: string } = {}) {
    const scopes = scopeFor(p, input.scope);
    if (
      input.jobId &&
      !db
        .prepare('SELECT id FROM operations WHERE id=? AND principal=? AND client_id=?')
        .get(input.jobId, p.id, p.clientId)
    )
      fail(404, 'OPERATION_NOT_FOUND');
    const filter = pathFilter({ ...p, allowedPrefixes: scopes }, 'n.path');
    const base = `FROM notes n LEFT JOIN document_state d ON d.note_id=n.id WHERE n.active=1 AND (${filter.sql})`;
    const notes = db
      .prepare(`SELECT n.id,n.path,d.* ${base} ORDER BY n.path LIMIT 10`)
      .all(...filter.values) as any[];
    const counts = db
      .prepare(
        `SELECT j.status,count(*) n FROM index_jobs j JOIN notes n ON n.id=j.note_id WHERE n.active=1 AND j.status IN ('pending','leased','ready_to_publish','retry_wait','failed') AND (${filter.sql}) GROUP BY j.status`,
      )
      .all(...filter.values) as { status: string; n: number }[];
    const count = (statuses: string[]) =>
      counts
        .filter((row) => statuses.includes(row.status))
        .reduce((total, row) => total + row.n, 0);
    const conflicts = (
      db.prepare(`SELECT coalesce(sum(d.conflict),0) n ${base}`).get(...filter.values) as any
    ).n;
    const document = input.noteId
      ? (db
          .prepare(`SELECT n.id,n.path,d.* ${base} AND n.id=?`)
          .get(...filter.values, input.noteId) as any)
      : undefined;
    if (input.noteId && !document) fail(404, 'NOT_FOUND');
    const summary = (n: any) => ({
      noteId: n.id,
      relativePath: n.path,
      sourceHash: n.content_hash || null,
      sourceRevision: n.source_revision || 0,
      textIndexedHash: n.text_indexed_hash || null,
      vectorIndexedHash: n.vector_indexed_hash || null,
      conflict: !!n.conflict,
    });
    const last = getMeta(scopeKey(scopes)) || getMeta('root'),
      meta = last ? JSON.parse(last) : {};
    return {
      lastReconciledAt: meta.lastReconciledAt || null,
      lastFullHashAt: meta.lastFullHashAt || null,
      knownHead: getMeta('known_head') || null,
      sync: db
        .prepare(
          "SELECT id,status FROM sync_runs WHERE status IN ('running','needs_reconciliation') ORDER BY started_at DESC LIMIT 1",
        )
        .get() || { status: 'idle' },
      conflicts,
      pending: count(['pending', 'leased', 'ready_to_publish']),
      retrying: count(['retry_wait']),
      failed: count(['failed']),
      activeSpaceId: config.embeddingSpaceId || null,
      generation: getMeta('active_generation'),
      error: getMeta('source_error') || null,
      documents: notes.map(summary),
      ...(document ? { document: summary(document) } : {}),
    };
  }
  return {
    reconcile,
    refresh,
    status,
    assertRoot: () => assertRoot(config, db),
    close: async () => tail,
  };
}
