import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import type { AppConfig } from '../../../shared/contracts.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import { parseDiagramDocument } from '../../../shared/diagram-document.js';
import {
  applyPreparedDiagramDocument,
  diagramRendererVersions,
  primaryRenderDescriptor,
} from '../../../shared/diagram-primary.js';
import { parseWhiteboard } from '../../../shared/whiteboard.js';
import type { AppDatabase } from '../db.js';
import type { NoteService } from '../notes.js';
import type { assetService } from '../assets.js';
import { authorizePath } from '../agent/auth.js';
import { isSharePrincipal } from '../share-policy.js';
import { localReference } from '../render.js';
import { rewriteLibraryReferences } from '../organization/references.js';
import { readPrimaryDiagramState } from './primary-diagram-state.js';
import { primaryDiagramService } from './primary-diagrams.js';
import { revisionContext, revisionFile } from './revision-context.js';
import { beginOperation, completeOperation, existingResult, sha256 } from './operations.js';
import { workspaceWriteSync } from '../workspace/gate.js';
import { fail } from './errors.js';
import { rebaseRevisionMarkdown } from './revision-relocation.js';

export type DiagramHistoryRestorePlan = {
  id: string;
  noteId: string;
  revisionId: string;
  relativePath: string;
  type: 'whiteboard' | 'mindmap' | 'flowchart';
  source: string;
  sourceHash: string;
  title: string;
  renderer: string;
  config: Record<string, unknown>;
  expectedModifiedAt: string;
  expectedDocumentHash: string;
  expectedSourceHash: string;
  revisionHash: string;
  baseMarkdown: string;
  expiresAt: number;
};
type Row = {
  id: string;
  note_id: string;
  revision_id: string;
  principal: string;
  client_id: string;
  plan: string;
  prepared_id: string | null;
  markdown: string | null;
  status: string;
  expires_at: number;
};

