import { lstatSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import { revisionFileDigest } from './revision-identities.js';
import { sha256 } from './operations.js';
import { fail } from './errors.js';
import type { FolderNativeRestorePlan } from './folder-native-restore.js';
export type FolderTreeEntry = {
  path: string;
  kind: 'file' | 'directory';
  dev: string;
  ino: string;
  birthtime: string;
  mtime: string;
  ctime: string;
  size: number;
  mode: string;
  hash?: string;
};
export function captureFolderTree(root: string) {
  const entries: FolderTreeEntry[] = [];
  let bytes = 0;
  const walk = (relative: string, depth: number) => {
    if (
      depth > 64 ||
      entries.length >= 50000 ||
      (bytes += relative.length + 256) > 16 * 1024 * 1024
    )
      fail(413, 'FOLDER_TOO_LARGE');
    const file = relative ? join(root, relative) : root,
      s = lstatSync(file, { bigint: true });
    if (s.isSymbolicLink() || (!s.isDirectory() && (!s.isFile() || s.nlink !== 1n)))
      fail(409, 'TRASH_CHANGED');
    entries.push({
      path: relative,
      kind: s.isDirectory() ? 'directory' : 'file',
      dev: String(s.dev),
      ino: String(s.ino),
      birthtime: String(s.birthtimeNs),
      mtime: String(s.mtimeNs),
      ctime: String(s.ctimeNs),
      size: Number(s.size),
      mode: String(s.mode),
      ...(s.isFile() ? { hash: revisionFileDigest(file) } : {}),
    });
    if (s.isDirectory())
      for (const name of readdirSync(file).sort())
        walk(relative ? relative + '/' + name : name, depth + 1);
  };
  walk('', 0);
  return entries;
}
export const folderTreeDigest = (
  entries: FolderTreeEntry[],
  resources: FolderNativeRestorePlan['fixedResources'] = {},
) =>
  sha256(
    JSON.stringify(
      entries.map((e) =>
        resources?.[e.path]
          ? { path: e.path, kind: e.kind, mode: e.mode, hash: e.hash }
          : e.path
            ? e
            : { ...e, ctime: 'directory-rename' },
      ),
    ),
  );
const identity = (a: FolderTreeEntry, b: FolderTreeEntry) =>
  a.kind === b.kind &&
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.birthtime === b.birthtime &&
  a.mode === b.mode;
function parents(path: string) {
  const result = [''];
  let at = posix.dirname(path);
  while (at !== '.' && at) {
    result.push(at);
    at = posix.dirname(at);
  }
  return result;
}
/** Verify the entire planned tree, including untouched ordinary files and no extras. */
export function verifyFolderTree(
  plan: FolderNativeRestorePlan,
  root: string,
  complete = false,
  rebind = false,
  actual = captureFolderTree(root),
) {
  if (!plan.treeBefore) fail(409, 'RECOVERY_REQUIRED');
  const before = new Map(plan.treeBefore.map((e) => [e.path, e])),
    current = new Map(actual.map((e) => [e.path, e])),
    assets = new Map(plan.assets.map((a) => [a.asset.relativePath.slice(plan.to.length + 1), a])),
    changes = new Map(plan.files.filter((f) => !f.active).map((f) => [f.path, f])),
    mutatedParents = new Set([...assets.keys(), ...changes.keys()].flatMap(parents)),
    newParents = new Set([...assets.keys()].flatMap(parents));
  for (const original of before.values()) {
    const next = current.get(original.path);
    if (!next || next.kind !== original.kind) fail(409, 'TRASH_CHANGED');
    if (original.kind === 'directory') {
      if (
        !rebind &&
        (!identity(original, next) ||
          (!mutatedParents.has(original.path) &&
            folderTreeDigest([original]) !== folderTreeDigest([next])))
      )
        fail(409, 'TRASH_CHANGED');
      continue;
    }
    const change = changes.get(original.path);
    if (change) {
      const after = next.hash === change.afterHash;
      if (complete && !after) fail(409, 'TRASH_CHANGED');
      if (!after && next.hash !== change.beforeHash) fail(409, 'TRASH_CHANGED');
      if (!rebind) {
        const stamp = after ? change.publicationEvidence : change.beforeEvidence;
        if (
          !stamp ||
          next.dev !== stamp.dev ||
          next.ino !== stamp.ino ||
          next.birthtime !== stamp.birthtime ||
          next.mtime !== stamp.mtime ||
          (!after && next.ctime !== stamp.ctime) ||
          (after && next.mode !== change.publicationMode)
        )
          fail(409, 'TRASH_CHANGED');
      }
    } else if (
      next.hash !== original.hash ||
      (!rebind &&
        folderTreeDigest([original], plan.fixedResources) !==
          folderTreeDigest([next], plan.fixedResources))
    )
      fail(409, 'TRASH_CHANGED');
  }
  for (const next of actual) {
    if (before.has(next.path)) continue;
    const asset = assets.get(next.path);
    if (asset) {
      if (next.kind !== 'file' || next.hash !== asset.hash) fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
      continue;
    }
    if (next.kind === 'directory' && newParents.has(next.path)) continue;
    const temporary = plan.files.findIndex(
      (entry, index) =>
        !entry.active &&
        next.path ===
          posix.join(
            posix.dirname(entry.path),
            '.doo-folder-restore-' + plan.operationId + '-' + index + '.tmp',
          ),
    );
    if (
      !complete &&
      temporary >= 0 &&
      next.kind === 'file' &&
      next.hash === plan.files[temporary].afterHash
    )
      continue;
    fail(409, 'TRASH_CHANGED');
  }
  if (complete)
    for (const [path, asset] of assets)
      if (current.get(path)?.hash !== asset.hash) fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
  return actual;
}
export function verifyActivatedFolderTree(plan: FolderNativeRestorePlan, root: string) {
  const tree = verifyFolderTree(plan, root, true);
  if (!plan.treeAfter || folderTreeDigest(tree, plan.fixedResources) !== plan.treeAfter)
    fail(409, 'TRASH_CHANGED');
}
