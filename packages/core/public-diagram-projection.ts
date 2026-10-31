import { mediaMime } from '../../shared/media.js';
import { assetStamp, hashAssetSync } from './asset-stream.js';
import { posix } from 'node:path';
import MarkdownIt from 'markdown-it';
import type { AppConfig, NoteDocument } from '../../shared/contracts.js';
import type { DiagramResource } from '../../shared/diagram-resource.js';
import { diagramResourceSchema } from '../../shared/diagram-resource.js';
import { parseDiagramDocument } from '../../shared/diagram-document.js';
import { whiteboardReference } from '../../shared/whiteboard.js';
import { boundDiagramSources, normalizeDiagramCode } from '../../shared/diagram-portability.js';
import type { AppDatabase } from './db.js';
import type { NoteService } from './notes.js';
import type { assetService } from './assets.js';
import type { shareService } from './shares.js';
import { localReference, references, renderMarkdownReferences } from './render.js';
import {
  resolvePrimaryDiagram,
  resolveWhiteboardResource,
} from './knowledge/diagram-resource-resolver.js';
import { webPrincipal } from './knowledge/core.js';
import { sha256 } from './knowledge/operations.js';
import { fail, KnowledgeError } from './knowledge/errors.js';
import { readBoundDiagramAssetSnapshot } from './knowledge/diagram-resource-files.js';
import { assertNoEmbeddedDiagramSource, validatePng } from './knowledge/diagram-artifacts.js';
import { renderPortableImage } from '../../shared/portable-figure.js';
import { hasDiagramDeclarationSync } from './knowledge/diagram-declaration.js';

