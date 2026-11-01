import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from '../../../shared/contracts.js';
import type { AppDatabase } from '../db.js';
import { safePath } from '../files.js';
import { fileVersionStamp } from './file-reader.js';
import { revisionFileDigest } from './revision-identities.js';
import { fail } from './errors.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import { checkTokenCutoff, authorizePath, requireScope } from '../agent/auth.js';
import { currentPrincipalPolicy } from '../agent/config.js';
import { lifecyclePrincipal } from './lifecycle-access.js';
/** Server-created identity evidence. No caller-selected host path is accepted. */
export type ArchivedNoteDiagramContext = {
  noteId: string;
  logicalPath: string;
  trashFile: string;
  hash: string;
  stamp: string;
  resources: { path: string; hash: string; stamp: string }[];
  targets: { noteId: string; path: string }[];
};
export function archivedNoteDiagramFile(
  config: AppConfig,
  db: AppDatabase,
  context: ArchivedNoteDiagramContext,
) {
  if (!/^[a-f\d-]{36}$/i.test(context.noteId)) fail(400, 'INVALID_PATH');
  const row = db
    .prepare('SELECT path,active,trash_path FROM notes WHERE id=?')
    .get(context.noteId) as any;
  if (
    !row ||
    row.active ||
    row.path !== context.logicalPath ||
    row.trash_path !== context.trashFile ||
    !context.trashFile ||
    /[\\/]/.test(context.trashFile)
  )
    fail(409, 'TRASH_CHANGED');
  let path = safePath(config.knowledgeRoot, '90-Archive', 'folder');
  for (const part of ['.trash', context.noteId]) {
    path = join(path, part);
    const s = lstatSync(path);
    if (!s.isDirectory() || s.isSymbolicLink()) fail(409, 'TRASH_CHANGED');
  }
  path = join(path, context.trashFile);
  const s = lstatSync(path, { bigint: true });
  if (
    !s.isFile() ||
    s.isSymbolicLink() ||
    s.nlink !== 1n ||
    fileVersionStamp(s) !== context.stamp ||
    revisionFileDigest(path) !== context.hash
  )
    fail(409, 'TRASH_CHANGED');
  for (const resource of context.resources) {
    const file = safePath(config.knowledgeRoot, resource.path, 'asset');
    if (
      fileVersionStamp(lstatSync(file, { bigint: true })) !== resource.stamp ||
      revisionFileDigest(file) !== resource.hash ||
      fileVersionStamp(lstatSync(file, { bigint: true })) !== resource.stamp
    )
      fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
  }
  for (const target of context.targets)
    if (
      !db
        .prepare('SELECT 1 FROM notes WHERE id=? AND path=? AND active=1')
        .get(target.noteId, target.path)
    )
      fail(409, 'REVISION_REFERENCE_UNAVAILABLE');
  return path;
}
/** Check both the caller's ceiling and the current persisted policy; neither can expand the other. */
export function authorizeArchivedNoteOperation(
  config: AppConfig,
  db: AppDatabase,
  p: Principal,
  noteId: string,
  paths: string[],
  targets: string[] = [],
  archive = false,
) {
  checkTokenCutoff(db, p);
  const current = p.id === 'web-owner' ? p : currentPrincipalPolicy(config, db, p);
  if (!current || current.id !== p.id || current.clientId !== p.clientId) fail(403, 'FORBIDDEN');
  for (const actor of [p, current]) {
    if (archive && (actor.policyVersion === 2 || actor.permissionCeiling))
      requireScope(actor, 'knowledge:archive');
    for (const path of paths)
      authorizePath(lifecyclePrincipal(db, actor, 'note', noteId, path), path, 'knowledge:write');
    for (const target of targets) authorizePath(actor, target, 'knowledge:read');
  }
}
