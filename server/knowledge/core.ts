import { randomUUID } from 'node:crypto';
import {
  readFileSync,
  writeFileSync,
  renameSync,
  linkSync,
  unlinkSync,
  mkdirSync,
  openSync,
  closeSync,
  fsyncSync,
  statSync,
  existsSync,
  lstatSync,
} from 'node:fs';
import { join, dirname, basename } from 'node:path';
import type { AppConfig } from '../../shared/contracts.js';
import type { Principal, RecoveryReport } from '../../shared/knowledge-contracts.js';
import type { AppDatabase } from '../db.js';
import { safePath, validName, readDocument } from '../files.js';
import { authorizePath } from '../agent/auth.js';
import { fail } from './errors.js';
import {
  beginOperation,
  existingResult,
  completeOperation,
  sha256,
  releaseSnapshotRef,
} from './operations.js';
import { observeSource } from '../indexing/state.js';
import { hashFile } from './file-reader.js';
export const webPrincipal: Principal = {
  id: 'web-owner',
  clientId: 'browser',
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:index'],
  allowedPrefixes: [
    'README.md',
    '00-Inbox',
    '10-Projects',
    '20-Areas',
    '30-Knowledge',
    '40-Resources',
    '50-Journal',
    '90-Archive',
    '99-System',
  ],
};
type Intent = {
  id: string;
  note_id: string;
  path: string;
  kind: string;
  original_hash: string | null;
  original_mtime: string | null;
  target_hash: string | null;
  temp_path: string | null;
  revision_id: string | null;
  history_file: string | null;
  status: string;
};
export function assertWritable(db: AppDatabase, noteId?: string) {
  if (
    (db.prepare('SELECT active FROM maintenance WHERE id=1').get() as any)?.active ||
    db.prepare("SELECT 1 FROM sync_runs WHERE status IN ('running','needs_reconciliation')").get()
  )
    fail(503, 'SYNC_IN_PROGRESS', '工作区维护中', true);
  if (
    noteId &&
    db.prepare("SELECT 1 FROM sqlite_master WHERE name='note_write_leases'").get() &&
    db
      .prepare('SELECT 1 FROM note_write_leases WHERE note_id=? AND lease_until>?')
      .get(noteId, Date.now())
  )
    fail(409, 'OPERATION_IN_PROGRESS');
}
function durableFile(file: string, content: string, mode = 0o600) {
  const fd = openSync(file, 'wx', mode);
  try {
    writeFileSync(fd, content, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function fsyncDirectory(path: string) {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function enqueueSource(
  db: AppDatabase,
  config: AppConfig,
  noteId: string,
  hash: string,
  mtime: string,
  size: number,
) {
  const v = observeSource(db, noteId, hash, mtime, size);
  for (const target of ['text', ...(config.embeddingSpaceId ? ['vector'] : [])]) {
    db.prepare(
      "UPDATE index_jobs SET status='superseded' WHERE note_id=? AND target=? AND source_revision<>? AND status NOT IN ('done','superseded')",
    ).run(noteId, target, v.sourceRevision);
    db.prepare(
      'INSERT OR IGNORE INTO index_jobs(id,note_id,source_revision,source_hash,target,space_id) VALUES(?,?,?,?,?,?)',
    ).run(
      randomUUID(),
      noteId,
      v.sourceRevision,
      hash,
      target,
      target === 'vector' ? config.embeddingSpaceId : '',
    );
  }
  return v;
}
export function mutationCore(config: AppConfig, db: AppDatabase) {
  function row(id: string, deleted = false) {
    const n = db.prepare('SELECT * FROM notes WHERE id=?').get(id) as any;
    if (!n || (!deleted && !n.active)) fail(404, 'NOT_FOUND');
    return n as { id: string; path: string; active: number; trash_path: string | null };
  }
  function record(intent: Intent, content?: string) {
    return db.transaction(() => {
      if (intent.kind === 'archive') {
        db.prepare('UPDATE notes SET active=0,trash_path=? WHERE id=?').run(
          basename(intent.path),
          intent.note_id,
        );
        db.prepare('UPDATE shares SET enabled=0 WHERE note_id=?').run(intent.note_id);
        db.prepare('UPDATE document_state SET active=0 WHERE note_id=?').run(intent.note_id);
        db.prepare('UPDATE chunks SET active=0 WHERE note_id=?').run(intent.note_id);
        db.prepare(
          "UPDATE index_jobs SET status='superseded' WHERE note_id=? AND status<>'done'",
        ).run(intent.note_id);
        const result = {
          id: intent.note_id,
          relativePath: intent.path,
          archived: true,
          indexState: 'removed',
        };
        completeOperation(db, intent.id, result);
        db.prepare("UPDATE write_intents SET status='recorded' WHERE id=?").run(intent.id);
        return result;
      }
      const file = safePath(config.knowledgeRoot, intent.path, 'note'),
        s = statSync(file, { bigint: true });
      if (intent.revision_id)
        db.prepare(
          'INSERT OR IGNORE INTO revisions(id,note_id,file,created_at,modified_at) VALUES(?,?,?,?,?)',
        ).run(
          intent.revision_id,
          intent.note_id,
          intent.history_file,
          new Date().toISOString(),
          intent.original_mtime,
        );
      db.prepare('UPDATE notes SET active=1 WHERE id=?').run(intent.note_id);
      enqueueSource(
        db,
        config,
        intent.note_id,
        intent.target_hash!,
        s.mtimeNs.toString(),
        Number(s.size),
      );
      db.prepare('UPDATE document_state SET longest_line_bytes=NULL WHERE note_id=?').run(
        intent.note_id,
      );
      if (content !== undefined) {
        let longest = 0;
        for (const line of content.split('\n'))
          longest = Math.max(longest, Buffer.byteLength(line));
        const title = [...(content.match(/^#\s+(.+)$/m)?.[1] || basename(intent.path, '.md'))]
          .slice(0, 256)
          .join('');
        db.prepare('UPDATE document_state SET longest_line_bytes=?,title=? WHERE note_id=?').run(
          longest,
          title,
          intent.note_id,
        );
      }
      const result = {
        id: intent.note_id,
        relativePath: intent.path,
        modifiedAt: s.mtimeNs.toString(),
        contentHash: intent.target_hash,
        sizeBytes: Number(s.size),
        indexState: 'pending',
      };
      completeOperation(db, intent.id, result);
      db.prepare("UPDATE write_intents SET status='recorded' WHERE id=?").run(intent.id);
      return result;
    })();
  }
  function create(
    p: Principal,
    directory: string,
    fileName: string,
    content: string,
    requestId: string,
  ) {
    if (typeof content !== 'string' || Buffer.byteLength(content) > 1024 * 1024)
      fail(413, 'REQUEST_TOO_LARGE');
    if (!validName(fileName) || !fileName.toLowerCase().endsWith('.md')) fail(400, 'INVALID_INPUT');
    const path = `${directory}/${fileName}`;
    authorizePath(p, path, 'knowledge:write');
    assertWritable(db);
    const op = beginOperation(db, p, 'create', requestId, { directory, fileName, content });
    if (!op.fresh) return existingResult(op.operation);
    safePath(config.knowledgeRoot, directory, 'folder');
    const file = safePath(config.knowledgeRoot, path, 'note', true);
    if (existsSync(file)) fail(409, 'NAME_CONFLICT');
    const noteId = randomUUID(),
      temp = join(dirname(file), `.doo-${op.operation.id}.tmp`);
    durableFile(temp, content);
    db.transaction(() => {
      db.prepare('INSERT INTO notes(id,path,active) VALUES(?,?,0)').run(noteId, path);
      db.prepare(
        'INSERT INTO write_intents(id,note_id,path,kind,target_hash,temp_path) VALUES(?,?,?,?,?,?)',
      ).run(op.operation.id, noteId, path, 'create', sha256(content), temp);
    })();
    try {
      linkSync(temp, file);
      unlinkSync(temp);
      fsyncDirectory(dirname(file));
      return record(
        db.prepare('SELECT * FROM write_intents WHERE id=?').get(op.operation.id) as Intent,
        content,
      );
    } catch (e) {
      throw e;
    }
  }
  function update(p: Principal, id: string, content: string, expected: string, requestId: string) {
    const n = row(id);
    authorizePath(p, n.path, 'knowledge:write');
    assertWritable(db, id);
    if (typeof content !== 'string' || Buffer.byteLength(content) > 1024 * 1024)
      fail(413, 'REQUEST_TOO_LARGE');
    if (typeof expected !== 'string' || !/^\d+$/.test(expected)) fail(400, 'INVALID_VERSION');
    const op = beginOperation(db, p, 'update', requestId, {
      id,
      content,
      expectedModifiedAt: expected,
    });
    if (!op.fresh) return existingResult(op.operation);
    const file = safePath(config.knowledgeRoot, n.path, 'note'),
      s = statSync(file, { bigint: true });
    if (s.size > 1024n * 1024n) fail(409, 'LARGE_FILE_MODE_REQUIRED');
    const current = readDocument(config.knowledgeRoot, n.path);
    if (current.modifiedAt !== expected)
      fail(409, 'VERSION_CONFLICT', '原文件已更新', false, {
        currentModifiedAt: current.modifiedAt,
      });
    if (current.content.split('\n').some((line) => Buffer.byteLength(line) > 32768))
      fail(409, 'LARGE_FILE_MODE_REQUIRED');
    const temp = join(dirname(file), `.doo-${op.operation.id}.tmp`),
      historyFile = `${op.operation.id}.md`;
    mkdirSync(join(config.dataRoot, 'history'), { recursive: true, mode: 0o700 });
    durableFile(join(config.dataRoot, 'history', historyFile), current.content);
    durableFile(temp, content, Number(s.mode) & 0o777);
    db.prepare(
      'INSERT INTO write_intents(id,note_id,path,kind,original_hash,original_mtime,target_hash,temp_path,revision_id,history_file) VALUES(?,?,?,?,?,?,?,?,?,?)',
    ).run(
      op.operation.id,
      id,
      n.path,
      'update',
      sha256(current.content),
      expected,
      sha256(content),
      temp,
      op.operation.id,
      historyFile,
    );
    const latest = readDocument(config.knowledgeRoot, n.path);
    if (latest.modifiedAt !== expected || sha256(latest.content) !== sha256(current.content))
      fail(409, 'VERSION_CONFLICT', '原文件再次更新', false, {
        currentModifiedAt: latest.modifiedAt,
      });
    renameSync(temp, file);
    fsyncDirectory(dirname(file));
    return record(
      db.prepare('SELECT * FROM write_intents WHERE id=?').get(op.operation.id) as Intent,
      content,
    );
  }
  function archive(p: Principal, id: string, expected: string, requestId: string) {
    const n = row(id, true);
    authorizePath(p, n.path, 'knowledge:write');
    assertWritable(db, id);
    const op = beginOperation(db, p, 'archive', requestId, { id, expectedModifiedAt: expected });
    if (!op.fresh) return existingResult(op.operation);
    if (!n.active) fail(404, 'NOT_FOUND');
    const file = safePath(config.knowledgeRoot, n.path, 'note'),
      s = statSync(file, { bigint: true });
    if (s.mtimeNs.toString() !== expected) fail(409, 'VERSION_CONFLICT');
    const archive = join(config.knowledgeRoot, '90-Archive');
    mkdirSync(archive, { recursive: true, mode: 0o700 });
    safePath(config.knowledgeRoot, '90-Archive', 'folder');
    let destination = archive;
    for (const part of ['.trash', id]) {
      destination = join(destination, part);
      mkdirSync(destination, { recursive: true, mode: 0o700 });
      const st = lstatSync(destination);
      if (!st.isDirectory() || st.isSymbolicLink()) fail(400, 'INVALID_PATH');
    }
    destination = join(destination, basename(n.path));
    if (existsSync(destination)) fail(409, 'TRASH_CONFLICT');
    db.prepare(
      'INSERT INTO write_intents(id,note_id,path,kind,original_mtime,temp_path) VALUES(?,?,?,?,?,?)',
    ).run(op.operation.id, id, n.path, 'archive', expected, destination);
    if (statSync(file, { bigint: true }).mtimeNs.toString() !== expected)
      fail(409, 'VERSION_CONFLICT');
    renameSync(file, destination);
    fsyncDirectory(dirname(file));
    fsyncDirectory(dirname(destination));
    return record(
      db.prepare('SELECT * FROM write_intents WHERE id=?').get(op.operation.id) as Intent,
    );
  }
  async function recover(): Promise<RecoveryReport> {
    const report = { recovered: 0, unapplied: 0, conflicted: 0 };
    for (const intent of db
      .prepare("SELECT * FROM write_intents WHERE status='prepared'")
      .all() as Intent[]) {
      try {
        if (intent.kind === 'archive') {
          if (
            intent.temp_path &&
            existsSync(intent.temp_path) &&
            !existsSync(join(config.knowledgeRoot, intent.path))
          ) {
            record(intent);
            report.recovered++;
            continue;
          }
        } else {
          const file = join(config.knowledgeRoot, intent.path),
            hash = existsSync(file)
              ? await hashFile(safePath(config.knowledgeRoot, intent.path, 'note'))
              : null;
          if (hash === intent.target_hash) {
            const result = record(intent) as any;
            const job = db
              .prepare('SELECT payload,snapshot_id FROM file_operations WHERE id=?')
              .get(intent.id) as any;
            if (job) {
              result.editCount = JSON.parse(job.payload)?.input?.edits?.length || 0;
              db.prepare('UPDATE operations SET result=? WHERE id=?').run(
                JSON.stringify(result),
                intent.id,
              );
              db.prepare("UPDATE file_operations SET status='succeeded' WHERE id=?").run(intent.id);
              releaseSnapshotRef(db, intent.id);
            }
            report.recovered++;
            continue;
          }
          if (hash !== intent.original_hash) {
            db.prepare(
              "UPDATE operations SET status='needs_reconciliation',error='EXTERNAL_CHANGE' WHERE id=?",
            ).run(intent.id);
            db.prepare("UPDATE write_intents SET status='conflicted' WHERE id=?").run(intent.id);
            report.conflicted++;
            continue;
          }
        }
        db.prepare(
          "UPDATE operations SET status='failed',error='OPERATION_UNAPPLIED' WHERE id=?",
        ).run(intent.id);
        db.prepare("UPDATE write_intents SET status='failed' WHERE id=?").run(intent.id);
        report.unapplied++;
      } catch {
        report.conflicted++;
      }
    }
    return report;
  }
  return { create, update, archive, recover, record };
}
