import { captureFolderTree, folderTreeDigest, verifyFolderTree, type FolderTreeEntry } from './folder-restore-tree.js';
import { canAccessPath, requireScope, authorizePath } from '../agent/auth.js';
import { recordOperationRevision } from './operation-revisions.js';
import { evidence, sameEvidence, type Evidence } from '../organization/plan.js';
import { inventory } from '../organization/plan.js';
import { mkdirSync, readFileSync, writeFileSync, renameSync, lstatSync, existsSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { AppConfig } from '../../../shared/contracts.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import type { AppDatabase } from '../db.js';
import { safePath } from '../files.js';
import { fsyncDirectory, enqueueSource } from './core.js';
import { sha256 } from './operations.js';
import { fail } from './errors.js';
import { archivedTreeInventory, type ArchivedDiagramContext } from './archived-diagram-context.js';
import { collectNativeLinkChanges } from './native-link-plans.js';
import { diagramOperationPreviewRegistry } from './diagram-operation-previews.js';
import { planDiagramRelocation, relocatePath, type DiagramRelocation } from './diagram-relocation.js';
import { readBoundDiagramAsset } from './diagram-resource-files.js';
import type { PreparedDiagramAsset } from '../../../shared/diagram-primary.js';
export type FolderNativeRestorePlan = {
  version: 1;
  operationId: string;
  folderId: string;
  from: string;
  to: string;
  identity: string;
  inventory: string;
  activeInventory: string;
  phase: 'prepared' | 'applying' | 'applied';
  treeBefore?: FolderTreeEntry[];
  treeAfter?: string;
  fixedResources?: Record<string, { id: string; hash: string }>;
  files: {
    noteId: string;
    path: string;
    active?: boolean;
    beforeHash: string;
    beforeEvidence: Evidence;
    originalModifiedAt?: string;
    publicationEvidence?: Evidence;
    publicationMode?: string;
    afterHash: string;
    backup: string;
    stage: string;
  }[];
  assets: { asset: PreparedDiagramAsset; stage: string; hash: string }[];
  diagrams: DiagramRelocation[];

};
function schema(db: AppDatabase) {
  db.exec(
    'CREATE TABLE IF NOT EXISTS folder_native_restore_plans(operation_id TEXT PRIMARY KEY,folder_id TEXT NOT NULL,plan TEXT NOT NULL)',
  );
}
function store(db: AppDatabase, plan: FolderNativeRestorePlan) {
  db.prepare(
    'INSERT INTO folder_native_restore_plans(operation_id,folder_id,plan) VALUES(?,?,?) ON CONFLICT(operation_id) DO UPDATE SET plan=excluded.plan',
  ).run(plan.operationId, plan.folderId, JSON.stringify(plan));
}
function writePrivate(path: string, bytes: string | Buffer) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path)) {
    const s = lstatSync(path);
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1) fail(409, 'TRASH_CHANGED');
    if (sha256(readFileSync(path)) !== sha256(bytes)) fail(409, 'TRASH_CHANGED');
    return;
  }
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDirectory(dirname(path));
  fsyncDirectory(dirname(dirname(path)));
}
export function getFolderNativeRestorePlan(db: AppDatabase, operationId: string) {
  const exists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE name='folder_native_restore_plans'")
    .get();
  if (!exists) return;
  const row = db
    .prepare('SELECT plan FROM folder_native_restore_plans WHERE operation_id=?')
    .get(operationId) as { plan: string } | undefined;
  return row ? (JSON.parse(row.plan) as FolderNativeRestorePlan) : undefined;
}
export function prepareFolderNativeRestore(
  config: AppConfig,
  db: AppDatabase,
  p: Principal,
  input: {
    folderId: string;
    from: string;
    to: string;
    identity: string;
    physicalRoot: string;
    operationId: string;
    notes: { id: string; path: string }[];
  },
) {
  schema(db);
  mkdirSync(join(config.dataRoot, 'folder-restores'), { recursive: true, mode: 0o700 });
  fsyncDirectory(config.dataRoot);
  const activeInventory = inventory(config);
  const moves = [{ from: input.from, to: input.to }],
    archive: ArchivedDiagramContext = {
      folderId: input.folderId,
      logicalRoot: input.from,
      identity: input.identity,
      inventory: archivedTreeInventory(input.physicalRoot),
    };
  const originalAsset: typeof readBoundDiagramAsset = (cfg, path, role) =>
    path.startsWith(input.from + '/')
      ? readBoundDiagramAsset(
          { ...cfg, knowledgeRoot: input.physicalRoot },
          path.slice(input.from.length + 1),
          role,
        )
      : readBoundDiagramAsset(cfg, path, role);
  for (const note of input.notes) {
    const before = readFileSync(
      safePath(input.physicalRoot, note.path.slice(input.from.length + 1), 'note'),
      'utf8',
    );
    const original = planDiagramRelocation(
      config,
      db,
      note.id,
      before,
      before,
      note.path,
      note.path,
      [],
      originalAsset,
    );
    if (
      !original &&
      db
        .prepare('SELECT 1 FROM diagram_document_versions WHERE note_id=? AND path=?')
        .get(note.id, note.path)
    )
      fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
  }
  const archivedChanges = collectNativeLinkChanges(config, db, p, moves, {
    notes: input.notes,
    archive,
  });
  const activeNotes = db
    .prepare('SELECT id,path FROM notes WHERE active=1 ORDER BY path')
    .all() as { id: string; path: string }[];
  const activeMoves = input.notes
    .filter((n) => !activeNotes.some((a) => a.path === n.path))
    .map((n) => ({ from: n.path, to: relocatePath(n.path, moves) }));
  const activeChanges = collectNativeLinkChanges(config, db, p, activeMoves);
  for (const [id] of activeChanges.rewrites) {
    const note = activeNotes.find((n) => n.id === id)!;
    requireScope(p, 'knowledge:read');
    requireScope(p, 'knowledge:write');
    if (!canAccessPath(p, note.path)) fail(403, 'DEPENDENCY_FORBIDDEN');
  }
  const rewrites = new Map([...archivedChanges.rewrites, ...activeChanges.rewrites]),
    needs = [...archivedChanges.needs, ...activeChanges.needs];
  if (needs.length)
    fail(409, 'DIAGRAM_PREVIEW_REQUIRED', '请为恢复目录的最终原生源码准备预览', false, {
      planId: needs[0].snapshotId,
      documents: needs,
    });
  const plan: FolderNativeRestorePlan = {
      version: 1,
      operationId: input.operationId,
      folderId: input.folderId,
      from: input.from,
      to: input.to,
      identity: input.identity,
      inventory: archive.inventory,
      activeInventory,
      phase: 'prepared',
      treeBefore: captureFolderTree(input.physicalRoot),
      files: [],
      assets: [],
      diagrams: [],

    },
    registry = diagramOperationPreviewRegistry(config, db, p);
  for (const rewrite of rewrites.values())
    for (const id of rewrite.snapshotIds ?? []) {
      const fixed = registry.get(id);
      if (!fixed.input.archive) continue;
      const prepared = registry.prepared(id)!;
      for (const [role, asset, hash] of [
        ['source', prepared.source, prepared.sourceHash],
        ['preview', prepared.preview, prepared.previewHash],
      ] as const)
        if (asset && !plan.assets.some((a) => a.asset.relativePath === asset.relativePath))
          plan.assets.push({
            asset: { ...asset, relativePath: relocatePath(asset.relativePath, moves) },
            stage: join('diagram-operation-previews', id, role),
            hash,
          });
    }
  plan.fixedResources = {};
  for (const asset of db.prepare('SELECT id,path FROM assets').all() as {
    id: string;
    path: string;
  }[]) {
    if (asset.path.startsWith(input.from + '/')) {
      const path = asset.path.slice(input.from.length + 1),
        entry = plan.treeBefore!.find((e) => e.path === path && e.kind === 'file');
      if (entry?.hash) plan.fixedResources[path] = { id: asset.id, hash: entry.hash };
    }
  }
  for (const asset of plan.assets)
    plan.fixedResources[asset.asset.relativePath.slice(plan.to.length + 1)] = {
      id: asset.asset.id,
      hash: asset.hash,
    };
  const readAssetFor =
    (archived: boolean): typeof readBoundDiagramAsset =>
    (cfg, path, role) => {
      const staged = plan.assets.find((a) => a.asset.relativePath === relocatePath(path, moves));
      if (staged) return readFileSync(join(config.dataRoot, staged.stage));
      return archived && path.startsWith(input.from + '/')
        ? readBoundDiagramAsset(
            { ...cfg, knowledgeRoot: input.physicalRoot },
            path.slice(input.from.length + 1),
            role,
          )
        : readBoundDiagramAsset(cfg, path, role);
    };
  const allNotes = [...input.notes, ...activeNotes.filter((n) => rewrites.has(n.id))];
  for (const note of allNotes) {
    const archived = input.notes.some((n) => n.id === note.id),
      relative = archived ? note.path.slice(input.from.length + 1) : note.path,
      file = safePath(archived ? input.physicalRoot : config.knowledgeRoot, relative, 'note'),
      before = readFileSync(file, 'utf8'),
      rewrite = rewrites.get(note.id),
      after = rewrite?.content ?? before,
      noteMoves = archived ? moves : activeMoves;
    const diagram = planDiagramRelocation(
      config,
      db,
      note.id,
      before,
      after,
      note.path,
      relocatePath(note.path, noteMoves),
      noteMoves,
      readAssetFor(archived),
      rewrite?.primary,
    );
    if (diagram) plan.diagrams.push(diagram);

    if (after !== before) {
      const index = plan.files.length,
        backup = join('folder-restores', input.operationId, index + '.before'),
        stage = join('folder-restores', input.operationId, index + '.after');
      writePrivate(join(config.dataRoot, backup), before);
      writePrivate(join(config.dataRoot, stage), after);
      plan.files.push({
        noteId: note.id,
        path: relative,
        ...(!archived ? { active: true } : {}),
        beforeHash: sha256(before),
        beforeEvidence: evidence(file),
        afterHash: sha256(after),
        backup,
        stage,
      });
    }
  }
  if (archivedTreeInventory(input.physicalRoot) !== plan.inventory) fail(409, 'TRASH_CHANGED');
  if (inventory(config) !== plan.activeInventory) fail(409, 'STRUCTURE_VERSION_CONFLICT');
  store(db, plan);
  return plan;
}
/** Resume only the frozen private after-images, never recompute sources after mutation. */
export function applyFolderNativeRestore(
  config: AppConfig,
  db: AppDatabase,
  plan: FolderNativeRestorePlan,
  physicalRoot: string,
) {
  if (plan.phase === 'prepared') {
    if (inventory(config) !== plan.activeInventory) fail(409, 'STRUCTURE_VERSION_CONFLICT');
    if (archivedTreeInventory(physicalRoot) !== plan.inventory) fail(409, 'TRASH_CHANGED');
    if (
      !plan.treeBefore ||
      folderTreeDigest(captureFolderTree(physicalRoot), plan.fixedResources) !==
        folderTreeDigest(plan.treeBefore, plan.fixedResources)
    )
      fail(409, 'TRASH_CHANGED');
    plan.phase = 'applying';
    store(db, plan);
  }
  verifyFolderTree(plan, physicalRoot);
  for (const entry of plan.assets) {
    const relative = entry.asset.relativePath.slice(plan.to.length + 1);
    let parent = '';
    for (const part of relative.split('/').slice(0, -1)) {
      parent = parent ? parent + '/' + part : part;
      const dir = safePath(physicalRoot, parent, 'asset', true);
      if (!existsSync(dir)) {
        mkdirSync(dir, { mode: 0o700 });
        fsyncDirectory(dirname(dir));
      }
    }
    const path = safePath(physicalRoot, relative, 'asset', true),
      bytes = readFileSync(join(config.dataRoot, entry.stage));
    if (sha256(bytes) !== entry.hash) fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
    writePrivate(path, bytes);
  }
  for (const [index, entry] of plan.files.entries()) {
    const file = safePath(entry.active ? config.knowledgeRoot : physicalRoot, entry.path, 'note'),
      hash = sha256(readFileSync(file));
    if (hash === entry.afterHash) {
      const current = evidence(file);
      if (
        !entry.publicationEvidence ||
        current.dev !== entry.publicationEvidence.dev ||
        current.ino !== entry.publicationEvidence.ino ||
        current.birthtime !== entry.publicationEvidence.birthtime ||
        current.mtime !== entry.publicationEvidence.mtime
      )
        fail(409, 'TRASH_CHANGED');
      continue;
    }
    if (hash !== entry.beforeHash || !sameEvidence(evidence(file), entry.beforeEvidence))
      fail(409, 'TRASH_CHANGED');
    const bytes = readFileSync(join(config.dataRoot, entry.stage));
    if (sha256(bytes) !== entry.afterHash) fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
    const temp = join(
      dirname(file),
      '.doo-folder-restore-' + plan.operationId + '-' + index + '.tmp',
    );
    writePrivate(temp, bytes);
    entry.publicationEvidence = evidence(temp);
    entry.publicationMode = String(lstatSync(temp, { bigint: true }).mode);
    store(db, plan);
    renameSync(temp, file);
    fsyncDirectory(dirname(file));
  }
  for (const entry of plan.files)
    if (
      sha256(
        readFileSync(
          safePath(entry.active ? config.knowledgeRoot : physicalRoot, entry.path, 'note'),
        ),
      ) !== entry.afterHash
    )
      fail(409, 'TRASH_CHANGED');
  plan.treeAfter = folderTreeDigest(
    verifyFolderTree(plan, physicalRoot, true),
    plan.fixedResources,
  );
  plan.phase = 'applied';
  store(db, plan);
}
export function recordFolderNativeRestore(
  config: AppConfig,
  db: AppDatabase,
  plan: FolderNativeRestorePlan,
) {
  for (const entry of plan.assets) {
    const file = safePath(config.knowledgeRoot, entry.asset.relativePath, 'asset');
    if (sha256(readFileSync(file)) !== entry.hash) fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
    const current = db
      .prepare('SELECT id,path FROM assets WHERE id=? OR path=?')
      .all(entry.asset.id, entry.asset.relativePath) as { id: string; path: string }[];
    if (current.some((a) => a.id !== entry.asset.id || a.path !== entry.asset.relativePath))
      fail(409, 'NAME_CONFLICT');
    db.prepare('INSERT OR IGNORE INTO assets(id,path) VALUES(?,?)').run(
      entry.asset.id,
      entry.asset.relativePath,
    );
  }
  verifyFolderNativeActiveFiles(config, plan);
  for (const entry of plan.files.filter((f) => f.active)) {
    const file = safePath(config.knowledgeRoot, entry.path, 'note'),
      s = lstatSync(file, { bigint: true });
    enqueueSource(db, config, entry.noteId, entry.afterHash, s.mtimeNs.toString(), Number(s.size));
  }

}