/** A typed history restore is a new complete publication, never a raw history-file overwrite. */
export function diagramHistoryRestoreService(
  config: AppConfig,
  db: AppDatabase,
  notes: NoteService,
  assets: ReturnType<typeof assetService>,
  principal: Principal,
) {
  const primary = primaryDiagramService(config, db, notes, assets, principal);
  function authorize(noteId: string) {
    if (isSharePrincipal(principal)) fail(403, 'FORBIDDEN');
    const note = notes.row(noteId);
    authorizePath(principal, note.path, 'knowledge:write');
    return note;
  }
  function row(id: string) {
    const value = db.prepare('SELECT * FROM diagram_history_restores WHERE id=?').get(id) as
      | Row
      | undefined;
    if (!value || value.principal !== principal.id || value.client_id !== principal.clientId)
      fail(404, 'NOT_FOUND');
    authorize(value.note_id);
    return value;
  }
  function check(value: DiagramHistoryRestorePlan) {
    if (value.expiresAt <= Date.now()) fail(410, 'DIAGRAM_RESTORE_PLAN_EXPIRED');
    const current = readPrimaryDiagramState(db, notes, assets, principal, value.noteId);
    if (
      current.note.relativePath !== value.relativePath ||
      current.note.modifiedAt !== value.expectedModifiedAt ||
      current.documentHash !== value.expectedDocumentHash
    )
      fail(409, 'VERSION_CONFLICT');
    if (current.sourceHash !== value.expectedSourceHash) fail(409, 'DIAGRAM_SOURCE_CONFLICT');
    if (
      revisionContext(config, db, value.noteId, value.revisionId).contentHash !== value.revisionHash
    )
      fail(409, 'REVISION_CONTENT_CONFLICT');
    return current;
  }
  function plan(
    noteId: string,
    revisionId: string,
    expectedModifiedAt: string,
    requestId: string,
  ): DiagramHistoryRestorePlan {
    authorize(noteId);
    return workspaceWriteSync(db, { kind: 'diagram-history.plan' }, () => {
      const op = beginOperation(db, principal, 'diagram-history.plan', requestId, {
        noteId,
        revisionId,
        expectedModifiedAt,
      });
      if (!op.fresh) return existingResult(op.operation) as DiagramHistoryRestorePlan;
      const context = revisionContext(config, db, noteId, revisionId);
      const current = readPrimaryDiagramState(db, notes, assets, principal, noteId);
      if (current.note.modifiedAt !== expectedModifiedAt) fail(409, 'VERSION_CONFLICT');
      const revision = db
        .prepare('SELECT file FROM revisions WHERE id=? AND note_id=?')
        .get(revisionId, noteId) as { file: string };
      const historical = readFileSync(revisionFile(config, revision.file), 'utf8');
      if (sha256(historical) !== context.contentHash) fail(409, 'REVISION_CONTENT_CONFLICT');
      const parsed = parseDiagramDocument(historical);
      const legacy = context.payloadFormat === 'excalidraw';
      if (!legacy && parsed.status !== 'diagram') fail(409, 'DIAGRAM_DOCUMENT_CONVERSION_REQUIRED');
      const type = legacy
        ? 'whiteboard'
        : parsed.status === 'diagram'
          ? parsed.type
          : current.parsed.type;
      if (type !== current.parsed.type) fail(409, 'DIAGRAM_DOCUMENT_CONVERSION_REQUIRED');
      let source: string, oldSourcePath: string | undefined;
      let baseMarkdown = current.note.content,
        title = current.parsed.title,
        render = primaryRenderDescriptor(current.parsed);
      if (legacy) {
        parseWhiteboard(historical);
        source = historical;
        oldSourcePath = context.logicalPath ?? undefined;
      } else if (parsed.status === 'diagram') {
        if (!context.logicalPath)
          fail(409, 'REVISION_PATH_UNKNOWN', '历史版本缺少原始逻辑路径，无法安全重定位资源');
        baseMarkdown = rebaseRevisionMarkdown(
          historical,
          context.logicalPath,
          current.note.relativePath,
        );
        title = parsed.title;
        render = primaryRenderDescriptor(parsed);
        if (parsed.primary.source.format === 'excalidraw') {
          const retained = context.resources.find(
            (r) => r.role === 'source' && r.hash === parsed.primary.binding.sourceHash,
          );
          oldSourcePath =
            retained?.path ?? localReference(context.logicalPath, parsed.primary.source.path);
          if (!oldSourcePath) fail(409, 'REVISION_CONTEXT_INVALID');
          source = assets.file(oldSourcePath).bytes.toString('utf8');
          if (sha256(source) !== parsed.primary.binding.sourceHash)
            fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
          parseWhiteboard(source);
        } else source = parsed.primary.source.content;
      } else return fail(409, 'REVISION_CONTEXT_INVALID');
      if (type === 'whiteboard') {
        if (!oldSourcePath)
          fail(409, 'REVISION_PATH_UNKNOWN', '旧白板历史缺少路径，需要先核对原始位置');
        const targetSource = posix.join(
          posix.dirname(current.note.relativePath),
          'assets',
          'history.excalidraw',
        );
        source = rewriteLibraryReferences(source, oldSourcePath, targetSource, [], true).content;
      }
      const value: DiagramHistoryRestorePlan = {
        id: op.operation.id,
        noteId,
        revisionId,
        relativePath: current.note.relativePath,
        type,
        source,
        sourceHash: sha256(source),
        title,
        renderer: diagramRendererVersions[type],
        config: render.config,
        expectedModifiedAt,
        expectedDocumentHash: current.documentHash,
        expectedSourceHash: current.sourceHash,
        revisionHash: context.contentHash,
        baseMarkdown,
        expiresAt: Date.now() + 60 * 60 * 1000,
      };
      db.transaction(() => {
        db.prepare(
          'INSERT INTO diagram_history_restores(id,note_id,revision_id,principal,client_id,plan,expires_at) VALUES(?,?,?,?,?,?,?)',
        ).run(
          value.id,
          noteId,
          revisionId,
          principal.id,
          principal.clientId,
          JSON.stringify(value),
          value.expiresAt,
        );
        completeOperation(db, op.operation.id, value);
      })();
      return value;
    });
  }
  function prepare(
    id: string,
    input: { sourceHash: string; pngBase64: string; requestId: string },
  ) {
    const stored = row(id),
      value = JSON.parse(stored.plan) as DiagramHistoryRestorePlan;
    check(value);
    if (input.sourceHash !== value.sourceHash) fail(409, 'DIAGRAM_SOURCE_CONFLICT');
    const prepared = primary.prepare({
      target: {
        kind: 'document',
        noteId: value.noteId,
        expectedDocumentHash: value.expectedDocumentHash,
        expectedSourceHash: value.expectedSourceHash,
      },
      type: value.type,
      source: value.source,
      sourceHash: value.sourceHash,
      title: value.title,
      renderer: value.renderer,
      config: value.config,
      pngBase64: input.pngBase64,
      requestId: input.requestId,
    });
    const markdown = applyPreparedDiagramDocument({
      markdown: value.baseMarkdown,
      prepared,
      source: value.source,
    });
    db.prepare(
      "UPDATE diagram_history_restores SET prepared_id=?,markdown=?,status='prepared' WHERE id=?",
    ).run(prepared.id, markdown, id);
    return { id, preparedId: prepared.id, sourceHash: value.sourceHash };
  }
  function commit(id: string, input: { requestId: string }) {
    return workspaceWriteSync(db, { kind: 'diagram-history.commit' }, () => {
      const stored = row(id),
        value = JSON.parse(stored.plan) as DiagramHistoryRestorePlan;
      if (!stored.prepared_id || !stored.markdown) fail(409, 'DIAGRAM_PREVIEW_REQUIRED');
      // A stable inner key resolves a lost response even if the client reopens the plan.
      const requestId = 'history-' + id;
      const previous = db
        .prepare(
          "SELECT id,status FROM operations WHERE principal=? AND client_id=? AND kind='diagram-primary.commit' AND request_id=?",
        )
        .get(principal.id, principal.clientId, requestId) as
        | { id: string; status: string }
        | undefined;
      const inner =
        previous &&
        (db
          .prepare(
            "SELECT status FROM operations WHERE principal=? AND client_id=? AND kind='update' AND request_id=?",
          )
          .get(principal.id, principal.clientId, 'primary-' + previous.id) as
          | { status: string }
          | undefined);
      if (previous?.status !== 'succeeded' && inner?.status !== 'succeeded') check(value);
      const outer = beginOperation(db, principal, 'diagram-history.commit', input.requestId, {
        id,
      });
      const result = primary.commit({
        preparedId: stored.prepared_id,
        markdown: stored.markdown,
        requestId,
      });
      db.transaction(() => {
        db.prepare("UPDATE diagram_history_restores SET status='committed' WHERE id=?").run(id);
        if (outer.operation.status !== 'succeeded')
          completeOperation(db, outer.operation.id, {
            id: result.id,
            relativePath: result.relativePath,
            modifiedAt: result.modifiedAt,
          });
      })();
      return result;
    });
  }
  return {
    plan,
    prepare,
    commit,
    get: (id: string) => {
      const stored = row(id);
      return {
        ...(JSON.parse(stored.plan) as DiagramHistoryRestorePlan),
        status: stored.status,
        ...(stored.prepared_id ? { preparedId: stored.prepared_id } : {}),
      };
    },
  };
}
