
import { posix } from 'node:path';
import type { AppConfig } from '../../../shared/contracts.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import type { AppDatabase } from '../db.js';
import type { NoteService } from '../notes.js';
import type { assetService } from '../assets.js';
import { authorizePath } from '../agent/auth.js';
import { validName } from '../files.js';
import { readBody } from '../organization/plan.js';
import { rewriteLibraryReferences } from '../organization/references.js';
import { isDocument } from '../../../shared/whiteboard.js';
import { parseDiagramDocument } from '../../../shared/diagram-document.js';
import { primaryRenderDescriptor, applyPreparedDiagramDocument, type PreparedDiagramPrimary } from '../../../shared/diagram-primary.js';
import { boundDiagramSources, normalizeDiagramCode } from '../../../shared/diagram-portability.js';
import { serializeDiagramBinding } from '../../../shared/diagram-binding.js';
import { renderPortableFigure } from '../../../shared/portable-figure.js';
import { localReference } from '../render.js';
import { workspaceWriteSync } from '../workspace/gate.js';
import { beginOperation, existingResult, completeOperation, sha256 } from './operations.js';
import { readBoundDiagramAsset } from './diagram-resource-files.js';
import { hasDiagramBindingProof } from './diagram-publications.js';
import { diagramCreationService } from './diagram-creation.js';
import { mutationCore } from './core.js';
import { diagramOperationPreviewRegistry } from './diagram-operation-previews.js';
import { fail } from './errors.js';
export type DocumentCopyInput = {
  folderPath: string;
  fileName: string;
  expectedModifiedAt: string;
  expectedContentHash: string;
  requestId: string;
};
/** A copy owns a fresh document identity and retains verified shared immutable resources. */
export function documentCopyService(
  config: AppConfig,
  db: AppDatabase,
  notes: NoteService,
  assets: ReturnType<typeof assetService>,
  p: Principal,
) {
  function copy(id: string, input: DocumentCopyInput) {
    return workspaceWriteSync(db, { kind: 'document.copy' }, () => {
      if (
        !input ||
        typeof input.folderPath !== 'string' ||
        !validName(input.fileName) ||
        !isDocument(input.fileName) ||
        typeof input.expectedContentHash !== 'string' ||
        typeof input.expectedModifiedAt !== 'string'
      )
        fail(400, 'INVALID_INPUT');
      const row = notes.row(id),
        target = input.folderPath ? input.folderPath + '/' + input.fileName : input.fileName;
      authorizePath(p, row.path, 'knowledge:read');
      authorizePath(p, target, 'knowledge:write');

      const { operation } = beginOperation(db, p, 'document.copy', input.requestId, {
        id,
        ...input,
      });
      if (operation.status === 'succeeded') return existingResult(operation);
      const body = readBody(config, row.path);
      if (
        body.hash !== input.expectedContentHash ||
        body.evidence.mtime !== input.expectedModifiedAt
      )
        fail(409, 'VERSION_CONFLICT');
      const parsed = parseDiagramDocument(body.content);
      let content = rewriteLibraryReferences(body.content, row.path, target, []).content;
      const core = mutationCore(config, db);
      let result: any;
      if (parsed.status === 'diagram') {
        const binding = parsed.primary.binding,
          previewPath = localReference(row.path, parsed.primary.previewPath),
          sourcePath =
            parsed.primary.source.format === 'excalidraw'
              ? localReference(row.path, parsed.primary.source.path)
              : undefined;
        if (
          !previewPath ||
          !hasDiagramBindingProof(db, id, { ...binding, previewPath, sourcePath })
        )
          fail(409, 'DIAGRAM_PREVIEW_REQUIRED');
        for (const [role, path, hash] of [
          ['preview', previewPath, binding.previewHash],
          ['source', sourcePath, binding.sourceHash],
        ] as const)
          if (path && sha256(readBoundDiagramAsset(config, path, role)) !== hash)
            fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
        const intent = diagramCreationService(config, db, p).reserve({
          path: target,
          type: parsed.type,
          requestId: 'copy-intent-' + operation.id,
        });
        const asset = (path: string, mime: string) => {
          const a = db.prepare('SELECT id FROM assets WHERE path=?').get(path) as
            | { id: string }
            | undefined;
          if (!a) fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
          return {
            id: a.id,
            relativePath: path,
            markdownPath: posix.relative(posix.dirname(target), path),
            mime,
          };
        };
        const render = primaryRenderDescriptor(parsed);
        let prepared: PreparedDiagramPrimary = {
          id: operation.id,
          noteId: intent.noteId,
          creationIntentId: intent.id,
          type: parsed.type,
          documentHash: null,
          baselineSourceHash: null,
          ...binding,
          title: parsed.title,
          renderer: render.renderer,
          config: render.config,
          preview: asset(previewPath, 'image/png'),
          ...(sourcePath ? { source: asset(sourcePath, 'application/vnd.excalidraw+json') } : {}),
          expiresAt: intent.expiresAt,
        };
        const relocated = parseDiagramDocument(content);
        if (relocated.status !== 'diagram') fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
        if (
          parsed.primary.source.format !== 'excalidraw' &&
          relocated.primary.source.format !== 'excalidraw' &&
          relocated.primary.source.content !== parsed.primary.source.content
        ) {
          const registry = diagramOperationPreviewRegistry(config, db, p, assets),
            fixed = registry.fix({
              noteId: id,
              role: 'primary',
              documentPath: row.path,
              documentHash: body.hash,
              documentModifiedAt: body.evidence.mtime,
              sourceHash: binding.sourceHash,
              finalSource: relocated.primary.source.content,
              type: parsed.type,
              title: parsed.title,
              renderer: render.renderer,
              config: render.config,
              moves: [],
              permissions: [target],
              context: { copyOperationId: operation.id, creationIntentId: intent.id },
            }),
            snapshot = registry.prepared(fixed.id);
          if (!snapshot)
            fail(409, 'DIAGRAM_PREVIEW_REQUIRED', '请为副本的最终源码准备预览', false, {
              planId: fixed.id,
              documents: [
                {
                  noteId: id,
                  role: 'primary',
                  documentHash: body.hash,
                  sourceHash: fixed.sourceHash,
                  renderHash: fixed.renderHash,
                  snapshotId: fixed.id,
                },
              ],
            });
          prepared = {
            ...snapshot,
            id: operation.id,
            noteId: intent.noteId,
            creationIntentId: intent.id,
            documentHash: null,
            baselineSourceHash: null,
            preview: {
              ...snapshot.preview,
              markdownPath: posix.relative(posix.dirname(target), snapshot.preview.relativePath),
            },
            expiresAt: intent.expiresAt,
          };
          content = applyPreparedDiagramDocument({
            markdown: content,
            prepared,
            source: fixed.source,
          });
        }
        db.prepare(
          'INSERT OR IGNORE INTO diagram_prepared_primaries(id,note_id,creation_intent_id,principal,client_id,document_hash,baseline_source_hash,source_hash,render_hash,preview_hash,result,created_at,expires_at) VALUES(?,?,?,?,?,NULL,NULL,?,?,?,?,?,?)',
        ).run(
          prepared.id,
          prepared.noteId,
          intent.id,
          p.id,
          p.clientId,
          prepared.sourceHash,
          prepared.renderHash,
          prepared.previewHash,
          JSON.stringify(prepared),
          Date.now(),
          prepared.expiresAt,
        );
        result = core.createDiagram(p, intent.id, content, 'copy-publish-' + operation.id);
      } else {
        // Excalidraw reference fences are anchored at the containing Markdown file.
        // Their editable scene assets remain anchored at their immutable source path.
        for (const group of boundDiagramSources(content)
          .filter((g) => g.kind === 'excalidraw')
          .sort((a, b) => b.from - a.from)) {
          const old = boundDiagramSources(body.content).find(
            (g) => g.binding.sourceHash === group.binding.sourceHash,
          );
          if (!old) fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
          const sourcePath = localReference(row.path, old.sourcePath);
          if (!sourcePath) fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
          const code = posix.relative(posix.dirname(target), sourcePath);
          const replacement =
            renderPortableFigure({
              alt: 'EXCALIDRAW 预览',
              previewPath: group.previewPath,
              source: { type: 'file', path: group.sourcePath },
            }) +
            '\n' +
            serializeDiagramBinding({
              ...group.binding,
              codeHash: sha256(normalizeDiagramCode(code)),
            }) +
            '\n\n```excalidraw\n' +
            code +
            '\n```\n';
          content = content.slice(0, group.prefixFrom) + replacement + content.slice(group.to);
        }
        result = core.createPortableMarkdown(
          p,
          input.folderPath,
          input.fileName,
          content,
          'copy-publish-' + operation.id,
        );
      }
      completeOperation(db, operation.id, { ...result, copiedFrom: id });
      return { ...result, copiedFrom: id };
    });
  }
  return { copy };
}
