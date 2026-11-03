import { DOO_ASSETS_DIRECTORY, isCompatibleAssetPath, isDooAssetPath } from '../../../shared/storage-paths.js';
import { statSync } from 'node:fs';
import { posix } from 'node:path';
import type { AppConfig } from '../../../shared/contracts.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import type { AppDatabase } from '../db.js';
import type { RevisionNativeGroup } from './revision-relocation.js';
import { readBoundDiagramAsset } from './diagram-resource-files.js';
import { diagramOperationPreviewRegistry } from './diagram-operation-previews.js';
import { diagramRendererVersions } from '../../../shared/diagram-primary.js';
import {
  normalizeDiagramCode,
  serializeDiagramBinding,
} from '../../../shared/diagram-portability.js';
import { renderPortableFigure } from '../../../shared/portable-figure.js';
import { rewriteLibraryReferences } from '../organization/references.js';
import { localReference } from '../render.js';
import { safePath } from '../files.js';
import { revisionFileDigest } from './revision-identities.js';
import { sha256 } from './operations.js';
import { fail } from './errors.js';
export function revisionNativeEdits(
  config: AppConfig,
  db: AppDatabase,
  principal: Principal,
  noteId: string,
  revisionId: string,
  revisionHash: string,
  before: string,
  after: string,
  groups: RevisionNativeGroup[],
  mapping: ReadonlyMap<string, string>,
  overrides: Map<string, string> = new Map(),
) {
  if (!groups.length) return [];
  const registry = diagramOperationPreviewRegistry(config, db, principal),
    edits: { start: number; end: number; text: string }[] = [],
    needs: {
      noteId: string;
      snapshotId: string;
      role: 'embedded';
      sourceHash: string;
      renderHash: string;
    }[] = [];
  const file = safePath(config.knowledgeRoot, after, 'note'),
    modifiedAt = statSync(file, { bigint: true }).mtimeNs.toString(),
    documentHash = revisionFileDigest(file),
    moves = [...mapping].filter(([from, to]) => from !== to).map(([from, to]) => ({ from, to }));
  for (const group of groups) {
    const originalSource = localReference(before, group.sourcePath),
      originalPreview = localReference(before, group.previewPath);
    if (!originalSource || !originalPreview) fail(409, 'REVISION_CONTEXT_INVALID');
    const actualSource = mapping.get(originalSource) ?? originalSource,
      actualPreview = mapping.get(originalPreview) ?? originalPreview;
    let source: string;
    try {
      source = readBoundDiagramAsset(config, actualSource, 'source').toString('utf8');
    } catch {
      return fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
    }
    if (sha256(source) !== group.sourceHash) fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
    // Reuse keeps this asset at its actual path. Equal bytes at a possible new upload base
    // do not prove that the retained source still resolves its node targets correctly.
    const reusable =
      rewriteLibraryReferences(source, originalSource, actualSource, moves, true).content ===
      source;
    let sourcePath = posix.relative(posix.dirname(after), actualSource),
      previewPath = posix.relative(posix.dirname(after), actualPreview),
      sourceHash = group.sourceHash;
    if (!reusable) {
      const final = rewriteLibraryReferences(
        source,
        originalSource,
        posix.join(posix.dirname(after), DOO_ASSETS_DIRECTORY + '/history.excalidraw'),
        moves,
        true,
      ).content;
      const snapshot = registry.fix({
          noteId,
          role: 'embedded',
          kind: 'excalidraw',
          documentPath: after,
          documentHash,
          documentModifiedAt: modifiedAt,
          sourcePath: actualSource,
          sourceHash: group.sourceHash,
          finalSource: final,
          type: 'whiteboard',
          title: 'EXCALIDRAW',
          renderer: diagramRendererVersions.whiteboard,
          config: {},
          moves,
          permissions: [after],
          context: {
            kind: 'history',
            revisionId,
            revisionHash,
            groupStart: group.start,
            references: sha256(JSON.stringify([...mapping])),
          },
        }),
        prepared = registry.prepared(snapshot.id);
      if (!prepared) {
        needs.push({
          noteId,
          snapshotId: snapshot.id,
          role: 'embedded',
          sourceHash: snapshot.sourceHash,
          renderHash: snapshot.renderHash,
        });
        continue;
      }
      if (!prepared.source) fail(409, 'DIAGRAM_PREPARATION_MISMATCH');
      sourcePath = prepared.source.markdownPath;
      previewPath = prepared.preview.markdownPath;
      sourceHash = prepared.sourceHash;
    }
    if (group.pair) {
      overrides.set(originalSource, posix.join(posix.dirname(after), sourcePath));
      overrides.set(originalPreview, posix.join(posix.dirname(after), previewPath));
      continue;
    }
    if (
      sourcePath !== group.sourcePath ||
      previewPath !== group.previewPath ||
      sourceHash !== group.sourceHash ||
      group.code.trim() !== sourcePath ||
      group.codeHash !== sha256(normalizeDiagramCode(sourcePath))
    ) {
      const text =
        renderPortableFigure({
          alt: 'EXCALIDRAW 预览',
          previewPath,
          source: { type: 'file', path: sourcePath },
        }) +
        '\n' +
        serializeDiagramBinding({
          kind: 'excalidraw',
          sourceHash,
          codeHash: sha256(normalizeDiagramCode(sourcePath)),
        }) +
        '\n\n```excalidraw\n' +
        sourcePath +
        '\n```\n';
      edits.push({ start: group.start, end: group.end, text });
    }
  }
  if (needs.length)
    fail(409, 'DIAGRAM_PREVIEW_REQUIRED', '历史原生图形需要按最终链接重新准备预览', false, {
      documents: needs,
    });
  return edits;
}
