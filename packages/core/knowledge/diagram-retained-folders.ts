import { readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from '../../../shared/contracts.js';
import type { AppDatabase } from '../db.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import { safePath, validName } from '../files.js';
import { references, localReference } from '../render.js';
import { evidence, sameEvidence, type Evidence } from '../organization/plan.js';
import { revisionFileDigest } from './revision-identities.js';
import { fail } from './errors.js';
export type RetainedFolderResource = { id: string; path: string; hash: string; before: Evidence };
export type RetainedFolderDirectory = { path: string; before: Evidence; directoryId?: string };
const inside = (root: string, path: string) => path === root || path.startsWith(root + '/');
/** Live directory moves retain shared immutable assets at their proven original base. */
export function planRetainedFolderResources(
  config: AppConfig,
  db: AppDatabase,
  p: Principal,
  moves: { from: string; to: string; directory?: boolean }[],
) {
  const roots = moves.filter((m) => m.directory).map((m) => m.from);
  if (!roots.length) return [] as RetainedFolderResource[];
  const notes = db.prepare('SELECT id,path,active,trash_path FROM notes').all() as {
      id: string;
      path: string;
      active: number;
      trash_path?: string;
    }[],
    own = new Set(
      notes.filter((n) => n.active && roots.some((r) => inside(r, n.path))).map((n) => n.id),
    ),
    assets = db.prepare('SELECT id,path FROM assets').all() as { id: string; path: string }[],
    byPath = new Map(assets.map((a) => [a.path, a])),
    byId = new Map(assets.map((a) => [a.id, a])),
    wanted = new Map<string, string | undefined>();
  const keep = (path: string, hash?: string, id?: string) => {
    const asset = id ? byId.get(id) : byPath.get(path);
    if (!asset || !roots.some((r) => inside(r, asset.path))) return;
    if (hash && wanted.has(asset.path) && wanted.get(asset.path) && wanted.get(asset.path) !== hash)
      fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
    wanted.set(asset.path, hash ?? wanted.get(asset.path));
  };
  for (const row of db.prepare('SELECT note_id,manifest FROM diagram_document_versions').all() as {
    note_id: string;
    manifest: string;
  }[])
    if (!own.has(row.note_id))
      for (const r of JSON.parse(row.manifest).resources ?? []) keep(r.path, r.hash, r.assetId);
  for (const row of db.prepare('SELECT * FROM revisions').all() as any[])
    if (!own.has(row.note_id)) {
      for (const r of row.resources_manifest ? JSON.parse(row.resources_manifest) : [])
        keep(r.path, r.hash, r.assetId);
      if (row.references_manifest) {
        const proof = JSON.parse(row.references_manifest);
        if (proof.version === 1 && proof.complete)
          for (const r of proof.items ?? []) if (r.assetId) keep(r.path, r.hash, r.assetId);
      }
    }
  const fromBody = (body: string, logical: string) => {
    for (const url of references(body)) {
      const path = localReference(logical, url);
      if (path) keep(path);
    }
  };
  for (const note of notes.filter((n) => !own.has(n.id) && (n.active || n.trash_path))) {
    let file: string;
    if (note.active) file = safePath(config.knowledgeRoot, note.path, 'note');
    else {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(note.id) || !validName(note.trash_path!))
        fail(409, 'DIAGRAM_RESOURCES_RETAINED');
      file = safePath(
        join(config.knowledgeRoot, '90-Archive/.trash', note.id),
        note.trash_path!,
        'note',
      );
    }
    if (lstatSync(file).size > 20 * 1024 * 1024) fail(413, 'FILE_TOO_LARGE');
    fromBody(readFileSync(file, 'utf8'), note.path);
  }
  for (const folder of db
    .prepare("SELECT id,path,notes_json FROM folder_trash WHERE state='trashed'")
    .all() as { id: string; path: string; notes_json: string }[]) {
    if (!/^folder-[a-f0-9-]{36}$/.test(folder.id)) fail(409, 'DIAGRAM_RESOURCES_RETAINED');
    const root = join(config.knowledgeRoot, '90-Archive/.trash', folder.id, 'tree');
    for (const note of JSON.parse(folder.notes_json) as { id: string; path: string }[]) {
      if (own.has(note.id)) continue;
      const file = safePath(root, note.path.slice(folder.path.length + 1), 'note');
      if (lstatSync(file).size > 20 * 1024 * 1024) fail(413, 'FILE_TOO_LARGE');
      fromBody(readFileSync(file, 'utf8'), note.path);
    }
  }
  return [...wanted].map(([path, expected]) => {
    const asset = byPath.get(path)!;
    const file = safePath(config.knowledgeRoot, path, 'asset'),
      hash = revisionFileDigest(file),
      before = evidence(file, hash);
    if (expected && expected !== hash) fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
    return { id: asset.id, path, hash, before };
  });
}
export function verifyRetainedFolderResources(
  config: AppConfig,
  db: AppDatabase,
  resources: RetainedFolderResource[],
  exact = true,
) {
  for (const r of resources) {
    const row = db.prepare('SELECT path FROM assets WHERE id=?').get(r.id) as
      | { path: string }
      | undefined;
    if (row?.path !== r.path) fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
    const file = safePath(config.knowledgeRoot, r.path, 'asset');
    if (revisionFileDigest(file) !== r.hash || (exact && !sameEvidence(evidence(file), r.before)))
      fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
  }
}
