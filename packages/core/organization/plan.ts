import {
  lstatSync,
  openSync,
  closeSync,
  fstatSync,
  readFileSync,
  constants,
  readdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../../../shared/contracts.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import type { OrganizeInput, OrganizationResult } from '../../../shared/organization-contracts.js';
import type { AppDatabase } from '../db.js';
import { validName, safePath, scanFiles } from '../files.js';
import { isDocument, isWhiteboard } from '../../../shared/whiteboard.js';
import { fail } from '../knowledge/errors.js';
import { sha256 } from '../knowledge/operations.js';
import { canAccessPath, requireScope } from '../agent/auth.js';
import {
  syncDirectoryCatalog,
  resolveDirectory,
  directoryByPath,
  libraryIdentity,
} from './catalog.js';
import { rewriteLibraryReferences } from './references.js';
import { assertOrganizationReceiptFits } from './response-budget.js';
export const organizationLimits = {
  actions: 50,
  files: 1000,
  directories: 2000,
  bodyBytes: 128 * 1024 * 1024,
  assetBytes: 512 * 1024 * 1024,
};
export type Evidence = {
  dev: string;
  ino: string;
  birthtime: string;
  mtime: string;
  ctime: string;
  size: number;
  hash?: string;
};
export type FileChange = {
  kind: 'file';
  id: string;
  note: boolean;
  from: string;
  to: string;
  before: Evidence;
  afterHash: string;
  afterContent?: string;
  stage?: string;
  backup?: string;
  published?: Evidence;
  publication?: string;
};
export type DirectoryChange = {
  kind: 'directory';
  id: string;
  from?: string;
  to: string;
  before?: Evidence;
  published?: Evidence;
  business: boolean;
};
export type RemoveDirectory = {
  kind: 'remove_directory';
  id: string;
  from: string;
  before: Evidence;
};
export type Change = FileChange | DirectoryChange | RemoveDirectory;
export type Coverage = { path: string; id: string; hash: string; evidence: Evidence };
export type OrganizationManifest = {
  version: 1;
  operationId: string;
  libraryId: string;
  bindingVersion: number;
  structureRevision: string;
  graphRevision: string;
  inventory: string;
  coverage: Coverage[];
  objects: Change[];
  changes: OrganizationResult['changes'];
  permissions: Array<{ path: string; scope: string }>;
  undoOf?: string;
  resultRevision?: string;
  outputInventory?: string;
  outputCoverage?: Coverage[];
  outputContentInventory?: string;
};
export function evidence(path: string, hash?: string): Evidence {
  const s = lstatSync(path, { bigint: true });
  return {
    dev: String(s.dev),
    ino: String(s.ino),
    birthtime: String(s.birthtimeNs),
    mtime: String(s.mtimeNs),
    ctime: String(s.ctimeNs),
    size: Number(s.size),
    ...(hash ? { hash } : {}),
  };
}
export function sameIdentity(a: Evidence, b: Evidence) {
  return a.dev === b.dev && a.ino === b.ino && a.birthtime === b.birthtime;
}
export function sameEvidence(a: Evidence, b: Evidence) {
  return sameIdentity(a, b) && a.mtime === b.mtime && a.ctime === b.ctime && a.size === b.size;
}
export function readBody(config: AppConfig, path: string) {
  const file = safePath(config.knowledgeRoot, path, 'note');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n) fail(409, 'SOURCE_CHANGED');
    if (before.size > 20n * 1024n * 1024n) fail(413, 'FILE_TOO_LARGE');
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    const named = lstatSync(file, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      before.size !== after.size ||
      before.dev !== named.dev ||
      before.ino !== named.ino ||
      before.mtimeNs !== named.mtimeNs ||
      before.ctimeNs !== named.ctimeNs ||
      bytes.length !== Number(before.size)
    )
      fail(409, 'SOURCE_CHANGED');
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      fail(422, 'INVALID_UTF8');
    }
    return { content, hash: sha256(bytes), evidence: evidence(file, sha256(bytes)) };
  } finally {
    closeSync(fd);
  }
}
export function inventory(config: AppConfig) {
  const files = scanFiles(config.knowledgeRoot);
  return sha256(
    JSON.stringify([
      ...files.folders.map((path) => {
        const e = evidence(join(config.knowledgeRoot, path));
        return [path, e.dev, e.ino, e.birthtime];
      }),
      ...files.notes.map((path) => {
        const e = evidence(join(config.knowledgeRoot, path));
        return [path, e];
      }),
    ]),
  );
}
export function requireOrganization(p: Principal) {
  for (const scope of ['knowledge:read', 'knowledge:write', 'knowledge:organize'])
    requireScope(p, scope);
}
export function checkPermissions(p: Principal, permissions: OrganizationManifest['permissions']) {
  requireOrganization(p);
  for (const resource of permissions) {
    requireScope(p, resource.scope);
    if (!canAccessPath(p, resource.path)) fail(403, 'DEPENDENCY_FORBIDDEN');
  }
}
const contains = (a: string, b: string) => a === b || b.startsWith(a + '/');
const protectedContainer = (path: string) =>
  path === '' || path === '90-Archive' || path === '99-System';
