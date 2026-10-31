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
};
/** Persist each rewrite's exact before/after bytes before invoking the ordinary versioned writer. */
export function rewriteMigrationInbound(
  db: AppDatabase,
  notes: NoteService,
  p: Principal,
  r: MigrationRow,
  update: (id: string, content: string, version: string, requestId: string) => unknown,
) {
  const fixed = JSON.parse(r.plan) as WhiteboardMigrationPreflight,
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
        persist({ ...prior, status: 'rewritten', code: undefined });
        continue;
      }
      if (
        doc.relativePath !== entry.path ||
        sha256(doc.content) !== entry.hash ||
        doc.modifiedAt !== entry.modifiedAt
      )
        fail(409, 'VERSION_CONFLICT');
      if (entry.native) fail(409, 'DIAGRAM_PREVIEW_REQUIRED');
      if (!value.after) {
        const replacements: { start: number; end: number; text: string }[] = [];
        for (const span of markdownDestinationSpans(doc.content))
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
        for (let i = 0; i < doc.content.length; i++)
          if (doc.content[i] === '\n') starts.push(i + 1);
        for (const token of markdown.parse(doc.content, {}))
          if (token.type === 'fence' && token.info.trim() === 'excalidraw' && token.map) {
            const ref = whiteboardReference(token.content);
            if (ref === r.note_id || (ref && localReference(entry.path, ref) === r.old_path)) {
              const target = posix
                  .relative(posix.dirname(entry.path), r.new_path)
                  .split('/')
                  .map(encodePortablePathSegment)
                  .join('/'),
                preview = posix.relative(posix.dirname(entry.path), prepared.preview.relativePath);
              replacements.push({
                start: starts[token.map[0]],
                end: starts[token.map[1]] ?? doc.content.length,
                text: renderPortableImage('白板预览', preview) + '\n\n[白板文档](' + target + ')\n',
              });
            }
          }
        let after = doc.content;
        for (const span of replacements.sort((a, b) => b.start - a.start))
          after = after.slice(0, span.start) + span.text + after.slice(span.end);
        value = {
          noteId: entry.noteId,
          status: 'writing',
          before: doc.content,
          after,
          afterHash: sha256(after),
        };
        persist(value);
      }
      update(entry.noteId, value.after!, entry.modifiedAt, requestId);
      value = { ...value, status: 'rewritten', code: undefined };
    } catch (e) {
      value = { ...value, status: 'pending', code: (e as any).code || 'REFERENCE_CONFLICT' };
    }
    persist(value);
  }
  db.prepare('UPDATE whiteboard_migrations SET status=? WHERE id=?').run(
    records.some((x) => x.status !== 'rewritten') ? 'references_pending' : 'committed',
    r.id,
  );
}
