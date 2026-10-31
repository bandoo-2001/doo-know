import { constants, openSync, closeSync, fstatSync, readSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { AppConfig } from '../../../shared/contracts.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import type { AppDatabase } from '../db.js';
import type { DiagramVersionResource } from './diagram-publications.js';
import type { FileChange } from '../organization/plan.js';
import { safePath } from '../files.js';
import { localReference } from '../render.js';
import { canAccessPath } from '../agent/auth.js';
import { parseWhiteboard } from '../../../shared/whiteboard.js';
import type { DiagramArtifacts } from './diagram-artifacts.js';
import { scanRevisionDestinations } from './revision-relocation.js';
import { fileVersionStamp } from './file-reader.js';
import { limits } from './limits.js';
import { fail } from './errors.js';
export type RevisionResource = DiagramVersionResource & { assetId?: string };
export type RevisionReference = {
  path: string;
  noteId?: string;
  assetId?: string;
  hash?: string;
  native?: true;
  previewPath?: string;
};
export type RevisionReferences = { version: 1; complete: boolean; items: RevisionReference[] };
type RecordedChange = FileChange & { recordedAt: number; status: string };
function recordedObjects(db: AppDatabase) {
  const values: RecordedChange[] = [];
  for (const row of db
    .prepare(
      "SELECT j.manifest,o.created_at,o.status FROM organization_jobs j JOIN operations o ON o.id=j.id WHERE o.status IN ('committing','succeeded') AND j.manifest IS NOT NULL ORDER BY o.created_at,j.rowid",
    )
    .all() as { manifest: string; created_at: number; status: string }[]) {
    try {
      const m = JSON.parse(row.manifest);
      if (m.version === 1 && Array.isArray(m.objects))
        values.push(
          ...m.objects
            .filter(
              (o: any) =>
                o.kind === 'file' &&
                typeof o.id === 'string' &&
                typeof o.from === 'string' &&
                typeof o.to === 'string',
            )
            .map((o: FileChange) => ({ ...o, recordedAt: row.created_at, status: row.status })),
        );
    } catch {
      /* Invalid journals grant no identity evidence. */
    }
  }
  return values;
}
/** Hash original bytes in bounded reads, including media; never use an SVG presentation copy. */
export function revisionFileDigest(file: string) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw Error('asset');
    const digest = createHash('sha256'),
      buffer = Buffer.allocUnsafe(limits.io);
    let count: number;
    while ((count = readSync(fd, buffer)) > 0) digest.update(buffer.subarray(0, count));
    if (fileVersionStamp(before) !== fileVersionStamp(fstatSync(fd, { bigint: true })))
      throw Error('asset changed');
    return digest.digest('hex');
  } finally {
    closeSync(fd);
  }
}
function assetHash(config: AppConfig, path: string) {
  return revisionFileDigest(safePath(config.knowledgeRoot, path, 'asset'));
}
export function retainRevisionResourceIds(
  db: AppDatabase,
  resources: RevisionResource[],
  historicalSince?: number,
): RevisionResource[] {
  const objects = recordedObjects(db);
  return resources.map((resource) => {
    if (resource.assetId) return resource;
    const direct = db.prepare('SELECT id FROM assets WHERE path=?').get(resource.path) as
      | { id: string }
      | undefined;
    const moved = objects.find(
      (o) =>
        !o.note &&
        o.from === resource.path &&
        o.before.hash === resource.hash &&
        (historicalSince === undefined || o.recordedAt >= historicalSince),
    );
    const row = historicalSince === undefined ? (direct ?? moved) : (moved ?? direct);
    return row ? { ...resource, assetId: row.id } : resource;
  });
}
function assetLocation(
  config: AppConfig,
  db: AppDatabase,
  resource: { path: string; assetId?: string; hash?: string },
  objects = recordedObjects(db),
) {
  const row = resource.assetId
    ? (db.prepare('SELECT path FROM assets WHERE id=?').get(resource.assetId) as
        | { path: string }
        | undefined)
    : undefined;
  if (resource.assetId && !row) fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
  const candidates = [row?.path ?? resource.path];
  // During organization recording the filesystem is final while the registry is still historical.
  if (resource.assetId)
    for (const object of objects)
      if (
        object.status === 'committing' &&
        !object.note &&
        object.id === resource.assetId &&
        object.from === row?.path &&
        (!resource.hash || object.afterHash === resource.hash)
      )
        candidates.push(object.to);
  for (const path of [...new Set(candidates)].reverse()) {
    try {
      const hash = assetHash(config, path);
      if (!resource.hash || hash === resource.hash) return { path, hash };
    } catch {
      /* Try only exact recorded identity destinations. */
    }
  }
  return fail(409, 'DIAGRAM_ARTIFACT_CONFLICT', '历史版本的固定附件缺失或已变化');
}
export function revisionResourcePath(
  config: AppConfig,
  db: AppDatabase,
  resource: RevisionResource,
) {
  return assetLocation(config, db, retainRevisionResourceIds(db, [resource])[0]).path;
}
export function captureRevisionReferences(
  config: AppConfig,
  db: AppDatabase,
  noteId: string,
  logicalPath: string | null,
  file: string,
  resources: RevisionResource[],
  historicalSince?: number,
  expectedHash?: string,
): RevisionReferences {
  if (!logicalPath) return { version: 1, complete: false, items: [] };
  const scanned = scanRevisionDestinations(file),
    objects = recordedObjects(db),
    items = new Map<string, RevisionReference>();
  if (expectedHash && scanned.contentHash !== expectedHash) fail(409, 'REVISION_CONTENT_CONFLICT');
  let complete = scanned.complete;
  const add = (path: string) => {
    if (items.has(path)) return;
    if (path === logicalPath) {
      items.set(path, { path, noteId });
      return;
    }
    const moved = objects.find(
      (o) =>
        o.from === path &&
        o.from !== o.to &&
        (historicalSince === undefined || o.recordedAt >= historicalSince),
    );
    const directNote = db
      .prepare(
        'SELECT id FROM notes WHERE path=? AND active=1 UNION ALL SELECT note_id AS id FROM note_path_aliases WHERE path=? LIMIT 1',
      )
      .get(path, path) as { id: string } | undefined;
    const note =
      historicalSince !== undefined && moved?.note
        ? { id: moved.id }
        : (directNote ?? (moved?.note ? { id: moved.id } : undefined));
    if (note) {
      items.set(path, { path, noteId: note.id });
      return;
    }
    const directAsset = db.prepare('SELECT id FROM assets WHERE path=?').get(path) as
      | { id: string }
      | undefined;
    const asset =
      historicalSince !== undefined && moved && !moved.note
        ? { id: moved.id }
        : (directAsset ?? (moved && !moved.note ? { id: moved.id } : undefined));
    if (asset) {
      try {
        const fixedHash =
          resources.find((resource) => resource.path === path)?.hash ??
          scanned.nativeGroups.find(
            (group) => localReference(logicalPath, group.sourcePath) === path,
          )?.sourceHash ??
          (moved && !moved.note && moved.id === asset.id ? moved.before.hash : undefined);
        const located = assetLocation(
          config,
          db,
          {
            path,
            assetId: asset.id,
            ...(historicalSince !== undefined && fixedHash ? { hash: fixedHash } : {}),
          },
          objects,
        );
        if (historicalSince !== undefined && !fixedHash) complete = false;
        items.set(path, { path, assetId: asset.id, hash: located.hash });
      } catch {
        complete = false;
      }
      return;
    }
    items.set(path, { path });
  };
  for (const span of scanned.spans) {
    const path = localReference(logicalPath, span.url);
    if (path) add(path);
  }
  for (const group of scanned.nativeGroups) {
    const path = localReference(logicalPath, group.sourcePath);
    if (!path) {
      complete = false;
      continue;
    }
    add(path);
    const ref = items.get(path);
    if (!ref?.assetId || ref.hash !== group.sourceHash) {
      complete = false;
      continue;
    }
    ref.native = true;
    try {
      const current = assetLocation(config, db, ref, objects).path,
        scene = parseWhiteboard(
          readFileSync(safePath(config.knowledgeRoot, current, 'asset'), 'utf8'),
        );
      for (const element of scene.elements)
        if (typeof element.link === 'string') {
          const target = localReference(path, element.link);
          if (target) add(target);
        }
    } catch {
      complete = false;
    }
  }
  for (const row of db
    .prepare(
      "SELECT result FROM operations WHERE kind=? AND status='succeeded' AND result IS NOT NULL",
    )
    .all('diagram-artifacts:' + noteId) as { result: string }[]) {
    try {
      const pair = JSON.parse(row.result) as DiagramArtifacts,
        source = [...items.values()].find((ref) => ref.assetId === pair.source?.id),
        preview = [...items.values()].find((ref) => ref.assetId === pair.preview?.id);
      if (
        !source ||
        !preview ||
        source.hash !== pair.sourceHash ||
        !source.path.endsWith('.excalidraw') ||
        scanned.nativeGroups.some(
          (group) => localReference(logicalPath, group.sourcePath) === source.path,
        )
      )
        continue;
      source.native = true;
      source.previewPath = preview.path;
      const actual = assetLocation(config, db, source, objects).path,
        scene = parseWhiteboard(
          readFileSync(safePath(config.knowledgeRoot, actual, 'asset'), 'utf8'),
        );
      for (const element of scene.elements)
        if (typeof element.link === 'string') {
          const target = localReference(source.path, element.link);
          if (target) add(target);
        }
    } catch {
      complete = false;
    }
  }
  if (/\.excalidraw$/i.test(logicalPath))
    try {
      const scene = parseWhiteboard(readFileSync(file, 'utf8'));
      for (const element of scene.elements)
        if (typeof element.link === 'string') {
          const target = localReference(logicalPath, element.link);
          if (target) add(target);
        }
    } catch {
      complete = false;
    }
  for (const resource of resources) {
    items.set(resource.path, {
      path: resource.path,
      ...(resource.assetId ? { assetId: resource.assetId } : {}),
      hash: resource.hash,
    });
    if (resource.role === 'source')
      try {
        const path = assetLocation(config, db, resource, objects).path;
        // Native documents are bounded independently; a media attachment is never decoded here.
        const scene = parseWhiteboard(
          readFileSync(safePath(config.knowledgeRoot, path, 'asset'), 'utf8'),
        );
        for (const element of scene.elements)
          if (typeof element.link === 'string') {
            const target = localReference(resource.path, element.link);
            if (target) add(target);
          }
      } catch {
        complete = false;
      }
  }
  return { version: 1, complete, items: [...items.values()] };
}
export function revisionIdentityMapping(
  config: AppConfig,
  db: AppDatabase,
  references: RevisionReferences,
  principal?: Principal,
) {
  const mapping = new Map<string, string>();
  for (const ref of references.items) {
    if (ref.noteId) {
      const row = db.prepare('SELECT path FROM notes WHERE id=? AND active=1').get(ref.noteId) as
        | { path: string }
        | undefined;
      if (!row) fail(409, 'REVISION_REFERENCE_UNAVAILABLE');
      if (principal && !canAccessPath(principal, row.path)) fail(403, 'FORBIDDEN_REFERENCE');
      mapping.set(ref.path, row.path);
    } else if (ref.assetId || ref.hash) mapping.set(ref.path, assetLocation(config, db, ref).path);
  }
  return mapping;
}
