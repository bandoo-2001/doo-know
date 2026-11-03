import { DOO_ASSETS_DIRECTORY, isCompatibleAssetPath, isDooAssetPath } from '../../../shared/storage-paths.js';
import { archivedDiagramRoot, type ArchivedDiagramContext } from './archived-diagram-context.js';
import {
  archivedNoteDiagramFile,
  type ArchivedNoteDiagramContext,
} from './archived-note-diagram-context.js';
import { lstatSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import type { AppConfig } from '../../../shared/contracts.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import { parseDiagramDocument } from '../../../shared/diagram-document.js';
import {
  applyPreparedDiagramDocument,
  primaryRenderDescriptor,
  diagramRendererVersions,
  type PreparedDiagramPrimary,
} from '../../../shared/diagram-primary.js';
import { boundDiagramSources, normalizeDiagramCode } from '../../../shared/diagram-portability.js';
import { serializeDiagramBinding } from '../../../shared/diagram-binding.js';
import { renderPortableFigure } from '../../../shared/portable-figure.js';
import { isWhiteboard, withWhiteboardId } from '../../../shared/whiteboard.js';
import type { AppDatabase } from '../db.js';
import { safePath } from '../files.js';
import { canAccessPath } from '../agent/auth.js';
import { localReference, references } from '../render.js';
import { rewriteLibraryReferences } from '../organization/references.js';
import { inventory } from '../organization/plan.js';
import { diagramOperationPreviewRegistry } from './diagram-operation-previews.js';
import { readBoundDiagramAsset } from './diagram-resource-files.js';
import { relocatePath } from './diagram-relocation.js';
import { sha256 } from './operations.js';
import { fail } from './errors.js';
import type { DiagramArtifacts } from './diagram-artifacts.js';
import { hasUnaffectedPublishedNativeLinks } from './native-link-proof.js';
export type NativePreviewNeed = {
  noteId: string;
  role: 'primary' | 'embedded';
  documentHash: string;
  sourceHash: string;
  renderHash: string;
  snapshotId: string;
};
export type NativeDocumentRewrite = {
  documentHash: string;
  documentModifiedAt: string;
  snapshotIds?: string[];
  content: string;
  primary?: PreparedDiagramPrimary;
  legacy?: {
    documentHash: string;
    title: string;
    renderer: string;
    config: Record<string, unknown>;
    renderHash: string;
    preview: { path: string; hash: string };
  };
};
/** Enumerate current documents only. Retained old assets remain immutable retention roots. */
export function collectNativeLinkChanges(
  config: AppConfig,
  db: AppDatabase,
  p: Principal,
  moves: { from: string; to: string }[],
  options: {
    excludeNoteIds?: string[];
    notes?: { id: string; path: string }[];
    archive?: ArchivedDiagramContext;
    noteTrash?: ArchivedNoteDiagramContext;
    referenceMapping?: ReadonlyMap<string, string>;
  } = {},
) {
  const registry = diagramOperationPreviewRegistry(config, db, p),
    rewrites = new Map<string, NativeDocumentRewrite>(),
    needs: NativePreviewNeed[] = [];
  if (!moves.length) return { rewrites, needs };
  const fixedInventory = inventory(config);
  const receipts = db
    .prepare(
      "SELECT result FROM operations WHERE kind LIKE 'diagram-artifacts:%' AND status='succeeded' AND result IS NOT NULL",
    )
    .all() as { result: string }[];
  const archiveRoot = options.archive
    ? archivedDiagramRoot(config, db, options.archive)
    : undefined;
  const readAsset = (path: string) => {
    path = options.referenceMapping?.get(path) ?? path;
    return archiveRoot && path.startsWith(options.archive!.logicalRoot + '/')
      ? readBoundDiagramAsset(
          { ...config, knowledgeRoot: archiveRoot },
          path.slice(options.archive!.logicalRoot.length + 1),
          'source',
        )
      : readBoundDiagramAsset(config, path, 'source');
  };
  for (const note of options.notes ??
    (db.prepare('SELECT id,path FROM notes WHERE active=1 ORDER BY path').all() as {
      id: string;
      path: string;
    }[])) {
    if (options.excludeNoteIds?.includes(note.id)) continue;
    const snapshotIds: string[] = [];
    const file = options.noteTrash
        ? archivedNoteDiagramFile(config, db, options.noteTrash)
        : archiveRoot
          ? safePath(archiveRoot, note.path.slice(options.archive!.logicalRoot.length + 1), 'note')
          : safePath(config.knowledgeRoot, note.path, 'note'),
      stamp = lstatSync(file, { bigint: true });
    if (stamp.size > 20n * 1024n * 1024n) fail(413, 'FILE_TOO_LARGE');
    let original: string;
    try {
      original = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        readFileSync(file),
      );
    } catch {
      fail(422, 'INVALID_UTF8');
    }
    const documentHash = sha256(original),
      target = relocatePath(note.path, moves),
      parsed = parseDiagramDocument(original);
    // Ordinary text needs one of these delimiters to contain a movable destination.
    // Linkified scheme URLs retain their URL; every file above is still fully read and validated.
    if (
      parsed.status === 'ordinary' &&
      !isWhiteboard(note.path) &&
      !/[<\[`~]/.test(original)
    )
      continue;
    let content = rewriteLibraryReferences(
      original,
      note.path,
      target,
      moves,
      isWhiteboard(note.path),
    ).content;
    let primary: PreparedDiagramPrimary | undefined, legacy: NativeDocumentRewrite['legacy'];
    const prepare = (
      source: string,
      sourcePath: string | undefined,
      sourceHash: string,
      role: 'primary' | 'embedded',
      title: string,
      renderer: string,
      renderConfig: Record<string, unknown>,
      key: string,
    ) => {
      // New immutable uploads live beside this note's current assets. The folder may move together.
      const nextBase = relocatePath(
        posix.join(posix.dirname(note.path), DOO_ASSETS_DIRECTORY + '/operation.excalidraw'),
        moves,
      );
      const final = rewriteLibraryReferences(
        source,
        sourcePath ?? note.path,
        sourcePath ? nextBase : target,
        moves,
        true,
      );
      const existingChanges = sourcePath
        ? rewriteLibraryReferences(source, sourcePath, relocatePath(sourcePath, moves), moves, true)
            .changed
        : false;
      if (!final.changed && !existingChanges) return;
      if (!sourcePath && isWhiteboard(note.path))
        final.content = withWhiteboardId(final.content, note.id);
      if (!canAccessPath(p, note.path)) fail(403, 'DEPENDENCY_FORBIDDEN');
      const snapshot = registry.fix({
        noteId: note.id,
        role,
        kind: 'excalidraw',
        documentPath: note.path,
        documentHash,
        documentModifiedAt: stamp.mtimeNs.toString(),
        sourcePath: sourcePath
          ? (options.referenceMapping?.get(sourcePath) ?? sourcePath)
          : undefined,
        sourceHash,
        finalSource: final.content,
        type: 'whiteboard',
        title,
        renderer,
        config: renderConfig,
        moves,
        permissions: [target],
        context: { key, inventory: fixedInventory },
        ...(options.archive ? { archive: options.archive } : {}),
        ...(options.noteTrash ? { noteTrash: options.noteTrash } : {}),
      });
      const prepared = registry.prepared(snapshot.id);
      if (!prepared) {
        needs.push({
          noteId: note.id,
          role,
          documentHash,
          sourceHash: snapshot.sourceHash,
          renderHash: snapshot.renderHash,
          snapshotId: snapshot.id,
        });
        return;
      }
      snapshotIds.push(snapshot.id);
      const rebase = (asset: PreparedDiagramPrimary['preview']) => ({
        ...asset,
        relativePath: relocatePath(asset.relativePath, moves),
        markdownPath: posix.relative(
          posix.dirname(target),
          relocatePath(asset.relativePath, moves),
        ),
      });
      return {
        prepared: {
          ...prepared,
          preview: rebase(prepared.preview),
          ...(prepared.source ? { source: rebase(prepared.source) } : {}),
        },
        source: final.content,
      };
    };
    if (parsed.status === 'diagram' && parsed.primary.source.format === 'excalidraw') {
      const sourcePath = localReference(note.path, parsed.primary.source.path);
      if (!sourcePath) fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
      let source: string | undefined;
      try {
        source = readAsset(sourcePath).toString('utf8');
        if (sha256(source) !== parsed.primary.binding.sourceHash) source = undefined;
      } catch {
        // An unavailable source remains quarantined. Only a complete published
        // proof can establish that this operation cannot affect its native links.
      }
      if (source === undefined) {
        const unaffected =
          content === original &&
          !options.archive &&
          !options.noteTrash &&
          !options.referenceMapping &&
          hasUnaffectedPublishedNativeLinks(db, {
            noteId: note.id,
            documentHash,
            documentPath: note.path,
            sourcePath,
            sourceHash: parsed.primary.binding.sourceHash,
            moves,
          });
        if (!unaffected)
          fail(409, 'DIAGRAM_SOURCE_CONFLICT', '受影响的图形源不可用或缺少完整依赖证明');
      }
      const render = primaryRenderDescriptor(parsed),
        result =
          source === undefined
            ? undefined
            : prepare(
                source,
                sourcePath,
                parsed.primary.binding.sourceHash,
                'primary',
                parsed.title,
                render.renderer,
                render.config,
                'primary',
              );
      if (result) {
        primary = result.prepared;
        content = applyPreparedDiagramDocument({
          markdown: content,
          prepared: primary,
          source: result.source,
        });
      }
    } else if (parsed.status === 'diagram') {
      const next = parseDiagramDocument(content);
      if (
        next.status !== 'diagram' ||
        next.primary.source.format === 'excalidraw' ||
        parsed.primary.source.format === 'excalidraw'
      )
        fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
      const beforeSource = parsed.primary.source.content,
        finalSource = next.primary.source.content;
      if (beforeSource !== finalSource) {
        if (!canAccessPath(p, note.path)) fail(403, 'DEPENDENCY_FORBIDDEN');
        if (sha256(beforeSource) !== parsed.primary.binding.sourceHash)
          fail(409, 'DIAGRAM_SOURCE_CONFLICT');
        const render = primaryRenderDescriptor(parsed),
          snapshot = registry.fix({
            noteId: note.id,
            role: 'primary',
            documentPath: note.path,
            documentHash,
            documentModifiedAt: stamp.mtimeNs.toString(),
            sourceHash: parsed.primary.binding.sourceHash,
            finalSource,
            type: parsed.type,
            title: parsed.title,
            renderer: render.renderer,
            config: render.config,
            moves,
            permissions: [target],
            context: { key: 'primary-inline', inventory: fixedInventory },
            ...(options.archive ? { archive: options.archive } : {}),
            ...(options.noteTrash ? { noteTrash: options.noteTrash } : {}),
          });
        const prepared = registry.prepared(snapshot.id);
        if (!prepared)
          needs.push({
            noteId: note.id,
            role: 'primary',
            documentHash,
            sourceHash: snapshot.sourceHash,
            renderHash: snapshot.renderHash,
            snapshotId: snapshot.id,
          });
        else {
          snapshotIds.push(snapshot.id);
          primary = {
            ...prepared,
            preview: {
              ...prepared.preview,
              relativePath: relocatePath(prepared.preview.relativePath, moves),
              markdownPath: posix.relative(
                posix.dirname(target),
                relocatePath(prepared.preview.relativePath, moves),
              ),
            },
          };
          content = applyPreparedDiagramDocument({
            markdown: content,
            prepared: primary,
            source: finalSource,
          });
        }
      }
    } else if (isWhiteboard(note.path)) {
      const row = db
        .prepare(
          'SELECT manifest FROM legacy_diagram_previews WHERE note_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1',
        )
        .get(note.id) as { manifest: string } | undefined;
      const old = row ? JSON.parse(row.manifest) : undefined,
        title = old?.title ?? posix.basename(note.path, '.excalidraw');
      const result = prepare(
        original,
        undefined,
        documentHash,
        'primary',
        title,
        old?.renderer ?? diagramRendererVersions.whiteboard,
        old?.config ?? {},
        'legacy',
      );
      if (result) {
        content = result.source;
        legacy = {
          documentHash: sha256(content),
          title,
          renderer: result.prepared.renderer,
          config: result.prepared.config,
          renderHash: result.prepared.renderHash,
          preview: {
            path: result.prepared.preview.markdownPath,
            hash: result.prepared.previewHash,
          },
        };
      }
    }
    // Generated groups retain exact native JSON syntax in their authoritative asset.
    for (const group of boundDiagramSources(original)
      .filter((g) => g.kind === 'excalidraw')
      .sort((a, b) => b.from - a.from)) {
      const path = localReference(note.path, group.sourcePath);
      if (!path) fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
      const source = readAsset(path).toString('utf8');
      if (sha256(source) !== group.binding.sourceHash) fail(409, 'DIAGRAM_SOURCE_CONFLICT');
      const result = prepare(
        source,
        path,
        group.binding.sourceHash,
        'embedded',
        'EXCALIDRAW',
        diagramRendererVersions.whiteboard,
        {},
        'group:' + group.from,
      );
      // Reparse rewritten offsets because destinations before this group may have changed length.
      const current = boundDiagramSources(content).find(
        (g) =>
          g.binding.sourceHash === group.binding.sourceHash &&
          g.kind === 'excalidraw' &&
          localReference(target, g.sourcePath) === relocatePath(path, moves),
      );
      if (!current) fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
      if (
        result ||
        current.code.trim() !== current.sourcePath ||
        sha256(normalizeDiagramCode(current.code)) !== current.binding.codeHash
      ) {
        const sourcePath = result?.prepared.source?.markdownPath ?? current.sourcePath;
        const previewPath = result?.prepared.preview.markdownPath ?? current.previewPath;
        const code = sourcePath;
        const replacement =
          renderPortableFigure({
            alt: 'EXCALIDRAW 预览',
            previewPath,
            source: { type: 'file', path: sourcePath },
          }) +
          '\n' +
          serializeDiagramBinding({
            kind: 'excalidraw',
            sourceHash: result?.prepared.sourceHash ?? current.binding.sourceHash,
            codeHash: sha256(normalizeDiagramCode(code)),
          }) +
          '\n\n```excalidraw\n' +
          code +
          '\n```\n';
        content = content.slice(0, current.prefixFrom) + replacement + content.slice(current.to);
      }
    }
    // Pre-v1 inserted pairs can still be consumed by ordinary Markdown links.
    const currentTargets = new Set(
      references(original).map((url) => localReference(note.path, url)),
    );
    for (const receipt of receipts) {
      const pair = JSON.parse(receipt.result) as DiagramArtifacts;
      for (const asset of [pair.source, pair.preview])
        if (asset) {
          const current = db.prepare('SELECT path FROM assets WHERE id=?').get(asset.id) as
            | { path: string }
            | undefined;
          if (current) asset.relativePath = current.path;
        }
      if (
        !pair.source?.relativePath.endsWith('.excalidraw') ||
        !currentTargets.has(pair.source.relativePath) ||
        !currentTargets.has(pair.preview.relativePath)
      )
        continue;
      if (
        boundDiagramSources(original).some(
          (g) => localReference(note.path, g.sourcePath) === pair.source.relativePath,
        )
      )
        continue;
      const source = readAsset(pair.source.relativePath).toString('utf8');
      if (sha256(source) !== pair.sourceHash) fail(409, 'DIAGRAM_SOURCE_CONFLICT');
      const result = prepare(
        source,
        pair.source.relativePath,
        pair.sourceHash,
        'embedded',
        'EXCALIDRAW',
        diagramRendererVersions.whiteboard,
        {},
        'pair:' + pair.source.relativePath,
      );
      if (result) {
        const substitutions = [
          {
            from: relocatePath(pair.source.relativePath, moves),
            to: result.prepared.source!.relativePath,
          },
          {
            from: relocatePath(pair.preview.relativePath, moves),
            to: result.prepared.preview.relativePath,
          },
        ];
        content = rewriteLibraryReferences(content, target, target, substitutions).content;
      }
    }
    if (content !== original)
      rewrites.set(note.id, {
        content,
        documentHash,
        documentModifiedAt: stamp.mtimeNs.toString(),
        snapshotIds,
        ...(primary ? { primary } : {}),
        ...(legacy ? { legacy } : {}),
      });
  }
  return { rewrites, needs };
}
export function planNativeLinkChanges(
  config: AppConfig,
  db: AppDatabase,
  p: Principal,
  moves: { from: string; to: string }[],
) {
  const { rewrites, needs } = collectNativeLinkChanges(config, db, p, moves);
  if (needs.length)
    fail(409, 'DIAGRAM_PREVIEW_REQUIRED', '请为操作计划的最终源码生成预览后继续', false, {
      planId: needs[0].snapshotId,
      documents: needs,
    });
  return rewrites;
}