export function recordFolderNativeRestoreRevisions(
  config: AppConfig,
  db: AppDatabase,
  plan: FolderNativeRestorePlan,
) {
  for (const entry of plan.files)
    recordOperationRevision(config, db, {
      operationId: plan.operationId,
      noteId: entry.noteId,
      logicalPath: entry.active ? entry.path : plan.from + '/' + entry.path,
      beforeHash: entry.beforeHash,
      modifiedAt: entry.originalModifiedAt ?? entry.beforeEvidence.mtime,
      backupPath: join(config.dataRoot, entry.backup),
    });
}

/** The existing verified backup restore boundary may rebind copied inode evidence.
 * Hashes and prepared final bytes remain fixed; ordinary runtime never calls this. */
export function rebindFolderNativeRestore(
  config: AppConfig,
  db: AppDatabase,
  operationId: string,
  physicalRoot: string,
  identity: string,
) {
  const plan = getFolderNativeRestorePlan(db, operationId);
  if (!plan) return;
  const currentTree = captureFolderTree(physicalRoot);
  verifyFolderTree(plan, physicalRoot, false, true, currentTree);
  for (const entry of plan.files) {
    const file = safePath(entry.active ? config.knowledgeRoot : physicalRoot, entry.path, 'note'),
      hash = sha256(readFileSync(file));
    entry.originalModifiedAt ??= entry.beforeEvidence.mtime;
    if (hash === entry.beforeHash) entry.beforeEvidence = evidence(file);
    else if (hash === entry.afterHash) {
      entry.publicationEvidence = evidence(file);
      entry.publicationMode = String(lstatSync(file, { bigint: true }).mode);
    } else fail(409, 'TRASH_CHANGED');
  }
  for (const entry of plan.assets)
    if (sha256(readFileSync(join(config.dataRoot, entry.stage))) !== entry.hash)
      fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
  const current = new Map(currentTree.map((e) => [e.path, e]));
  plan.treeBefore = plan.treeBefore!.map((e) => ({
    ...current.get(e.path)!,
    ...(e.hash ? { hash: e.hash } : {}),
  }));
  if (plan.phase === 'applied') plan.treeAfter = folderTreeDigest(currentTree, plan.fixedResources);
  plan.identity = identity;
  plan.inventory = archivedTreeInventory(physicalRoot);
  plan.activeInventory = inventory(config);
  store(db, plan);
}

export function authorizeFolderNativeRestore(p: Principal, plan: FolderNativeRestorePlan) {
  for (const entry of plan.files.filter((f) => f.active)) {
    if (!canAccessPath(p, entry.path)) fail(403, 'DEPENDENCY_FORBIDDEN');
    authorizePath(p, entry.path, 'knowledge:read');
    authorizePath(p, entry.path, 'knowledge:write');
  }
}

export function verifyFolderNativeActiveFiles(config: AppConfig, plan: FolderNativeRestorePlan) {
  for (const entry of plan.files.filter((f) => f.active)) {
    const path = safePath(config.knowledgeRoot, entry.path, 'note'),
      stamp = evidence(path),
      expected = entry.publicationEvidence;
    if (
      !expected ||
      sha256(readFileSync(path)) !== entry.afterHash ||
      stamp.dev !== expected.dev ||
      stamp.ino !== expected.ino ||
      stamp.birthtime !== expected.birthtime ||
      stamp.mtime !== expected.mtime ||
      String(lstatSync(path, { bigint: true }).mode) !== entry.publicationMode
    )
      fail(409, 'TRASH_CHANGED');
  }
}