function targetDirectory(db: AppDatabase, id: string | null) {
  if (id === null) return '';
  if (typeof id !== 'string' || !id) fail(400, 'INVALID_DIRECTORY');
  const dir = resolveDirectory(db, id);
  if (!dir) fail(404, 'DIRECTORY_NOT_FOUND');
  return dir.path;
}
const combine = (parent: string, name: string) => (parent ? `${parent}/${name}` : name);
export function prepareOrganization(
  config: AppConfig,
  db: AppDatabase,
  p: Principal,
  input: OrganizeInput,
  operationId: string,
): OrganizationManifest {
  requireOrganization(p);
  const state = syncDirectoryCatalog(config, db),
    binding = libraryIdentity(db)!;
  if (input.libraryId !== state.libraryId) fail(409, 'LIBRARY_BINDING_CHANGED');
  if (input.expectedStructureRevision !== state.structureRevision)
    fail(409, 'STRUCTURE_VERSION_CONFLICT');
  const permissions: OrganizationManifest['permissions'] = [],
    moves: Array<{ from: string; to: string; id: string; directory: boolean }> = [],
    creates: Array<{ id: string; to: string }> = [];
  const authorize = (path: string, scope: string) => {
    requireScope(p, scope);
    if (!canAccessPath(p, path)) fail(403, 'FORBIDDEN');
    permissions.push({ path, scope });
  };
  const destinations = new Set<string>();
  for (const action of input.actions) {
    if (action.type === 'create_directory') {
      if (!validName(action.name) || action.name === 'assets') fail(400, 'INVALID_DIRECTORY');
      const parent = targetDirectory(db, action.parentId),
        to = combine(parent, action.name);
      authorize(parent, 'knowledge:organize');
      authorize(to, 'knowledge:write');
      if (protectedContainer(to)) fail(400, 'PROTECTED_DIRECTORY');
      creates.push({ id: randomUUID(), to });
    } else if (action.type === 'move_note') {
      const n = db.prepare('SELECT id,path,active FROM notes WHERE id=?').get(action.noteId) as any;
      if (!n?.active) fail(404, 'NOT_FOUND');
      if (
        !validName(action.fileName) ||
        !isDocument(action.fileName) ||
        isWhiteboard(n.path) !== isWhiteboard(action.fileName)
      )
        fail(400, 'INVALID_INPUT');
      const parent = targetDirectory(db, action.toDirectoryId),
        to = combine(parent, action.fileName);
      authorize(n.path, 'knowledge:write');
      authorize(parent, 'knowledge:organize');
      authorize(to, 'knowledge:write');
      const source = readBody(config, n.path);
      if (
        source.hash !== action.expectedContentHash ||
        source.evidence.mtime !== action.expectedModifiedAt
      )
        fail(409, 'VERSION_CONFLICT');
      if (to !== n.path) moves.push({ from: n.path, to, id: n.id, directory: false });
    } else if (action.type === 'move_directory') {
      const d = resolveDirectory(db, action.directoryId);
      if (!d) fail(404, 'DIRECTORY_NOT_FOUND');
      if (protectedContainer(d.path)) fail(400, 'PROTECTED_DIRECTORY');
      if (d.subtreeRevision !== action.expectedSubtreeRevision)
        fail(409, 'SUBTREE_VERSION_CONFLICT');
      if (!validName(action.name) || action.name === 'assets') fail(400, 'INVALID_DIRECTORY');
      const parent = targetDirectory(db, action.toDirectoryId),
        to = combine(parent, action.name);
      if (contains(d.path, parent)) fail(409, 'DIRECTORY_CYCLE');
      if (protectedContainer(to)) fail(400, 'PROTECTED_DIRECTORY');
      authorize(d.path, 'knowledge:organize');
      authorize(parent, 'knowledge:organize');
      authorize(to, 'knowledge:write');
      if (d.path !== to) moves.push({ from: d.path, to, id: d.id, directory: true });
    } else fail(400, 'INVALID_ACTION');
  }
  for (let i = 0; i < moves.length; i++)
    for (let j = i + 1; j < moves.length; j++)
      if (
        contains(moves[i].from, moves[j].from) ||
        contains(moves[j].from, moves[i].from) ||
        contains(moves[i].to, moves[j].from) ||
        contains(moves[j].to, moves[i].from) ||
        contains(moves[i].to, moves[j].to) ||
        contains(moves[j].to, moves[i].to)
      )
        fail(409, 'OVERLAPPING_ACTIONS');
  for (const c of creates)
    for (const m of moves)
      if (
        contains(m.from, c.to) ||
        contains(m.to, c.to) ||
        contains(c.to, m.from) ||
        contains(c.to, m.to)
      )
        fail(409, 'OVERLAPPING_ACTIONS');
  for (const item of [...moves, ...creates]) {
    if (destinations.has(item.to)) fail(409, 'NAME_CONFLICT');
    destinations.add(item.to);
    try {
      lstatSync(join(config.knowledgeRoot, item.to));
      fail(409, 'NAME_CONFLICT');
    } catch (e) {
      if ((e as any).code !== 'ENOENT') throw e;
    }
  }
  const map = (path: string) => {
    const m = moves
      .filter((m) => contains(m.from, path))
      .sort((a, b) => b.from.length - a.from.length)[0];
    return m ? m.to + path.slice(m.from.length) : path;
  };
  const objects: Change[] = creates.map((c) => ({
    kind: 'directory',
    id: c.id,
    to: c.to,
    business: true,
  }));
  const assetRows = db.prepare('SELECT id,path FROM assets').all() as Array<{
    id: string;
    path: string;
  }>;
  const noteRows = db
    .prepare('SELECT id,path FROM notes WHERE active=1 ORDER BY path')
    .all() as Array<{ id: string; path: string }>;
  const noteByPath = new Map(noteRows.map((n) => [n.path, n]));
  const assetByPath = new Map(assetRows.map((a) => [a.path, a]));
  const movedFiles = new Map<string, { id: string; note: boolean }>();
  let assetBytes = 0,
    dirs = 0;
  const rootDev = String(lstatSync(config.knowledgeRoot, { bigint: true }).dev);
  for (const move of moves) {
    if (!move.directory) {
      movedFiles.set(move.from, { id: move.id, note: true });
      continue;
    }
    const walk = (path: string) => {
      const absolute = join(config.knowledgeRoot, path),
        s = lstatSync(absolute, { bigint: true });
      if (s.isSymbolicLink() || String(s.dev) !== rootDev) fail(400, 'UNSUPPORTED_OBJECT');
      if (s.isDirectory()) {
        if (++dirs > organizationLimits.directories) fail(413, 'ORGANIZATION_LIMIT');
        const d = directoryByPath(db, path);
        objects.push({
          kind: 'directory',
          id: d?.id || randomUUID(),
          from: path,
          to: map(path),
          before: evidence(absolute),
          business: !!d,
        });
        for (const name of readdirSync(absolute)) {
          if (!validName(name)) fail(400, 'UNSUPPORTED_OBJECT');
          walk(path + '/' + name);
        }
      } else if (s.isFile() && s.nlink === 1n) {
        const note = noteByPath.get(path),
          asset = assetByPath.get(path);
        if (!note && !asset) fail(400, 'UNSUPPORTED_OBJECT');
        if (asset) {
          assetBytes += Number(s.size);
          if (assetBytes > organizationLimits.assetBytes) fail(413, 'ORGANIZATION_LIMIT');
        }
        movedFiles.set(path, { id: (note || asset)!.id, note: !!note });
      } else fail(400, 'UNSUPPORTED_OBJECT');
    };
    walk(move.from);
  }
  const coverage: Coverage[] = [];
  let bodyBytes = 0;
  for (const n of moves.length ? noteRows : []) {
    const size = Number(
      lstatSync(safePath(config.knowledgeRoot, n.path, 'note'), { bigint: true }).size,
    );
    bodyBytes += size;
    if (bodyBytes > organizationLimits.bodyBytes) fail(413, 'ORGANIZATION_LIMIT');
    const body = readBody(config, n.path);
    coverage.push({ path: n.path, id: n.id, hash: body.hash, evidence: body.evidence });
    const target = map(n.path),
      rewrite = rewriteLibraryReferences(body.content, n.path, target, moves, isWhiteboard(n.path));
    if (target !== n.path || rewrite.changed) {
      permissions.push(
        { path: n.path, scope: 'knowledge:read' },
        { path: n.path, scope: 'knowledge:write' },
        { path: target, scope: 'knowledge:write' },
      );
      objects.push({
        kind: 'file',
        id: n.id,
        note: true,
        from: n.path,
        to: target,
        before: body.evidence,
        afterHash: sha256(rewrite.content),
        ...(rewrite.changed ? { afterContent: rewrite.content } : {}),
      });
    }
  }
  for (const [path, obj] of movedFiles)
    if (!obj.note) {
      const e = evidence(join(config.knowledgeRoot, path));
      permissions.push(
        { path, scope: 'knowledge:read' },
        { path: map(path), scope: 'knowledge:write' },
      );
      objects.push({
        kind: 'file',
        id: obj.id,
        note: false,
        from: path,
        to: map(path),
        before: e,
        afterHash: '',
      });
    }
  const fileCount = objects.filter((o) => o.kind === 'file').length;
  if (
    fileCount > organizationLimits.files ||
    objects.filter((o) => o.kind === 'directory').length > organizationLimits.directories
  )
    fail(413, 'ORGANIZATION_LIMIT');
  checkPermissions(p, permissions);
  const graphRevision = sha256(JSON.stringify(coverage.map((c) => [c.id, c.path, c.hash]))),
    snapshot = inventory(config);
  const manifest: OrganizationManifest = {
    version: 1,
    operationId,
    libraryId: state.libraryId,
    bindingVersion: binding.bindingVersion,
    structureRevision: state.structureRevision,
    graphRevision,
    inventory: snapshot,
    coverage,
    objects,
    permissions,
    changes: [
      ...creates.map((c) => ({ type: 'create_directory', id: c.id, to: c.to })),
      ...moves.map((m) => ({
        type: m.directory ? 'move_directory' : 'move_note',
        id: m.id,
        from: m.from,
        to: m.to,
      })),
    ],
  };
  assertOrganizationReceiptFits(manifest, input.requestId);
  revalidateManifest(config, db, p, manifest);
  return manifest;
}
export function revalidateManifest(
  config: AppConfig,
  db: AppDatabase,
  p: Principal,
  m: OrganizationManifest,
) {
  checkPermissions(p, m.permissions);
  const binding = libraryIdentity(db);
  if (!binding || binding.libraryId !== m.libraryId || binding.bindingVersion !== m.bindingVersion)
    fail(409, 'LIBRARY_BINDING_CHANGED');
  if (inventory(config) !== m.inventory) fail(409, 'STRUCTURE_VERSION_CONFLICT');
  for (const c of m.coverage) {
    const row = db.prepare('SELECT id,path,active FROM notes WHERE id=?').get(c.id) as any;
    if (!row?.active || row.path !== c.path) fail(409, 'SOURCE_CHANGED');
    const body = readBody(config, c.path);
    if (body.hash !== c.hash || !sameEvidence(body.evidence, c.evidence))
      fail(409, 'VERSION_CONFLICT');
  }
  for (const o of m.objects) {
    if (o.kind === 'directory') {
      if (
        o.from &&
        (!o.before || !sameEvidence(evidence(join(config.knowledgeRoot, o.from)), o.before))
      )
        fail(409, 'SOURCE_CHANGED');
      if (o.to !== o.from) {
        try {
          lstatSync(join(config.knowledgeRoot, o.to));
          fail(409, 'NAME_CONFLICT');
        } catch (e) {
          if ((e as any).code !== 'ENOENT') throw e;
        }
      }
    } else if (o.kind === 'file') {
      if (!sameEvidence(evidence(join(config.knowledgeRoot, o.from)), o.before))
        fail(409, 'VERSION_CONFLICT');
    }
  }
}
