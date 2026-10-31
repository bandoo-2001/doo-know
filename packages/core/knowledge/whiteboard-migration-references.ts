import {
  recordMigrationNativeProof,
  type MigrationNativeRewrite,
} from './whiteboard-migration-native.js';
import { encodePortablePathSegment, renderPortableImage } from '../../../shared/portable-figure.js';
import { posix } from 'node:path';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import { markdownDestinationSpans } from '../../../shared/markdown-destinations.js';
import { whiteboardReference } from '../../../shared/whiteboard.js';
import type { AppDatabase } from '../db.js';
import type { NoteService } from '../notes.js';
import { authorizePath } from '../agent/auth.js';
import { localReference, markdown } from '../render.js';
import { sha256, type OperationRow } from './operations.js';
import { fail } from './errors.js';
import type { MigrationRow } from './diagram-migration-journal.js';
import type { WhiteboardMigrationPreflight } from '../../../shared/whiteboard-migration.js';
type ReferenceRecord = {
  noteId: string;
  status: string;
  code?: string;
  before?: string;
  after?: string;
  afterHash?: string;
  baseline?: { path: string; hash: string; modifiedAt: string; rewriteHash: string };
};
/** Persist each rewrite's exact before/after bytes before invoking the ordinary versioned writer. */
export function rewriteMigrationInbound(
  db: AppDatabase,
  notes: NoteService,
  p: Principal,
  r: MigrationRow,
  update: (id: string, content: string, version: string, requestId: string) => unknown,
  stageOnly = false,
) {
  const fixed = JSON.parse(r.plan) as WhiteboardMigrationPreflight & {
      nativeRewrites?: MigrationNativeRewrite[];
    },
    prepared = JSON.parse(r.prepared!);
  const records = JSON.parse(r.references_json) as ReferenceRecord[];
  function persist(value: ReferenceRecord) {
    const index = records.findIndex((x) => x.noteId === value.noteId);
    if (index >= 0) records[index] = value;
    else records.push(value);
    db.prepare('UPDATE whiteboard_migrations SET references_json=? WHERE id=?').run(
      JSON.stringify(records),
      r.id,
    );
  }
  for (const entry of fixed.inbound) {
    const prior = records.find((x) => x.noteId === entry.noteId);
    if (prior?.status === 'rewritten') continue;
    let value: ReferenceRecord = { ...prior, noteId: entry.noteId, status: 'pending' };
    try {
      authorizePath(p, notes.row(entry.noteId).path, 'knowledge:write');
      const doc = notes.getNoteSnapshot(entry.noteId).note;
      const requestId = 'migration-ref-' + r.id + '-' + entry.noteId;
      const operation = db
        .prepare(
          "SELECT * FROM operations WHERE principal=? AND client_id=? AND kind='update' AND request_id=?",
        )
        .get(p.id, p.clientId, requestId) as OperationRow | undefined;
      if (prior?.afterHash && operation?.status === 'succeeded') {
        const receipt = JSON.parse(operation.result!);
        if (receipt.id !== entry.noteId || receipt.contentHash !== prior.afterHash)
          fail(409, 'REFERENCE_CONFLICT');
        recordMigrationNativeProof(db, fixed, entry.noteId, 'after');
        persist({ ...prior, status: 'rewritten', code: undefined });
        continue;
      }
      if (
        doc.relativePath !== entry.path ||
        sha256(doc.content) !== entry.hash ||
        doc.modifiedAt !== entry.modifiedAt
      )
        fail(409, 'VERSION_CONFLICT');
      const native = fixed.nativeRewrites?.find((x) => x.noteId === entry.noteId);
      if (entry.native && !native) fail(409, 'DIAGRAM_PREVIEW_REQUIRED');
      const rewriteHash = sha256(JSON.stringify(native ?? null));
      if (
        value.after &&
        (value.before !== doc.content ||
          (value.baseline &&
            (value.baseline.path !== entry.path ||
              value.baseline.hash !== entry.hash ||
              value.baseline.modifiedAt !== entry.modifiedAt ||
              value.baseline.rewriteHash !== rewriteHash)))
      )
        fail(409, 'REFERENCE_CONFLICT');
      if (!value.after) {
        const base = native?.content ?? doc.content;
        const replacements: { start: number; end: number; text: string }[] = [];
        for (const span of markdownDestinationSpans(base))
          if (localReference(entry.path, span.url) === r.old_path) {
            const url =
              posix
                .relative(posix.dirname(entry.path), r.new_path)
                .split('/')
                .map(encodePortablePathSegment)
                .join('/') + (span.url.match(/[?#].*$/)?.[0] || '');
            replacements.push({
              start: span.start,
              end: span.end,
              text: span.wiki
                ? `[${span.wiki.label.replace(/[\\\[\]*_`]/g, '\\$&')}](<${url}>)`
                : url,
            });
          }
        const starts = [0];
        for (let i = 0; i < base.length; i++) if (base[i] === '\n') starts.push(i + 1);
        for (const token of markdown.parse(base, {}))
          if (token.type === 'fence' && token.info.trim() === 'excalidraw' && token.map) {
            const ref = whiteboardReference(token.content);
            if (ref === r.note_id || (ref && [r.old_path,r.new_path].includes(localReference(entry.path, ref)!))) {
              const target = posix
                  .relative(posix.dirname(entry.path), r.new_path)
                  .split('/')
                  .map(encodePortablePathSegment)
                  .join('/'),
                preview = posix.relative(posix.dirname(entry.path), prepared.preview.relativePath);
              replacements.push({
                start: starts[token.map[0]],
                end: starts[token.map[1]] ?? base.length,
                text: renderPortableImage('白板预览', preview) + '\n\n[白板文档](' + target + ')\n',
              });
            }
          }
        let after = base;
        for (const span of replacements.sort((a, b) => b.start - a.start))
          after = after.slice(0, span.start) + span.text + after.slice(span.end);
        value = {
          noteId: entry.noteId,
          status: 'writing',
          before: doc.content,
          after,
          afterHash: sha256(after),
          baseline: {
            path: entry.path,
            hash: entry.hash,
            modifiedAt: entry.modifiedAt,
            rewriteHash,
          },
        };
        persist(value);
      }
      if (stageOnly) continue;
      update(entry.noteId, value.after!, entry.modifiedAt, requestId);
      recordMigrationNativeProof(db, fixed, entry.noteId, 'after');
      value = { ...value, status: 'rewritten', code: undefined };
    } catch (e) {
      value = { ...value, status: 'pending', code: (e as any).code || 'REFERENCE_CONFLICT' };
    }
    persist(value);
  }
  if (stageOnly) {
    if (
      fixed.inbound.some(
        (entry) =>
          entry.native && records.find((x) => x.noteId === entry.noteId)?.status === 'pending',
      )
    )
      fail(409, 'MIGRATION_PREFLIGHT_FAILED');
    return;
  }
  db.prepare('UPDATE whiteboard_migrations SET status=? WHERE id=?').run(
    records.some((x) => x.status !== 'rewritten') ? 'references_pending' : 'committed',
    r.id,
  );
}