export type ProjectionAsset = {
  path: string;
  hash: string;
  role: 'source' | 'preview' | 'ordinary';
};
export type PublicProjection = {
  note: NoteDocument;
  content: string;
  assets: Map<string, ProjectionAsset>;
  resource?: DiagramResource;
  embedded: Map<string, DiagramResource>;
  fingerprint: string;
  allowDiagramSource: boolean;
  policyRevision: number;
};
const parser = new MarkdownIt({ html: true });
/** Delete parser-owned regions, including automatic summaries, preserving author explanation bytes. */
export function projectPrimaryMarkdown(content: string, previewUrl: string) {
  const parsed = parseDiagramDocument(content);
  if (parsed.status !== 'diagram') fail(422, 'INVALID_DIAGRAM_DOCUMENT');
  const edits = [
    { ...parsed.markerRange, text: '' },
    { ...parsed.primary.range, text: renderPortableImage('图形预览', previewUrl) + '\n' },
  ];
  for (const edit of edits.sort((a, b) => b.from - a.from))
    content = content.slice(0, edit.from) + edit.text + content.slice(edit.to);
  return content;
}
export function requirePublicPreview(resource: DiagramResource) {
  if (resource.preview?.state !== 'ready')
    fail(409, 'DIAGRAM_PREVIEW_REQUIRED', '请由所有者准备当前图形的固定 PNG 预览', false, {
      documents: [
        {
          noteId: resource.noteId,
          role: resource.role,
          documentHash: resource.documentHash,
          sourceHash: resource.source.hash,
          renderHash: resource.preview?.renderHash ?? '0'.repeat(64),
        },
      ],
    });
}
export function publicDiagramProjectionService(
  config: AppConfig,
  db: AppDatabase,
  notes: NoteService,
  assets: ReturnType<typeof assetService>,
  shares: ReturnType<typeof shareService>,
) {
  const policyRevision = (token: string) => {
    const note = shares.lookup(token);
    return (
      db.prepare('SELECT policy_revision FROM shares WHERE note_id=?').get(note.id) as {
        policy_revision: number;
      }
    ).policy_revision;
  };
  const checkPolicy = (token: string, expected: number) => {
    if (policyRevision(token) !== expected) fail(409, 'SHARE_POLICY_CHANGED');
  };
  function project(token: string): PublicProjection {
    const revision = policyRevision(token),
      note = shares.document(token),
      access = shares.access(token),
      allowDiagramSource = !!access.allowDiagramSource,
      allowed = new Map<string, ProjectionAsset>(),
      embedded = new Map<string, DiagramResource>(),
      versions: string[] = [];
    const add = (path: string, hash: string, role: ProjectionAsset['role']) => {
      const old = allowed.get(path);
      if (old && old.hash !== hash) fail(409, 'DIAGRAM_RESOURCE_CONFLICT');
      if (!old || role === 'source' || old.role === 'ordinary')
        allowed.set(path, { path, hash, role });
    };
    const rebase = (childPath: string, path: string) => {
      const absolute = localReference(childPath, path);
      if (!absolute) fail(409, 'DIAGRAM_RESOURCE_CONFLICT');
      return { absolute, relative: posix.relative(posix.dirname(note.relativePath), absolute) };
    };
    const safe = (
      resource: DiagramResource,
      childPath: string,
      role: 'primary' | 'embedded',
    ): DiagramResource => {
      requirePublicPreview(resource);
      const preview = rebase(childPath, resource.preview!.path);
      add(preview.absolute, resource.preview!.hash, 'preview');
      versions.push(
        JSON.stringify([
          resource.noteId,
          resource.documentHash,
          resource.source.hash,
          resource.preview!.hash,
          resource.preview!.renderHash,
        ]),
      );
      const source: DiagramResource['source'] = {
        format: resource.source.format,
        hash: resource.source.hash,
      };
      if (allowDiagramSource && resource.capabilities.canDownloadSource) {
        if (resource.source.content !== undefined) source.content = resource.source.content;
        if (resource.source.path) {
          const native = rebase(childPath, resource.source.path);
          source.path = native.relative;
          add(native.absolute, resource.source.hash, 'source');
        }
      }
      return diagramResourceSchema.parse({
        version: 1,
        noteId: resource.noteId,
        documentType: resource.documentType,
        role,
        title: resource.title,
        documentHash: resource.documentHash,
        source,
        preview: { ...resource.preview, path: preview.relative },
        capabilities: {
          canEdit: false,
          canDownloadSource: source.content !== undefined || source.path !== undefined,
        },
      });
    };
    let content = note.content,
      resource: DiagramResource | undefined;
    // Semantic classification uses actual current/last-complete bytes, never the document_state cache.
    const parsed = parseDiagramDocument(note.content),
      legacy = /\.excalidraw$/i.test(note.relativePath);
    if (parsed.status === 'invalid')
      fail(422, 'INVALID_DIAGRAM_DOCUMENT', '图形声明无效，请由所有者恢复原文');
    if (legacy || parsed.status === 'diagram') {
      const privateResource = resolvePrimaryDiagram(config, db, notes, webPrincipal, note.id);
      resource = safe(privateResource, note.relativePath, 'primary');
      content = legacy
        ? `# ${note.title.replace(/[\r\n]/g, ' ')}\n\n${renderPortableImage('图形预览', resource.preview!.path)}\n`
        : projectPrimaryMarkdown(content, resource.preview!.path);
    }
    const original = content,
      starts = [0];
    for (let i = 0; i < original.length; i++) if (original[i] === '\n') starts.push(i + 1);
    const changes: { from: number; to: number; text: string }[] = [],
      groups = boundDiagramSources(original);
    for (const t of parser.parse(original, {})) {
      if (t.type !== 'fence' || t.info.trim() !== 'excalidraw' || !t.map) continue;
      const ref = whiteboardReference(t.content);
      if (!ref) continue;
      const from = starts[t.map[0]],
        to = starts[t.map[1]] ?? original.length;
      const owner = resolveWhiteboardResource(
          config,
          db,
          notes,
          webPrincipal,
          note.relativePath,
          ref,
        ),
        child = notes.row(owner.noteId);
      owner.role = 'embedded';
      // Legacy portable bindings may prove a fixed PNG for this exact scene and exact reference code.
      if (owner.preview?.state !== 'ready' && /\.excalidraw$/i.test(child.path)) {
        const group = groups.find((g) => g.from === from);
        if (
          group &&
          group.binding.kind === 'excalidraw' &&
          group.binding.codeHash === sha256(normalizeDiagramCode(t.content)) &&
          group.binding.sourceHash === owner.source.hash
        ) {
          const native = localReference(note.relativePath, group.sourcePath),
            preview = localReference(note.relativePath, group.previewPath);
          try {
            if (!native || !preview) throw Error();
            const sourceBytes = readBoundDiagramAssetSnapshot(config, native, 'source').bytes,
              png = readBoundDiagramAssetSnapshot(config, preview, 'preview').bytes;
            validatePng(png);
            if (sha256(sourceBytes) !== owner.source.hash) throw Error();
            // v1 portable comments contain no PNG hash. A durable upload receipt must
            // independently prove this exact source/PNG pair; hashing today's PNG alone
            // would silently bless an externally replaced preview.
            const previewHash = sha256(png),
              prefix = 'diagram-artifacts:';
            const receipts = db
              .prepare(
                "SELECT kind,params_hash FROM operations WHERE kind LIKE 'diagram-artifacts:%' AND status='succeeded' AND json_extract(result,'$.source.relativePath')=? AND json_extract(result,'$.preview.relativePath')=? AND json_extract(result,'$.sourceHash')=?",
              )
              .all(native, preview, owner.source.hash) as { kind: string; params_hash: string }[];
            if (
              !receipts.some(
                (receipt) =>
                  receipt.params_hash ===
                  sha256(
                    JSON.stringify({
                      kind: 'excalidraw',
                      noteId: receipt.kind.slice(prefix.length),
                      previewHash,
                      sourceHash: owner.source.hash,
                    }),
                  ),
              )
            )
              throw Error();
            owner.preview = {
              path: posix.relative(posix.dirname(child.path), preview),
              hash: previewHash,
              renderHash: sha256(JSON.stringify(group.binding)),
              state: 'ready',
            };
          } catch {
            /* The absence of a valid proof remains preview-required. */
          }
        }
      }
      const view = safe(owner, child.path, 'embedded');
      embedded.set(ref, view);
      changes.push({
        from: groups.find((g) => g.from === from)?.prefixFrom ?? from,
        to,
        text: renderPortableImage('白板预览', view.preview!.path) + '\n',
      });
    }
    for (const change of changes.sort((a, b) => b.from - a.from))
      content = content.slice(0, change.from) + change.text + content.slice(change.to);
    // Ordinary Markdown retains inline SVG/Mermaid rendering; native source attachments need an explicit, proven role.
    for (const url of references(content)) {
      const path = localReference(note.relativePath, url);
      if (!path) continue;
      if (allowed.has(path)) continue;
      if (/\.(?:excalidraw|mmd)$/i.test(path)) {
        // A repeated link to a primary native source never adds a capability.
        if (allowDiagramSource) {
          const group = groups.find(
            (g) => localReference(note.relativePath, g.sourcePath) === path,
          );
          if (group) {
            try {
              const a = assets.file(path);
              if (sha256(a.sourceBytes ?? a.bytes) === group.binding.sourceHash)
                add(path, group.binding.sourceHash, 'source');
            } catch {}
          }
        }
        continue;
      }
      try {
        if (mediaMime(path)) {
          const a = assets.inspect(path);
          add(path, hashAssetSync(a.absolutePath), 'ordinary');
        } else {
          const a = assets.file(path);
          assertNoEmbeddedDiagramSource(a.bytes);
          add(path, sha256(a.sourceBytes ?? a.bytes), 'ordinary');
        }
      } catch {}
    }
    checkPolicy(token, revision);
    const fingerprint = sha256(
      JSON.stringify([
        'public-projection-v1',
        note.id,
        sha256(note.content),
        revision,
        access,
        versions,
        [...allowed.values()],
        sha256(content),
      ]),
    );
    return {
      note,
      content,
      resource,
      embedded,
      assets: allowed,
      fingerprint,
      allowDiagramSource,
      policyRevision: revision,
    };
  }
  function resource(token: string, reference?: string) {
    if (reference !== undefined) {
      const note = shares.document(token),
        parsed = parseDiagramDocument(note.content);
      const self =
        reference === note.id &&
        (/\.excalidraw$/i.test(note.relativePath) ||
          (parsed.status === 'diagram' && parsed.type === 'whiteboard'));
      if (!self && !renderMarkdownReferences(note.content).includes(reference))
        fail(404, 'WHITEBOARD_NOT_FOUND');
    }
    const projection = project(token);
    if (reference === undefined) {
      if (!projection.resource) fail(404, 'DIAGRAM_NOT_FOUND');
      return projection.resource;
    }
    const ref = whiteboardReference(reference);
    if (!ref) fail(404, 'WHITEBOARD_NOT_FOUND');
    if (projection.resource?.documentType === 'whiteboard' && reference === projection.note.id)
      return projection.resource;
    const found = projection.embedded.get(ref);
    if (!found) fail(404, 'WHITEBOARD_NOT_FOUND');
    return found;
  }
  async function asset(token: string, lookup: { id?: string; source?: string }) {
    let projection: PublicProjection;
    try {
      projection = project(token);
    } catch (error) {
      if (!(error instanceof KnowledgeError) || error.code !== 'LARGE_FILE_MODE_REQUIRED')
        throw error;
      const revision = policyRevision(token),
        note = shares.lookup(token);
      // A size-mode failure grants no diagram capability. Only actual ordinary
      // parents may use the bounded saved-reference scanner, which also denies
      // native originals independently of links or the share's source option.
      if (
        /\.excalidraw$/i.test(note.path) ||
        hasDiagramDeclarationSync(notes.readableSource(note.id).file)
      )
        fail(422, 'INVALID_DIAGRAM_DOCUMENT');
      if (
        (lookup.id && mediaMime(assets.inspectById(lookup.id).path)) ||
        (lookup.source && mediaMime(lookup.source))
      ) {
        const descriptor = await assets.publicInspect(note.id, lookup),
          parent = notes.readableSource(note.id).file,
          parentStamp = assetStamp(parent);
        checkPolicy(token, revision);
        return {
          ...descriptor,
          check: () => {
            checkPolicy(token, revision);
            if (assetStamp(parent) !== parentStamp) fail(409, 'SHARE_POLICY_CHANGED');
          },
        };
      }
      const ordinary = lookup.id
        ? await assets.publicAsset(note.id, lookup.id)
        : await assets.publicSource(note.id, lookup.source ?? '');
      assertNoEmbeddedDiagramSource(ordinary.bytes);
      checkPolicy(token, revision);
      return ordinary;
    }
    const path = lookup.id
      ? (
          db.prepare('SELECT path FROM assets WHERE id=?').get(lookup.id) as
            | { path: string }
            | undefined
        )?.path
      : localReference(projection.note.relativePath, lookup.source ?? '');
    if (!path) fail(404, 'ASSET_NOT_FOUND');
    const proof = projection.assets.get(path);
    if (!proof) {
      if (/\.(?:excalidraw|mmd)$/i.test(path)) fail(403, 'DIAGRAM_SOURCE_FORBIDDEN');
      fail(404, 'ASSET_NOT_FOUND');
    }
    if (proof.role === 'source' && !projection.allowDiagramSource)
      fail(403, 'DIAGRAM_SOURCE_FORBIDDEN');
    if (mediaMime(path)) {
      const descriptor = assets.inspect(path),
        parent = notes.readableSource(projection.note.id).file,
        parentStamp = assetStamp(parent);
      if (hashAssetSync(descriptor.absolutePath) !== proof.hash)
        fail(409, 'DIAGRAM_RESOURCE_CONFLICT');
      checkPolicy(token, projection.policyRevision);
      return {
        ...descriptor,
        check: () => {
          checkPolicy(token, projection.policyRevision);
          if (assetStamp(parent) !== parentStamp) fail(409, 'SHARE_POLICY_CHANGED');
        },
      };
    }
    const file = assets.file(path);
    assertNoEmbeddedDiagramSource(file.bytes);
    if (sha256(file.sourceBytes ?? file.bytes) !== proof.hash)
      fail(409, 'DIAGRAM_RESOURCE_CONFLICT');
    checkPolicy(token, projection.policyRevision);
    return { path, ...file };
  }
  return { project, resource, asset };
}
