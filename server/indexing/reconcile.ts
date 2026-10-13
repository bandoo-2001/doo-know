import { lstatSync, realpathSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../../shared/contracts.js';
import type { AppDatabase } from '../db.js';
import { scanFiles, safePath } from '../files.js';
import { fail } from '../knowledge/errors.js';
import { hashFile, stableStat, sameFile } from '../knowledge/file-reader.js';
import { limits } from '../knowledge/limits.js';
import { enqueueSource } from '../knowledge/core.js';
import { underPrefix, requireScope } from '../agent/auth.js';
import type { Principal } from '../../shared/knowledge-contracts.js';
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
    for (const path of managed) {
      signal?.throwIfAborted();
      assertRoot(config, db);
      const existing = db.prepare('SELECT id FROM notes WHERE path=? AND active=1').get(path) as
        | { id: string }
        | undefined;
      const reserved = db
        .prepare(
          "SELECT note_id AS id FROM write_intents WHERE path=? AND kind='create' AND status='prepared' LIMIT 1",
        )
        .get(path) as { id: string } | undefined;
      const noteId = existing?.id || reserved?.id || randomUUID();
      if (!existing && !reserved) {
        db.prepare('INSERT INTO notes(id,path) VALUES(?,?)').run(noteId, path);
        added++;
      }
      if (conflicts.has(path)) {
        db.prepare(
          'INSERT INTO document_state(note_id,conflict) VALUES(?,1) ON CONFLICT(note_id) DO UPDATE SET conflict=1',
        ).run(noteId);
        db.prepare('UPDATE chunks SET active=0 WHERE note_id=?').run(noteId);
        conflicted++;
        continue;
      }
      let before: Awaited<ReturnType<typeof stableStat>>, file: string;
      try {
        file = safePath(config.knowledgeRoot, path, 'note');
        const s = lstatSync(file, { bigint: true });
        if (s.size > BigInt(limits.file)) {
          db.prepare(
            'INSERT INTO document_state(note_id,mtime_ns,size_bytes,content_hash,source_revision) VALUES(?,?,?,NULL,1) ON CONFLICT(note_id) DO UPDATE SET mtime_ns=excluded.mtime_ns,size_bytes=excluded.size_bytes,content_hash=NULL,source_revision=source_revision+1,text_indexed_hash=NULL,vector_indexed_hash=NULL',
          ).run(noteId, s.mtimeNs.toString(), Number(s.size));
          db.prepare('UPDATE chunks SET active=0 WHERE note_id=?').run(noteId);
          continue;
        }
        before = await stableStat(file);
      } catch {
        fail(503, 'SOURCE_UNAVAILABLE', '原文读取不可用', true);
      }
      const old = db.prepare('SELECT * FROM document_state WHERE note_id=?').get(noteId) as any;
      if (
        !fullHash &&
        old?.content_hash &&
        old.mtime_ns === before.mtimeNs.toString() &&
        old.size_bytes === Number(before.size) &&
        !old.conflict
      ) {
        db.prepare('UPDATE document_state SET last_checked_at=? WHERE note_id=?').run(
          new Date().toISOString(),
          noteId,
        );
        continue;
      }
      let hash: string;
      try {
        hash = await hashFile(file, signal);
        if (!sameFile(before, await stableStat(safePath(config.knowledgeRoot, path, 'note'))))
          fail(503, 'SOURCE_UNAVAILABLE');
      } catch {
        fail(503, 'SOURCE_UNAVAILABLE', '原文读取期间变化', true);
      }
      if (old?.content_hash !== hash) changed++;
      enqueueSource(db, config, noteId, hash, before.mtimeNs.toString(), Number(before.size));
      db.prepare('UPDATE document_state SET conflict=0 WHERE note_id=?').run(noteId);
    }
    assertRoot(config, db);
    db.transaction(() => {
      for (const row of db.prepare('SELECT id,path FROM notes WHERE active=1').all() as {
        id: string;
        path: string;
      }[]) {
        if (
          (!scopes || scopes.some((scope) => underPrefix(row.path, scope))) &&
          !live.has(row.path)
        ) {
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
    })();
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
    const filter=pathFilter({...p,allowedPrefixes:scopes},'n.path');
    const base=`FROM notes n LEFT JOIN document_state d ON d.note_id=n.id WHERE n.active=1 AND (${filter.sql})`;
    const notes=db.prepare(`SELECT n.id,n.path,d.* ${base} ORDER BY n.path LIMIT 10`).all(...filter.values) as any[];
    const counts=db.prepare(`SELECT j.status,count(*) n FROM index_jobs j JOIN notes n ON n.id=j.note_id WHERE n.active=1 AND j.status IN ('pending','leased','ready_to_publish','retry_wait','failed') AND (${filter.sql}) GROUP BY j.status`).all(...filter.values) as {status:string;n:number}[];
    const count=(statuses:string[])=>counts.filter(row=>statuses.includes(row.status)).reduce((total,row)=>total+row.n,0);
    const conflicts=(db.prepare(`SELECT coalesce(sum(d.conflict),0) n ${base}`).get(...filter.values) as any).n;
    const document=input.noteId?db.prepare(`SELECT n.id,n.path,d.* ${base} AND n.id=?`).get(...filter.values,input.noteId) as any:undefined;
    if(input.noteId&&!document)fail(404,'NOT_FOUND');
    const summary=(n:any)=>({noteId:n.id,relativePath:n.path,sourceHash:n.content_hash||null,sourceRevision:n.source_revision||0,textIndexedHash:n.text_indexed_hash||null,vectorIndexedHash:n.vector_indexed_hash||null,conflict:!!n.conflict});
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
      pending:count(['pending','leased','ready_to_publish']),
      retrying:count(['retry_wait']),
      failed:count(['failed']),
      activeSpaceId: config.embeddingSpaceId || null,
      generation: getMeta('active_generation'),
      error: getMeta('source_error') || null,
      documents: notes.map(summary),
      ...(document?{document:summary(document)}:{}),
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
