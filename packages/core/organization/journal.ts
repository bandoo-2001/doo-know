import {
  mkdirSync,
  openSync,
  closeSync,
  fsyncSync,
  constants,
  writeFileSync,
  fstatSync,
  readSync,
  writeSync,
  lstatSync,
  existsSync,
  linkSync,
  unlinkSync,
  rmdirSync,
  readdirSync,
  statfsSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { scanFiles } from '../files.js';
import type { AppConfig } from '../../../shared/contracts.js';
import type { AppDatabase } from '../db.js';
import type { OrganizationResult } from '../../../shared/organization-contracts.js';
import { fail } from '../knowledge/errors.js';
import { sha256 } from '../knowledge/operations.js';
import { restoreHash, fsyncDirectory, enqueueSource } from '../knowledge/core.js';
import { syncDirectoryCatalog } from './catalog.js';
import { readOrganizationSettings } from './settings.js';
import {
  evidence,
  sameIdentity,
  sameEvidence,
  readBody,
  type OrganizationManifest,
  type Change,
  type Evidence,
} from './plan.js';
export function journalDirectory(config: AppConfig, id: string) {
  if (!/^[0-9a-f-]{36}$/.test(id)) fail(400, 'INVALID_OPERATION_ID');
  return join(config.dataRoot, 'organization', id);
}
function syncFile(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDirectory(dirname(path));
}
/** Pin the original before copying: a source-path swap never follows a link into external data. */
function copyPinned(source: string, target: string, expected?: Evidence) {
  const input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let output: number | undefined;
  try {
    const before = fstatSync(input, { bigint: true });
    const stamp = (s: typeof before): Evidence => ({
      dev: String(s.dev),
      ino: String(s.ino),
      birthtime: String(s.birthtimeNs),
      mtime: String(s.mtimeNs),
      ctime: String(s.ctimeNs),
      size: Number(s.size),
    });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      (expected && !sameEvidence(stamp(before), expected))
    )
      fail(409, 'SOURCE_CHANGED');
    output = openSync(target, 'wx', 0o600);
    const hash = createHash('sha256'),
      buffer = Buffer.alloc(65536);
    let offset = 0;
    while (offset < Number(before.size)) {
      const length = readSync(
        input,
        buffer,
        0,
        Math.min(buffer.length, Number(before.size) - offset),
        offset,
      );
      if (!length) fail(409, 'SOURCE_CHANGED');
      hash.update(buffer.subarray(0, length));
      let written = 0;
      while (written < length) written += writeSync(output, buffer, written, length - written);
      offset += length;
    }
    if (
      !sameEvidence(stamp(before), stamp(fstatSync(input, { bigint: true }))) ||
      !sameEvidence(stamp(before), evidence(source))
    )
      fail(409, 'SOURCE_CHANGED');
    const digest = hash.digest('hex');
    if (expected?.hash && expected.hash !== digest) fail(409, 'SOURCE_CHANGED');
    fsyncSync(output);
    return digest;
  } finally {
    if (output !== undefined) closeSync(output);
    closeSync(input);
    fsyncDirectory(dirname(target));
  }
}
function writePrivate(path: string, content: string) {
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDirectory(dirname(path));
}
function matchFile(path: string, stamp: Evidence, hash: string) {
  if (!existsSync(path)) return false;
  const s = lstatSync(path, { bigint: true });
  return (
    s.isFile() &&
    !s.isSymbolicLink() &&
    sameIdentity(evidence(path), stamp) &&
    restoreHash(path) === hash
  );
}
export function saveManifest(db: AppDatabase, m: OrganizationManifest) {
  db.prepare('UPDATE organization_jobs SET manifest=? WHERE id=?').run(
    JSON.stringify(m),
    m.operationId,
  );
}
function objectUpdate(db: AppDatabase, m: OrganizationManifest, index: number, phase: string) {
  db.prepare(
    'UPDATE organization_objects SET phase=?,evidence=? WHERE operation_id=? AND ordinal=?',
  ).run(phase, JSON.stringify(m.objects[index]), m.operationId, index);
  saveManifest(db, m);
}
export function stageOrganization(config: AppConfig, db: AppDatabase, m: OrganizationManifest) {
  const base = journalDirectory(config, m.operationId);
  mkdirSync(join(config.dataRoot, 'organization'), { recursive: true, mode: 0o700 });
  fsyncDirectory(config.dataRoot);
  const bytes = m.objects.reduce(
    (total, o) =>
      o.kind === 'file'
        ? total + o.before.size * 2 + (o.afterContent ? Buffer.byteLength(o.afterContent) : 0)
        : total,
    0,
  );
  const disk = statfsSync(config.dataRoot, { bigint: true });
  if (BigInt(bytes + 1024 * 1024) > disk.bavail * disk.bsize) fail(507, 'INSUFFICIENT_STORAGE');
  mkdirSync(base, { mode: 0o700 });
  fsyncDirectory(dirname(base));
  for (let i = 0; i < m.objects.length; i++) {
    const o = m.objects[i];
    if (o.kind === 'file') {
      o.backup = `${i}.before`;
      o.stage = `${i}.after`;
      const original = join(config.knowledgeRoot, o.from);
      if (!sameEvidence(evidence(original), o.before)) fail(409, 'SOURCE_CHANGED');
      const beforeHash = copyPinned(original, join(base, o.backup), o.before);
      if (o.before.hash && o.before.hash !== beforeHash) fail(409, 'SOURCE_CHANGED');
      o.before.hash = beforeHash;
      if (o.afterContent !== undefined) {
        writePrivate(join(base, o.stage), o.afterContent);
        delete o.afterContent;
      } else if ((o as any).contentSource) {
        copyPinned((o as any).contentSource, join(base, o.stage));
        delete (o as any).contentSource;
        syncFile(join(base, o.stage));
      } else {
        copyPinned(join(base, o.backup), join(base, o.stage));
        syncFile(join(base, o.stage));
      }
      const hash = restoreHash(join(base, o.stage));
      if (o.afterHash && o.afterHash !== hash) fail(409, 'SOURCE_CHANGED');
      o.afterHash = hash;
      o.published = evidence(join(base, o.stage), hash);
    }
    db.prepare(
      'INSERT INTO organization_objects(operation_id,ordinal,kind,phase,evidence) VALUES(?,?,?,?,?)',
    ).run(m.operationId, i, o.kind, 'staged', JSON.stringify(o));
  }
  saveManifest(db, m);
  writePrivate(join(base, 'manifest.json'), JSON.stringify(m));
  fsyncDirectory(base);
}
/** Complete only a frozen journal. Caller must hold the exclusive recovery/commit gate. */
export function commitOrganization(
  config: AppConfig,
  db: AppDatabase,
  m: OrganizationManifest,
): OrganizationResult {
  const base = journalDirectory(config, m.operationId);
  for (const [i, o] of m.objects
    .map((o, i) => [i, o] as const)
    .filter(([, o]) => o.kind === 'directory')
    .sort((a, b) => (a[1] as any).to.split('/').length - (b[1] as any).to.split('/').length)) {
    if (o.kind !== 'directory') continue;
    const target = join(config.knowledgeRoot, o.to);
    if (o.published) {
      if (!existsSync(target) || !sameIdentity(evidence(target), o.published))
        fail(409, 'ORGANIZATION_EVIDENCE_CONFLICT');
    } else {
      if (existsSync(target)) fail(409, 'ORGANIZATION_EVIDENCE_CONFLICT');
      mkdirSync(target, { mode: 0o700 });
      fsyncDirectory(dirname(target));
      o.published = evidence(target);
      objectUpdate(db, m, i, 'published');
    }
  }
  for (let i = 0; i < m.objects.length; i++) {
    const o = m.objects[i];
    if (o.kind !== 'file') continue;
    if (!o.stage || !o.backup || !o.published || !o.before.hash)
      fail(409, 'ORGANIZATION_EVIDENCE_CONFLICT');
    const source = join(config.knowledgeRoot, o.from),
      target = join(config.knowledgeRoot, o.to),
      stage = join(base, o.stage);
    if (!o.publication) {
      const relative = join(dirname(o.to), `.doo-organization-${m.operationId}-${i}.tmp`),
        local = join(config.knowledgeRoot, relative);
      if (existsSync(local) || !existsSync(stage) || restoreHash(stage) !== o.afterHash)
        fail(409, 'ORGANIZATION_EVIDENCE_CONFLICT');
      copyPinned(stage, local);
      syncFile(local);
      o.publication = relative;
      o.published = evidence(local, o.afterHash);
      objectUpdate(db, m, i, 'staged');
    }
    const publication = join(config.knowledgeRoot, o.publication),
      phase = (
        db
          .prepare('SELECT phase FROM organization_objects WHERE operation_id=? AND ordinal=?')
          .get(m.operationId, i) as any
      )?.phase;
    const targetIsPublished = matchFile(target, o.published, o.afterHash);
    if (!targetIsPublished) {
      if (!existsSync(publication) || !matchFile(publication, o.published, o.afterHash))
        fail(409, 'ORGANIZATION_EVIDENCE_CONFLICT');
      if (o.from === o.to) {
        if (existsSync(source)) {
          if (
            !matchFile(source, o.before, o.before.hash) ||
            !sameEvidence(evidence(source), o.before)
          )
            fail(409, 'ORGANIZATION_EVIDENCE_CONFLICT');
          if (phase !== 'staged' && phase !== 'source_pending')
            fail(409, 'ORGANIZATION_EVIDENCE_CONFLICT');
          objectUpdate(db, m, i, 'source_pending');
          unlinkSync(source);
          fsyncDirectory(dirname(source));
        }
      } else if (existsSync(target)) fail(409, 'ORGANIZATION_EVIDENCE_CONFLICT');
      linkSync(publication, target);
      fsyncDirectory(dirname(target));
      objectUpdate(db, m, i, 'published');
    }
    if (o.from !== o.to && existsSync(source)) {
      if (!matchFile(source, o.before, o.before.hash) || !sameEvidence(evidence(source), o.before))
        fail(409, 'ORGANIZATION_EVIDENCE_CONFLICT');
      unlinkSync(source);
      fsyncDirectory(dirname(source));
    }
    if (existsSync(publication)) {
      if (!matchFile(publication, o.published, o.afterHash))
        fail(409, 'ORGANIZATION_EVIDENCE_CONFLICT');
      unlinkSync(publication);
      fsyncDirectory(dirname(publication));
    }
    if (existsSync(stage)) {
      if (restoreHash(stage) !== o.afterHash) fail(409, 'ORGANIZATION_EVIDENCE_CONFLICT');
      unlinkSync(stage);
      fsyncDirectory(base);
    }
    o.published = evidence(target, o.afterHash);
    objectUpdate(db, m, i, 'completed');
  }
  // Source trees are emptied object-by-object; only verified, empty directories are removed.
  const removals = m.objects
    .filter((o) => o.kind === 'remove_directory' || (o.kind === 'directory' && o.from))
    .sort((a, b) => (b as any).from.split('/').length - (a as any).from.split('/').length);
  for (const o of removals) {
    const source = join(config.knowledgeRoot, o.from!);
    if (!existsSync(source)) continue;
    if (!o.before || !sameIdentity(evidence(source), o.before) || readdirSync(source).length)
      fail(409, 'ORGANIZATION_EVIDENCE_CONFLICT');
    rmdirSync(source);
    fsyncDirectory(dirname(source));
  }
  for (const o of m.objects)
    if (
      o.kind === 'file' &&
      (!o.published || !matchFile(join(config.knowledgeRoot, o.to), o.published, o.afterHash))
    )
      fail(409, 'ORGANIZATION_EVIDENCE_CONFLICT');
  if (m.changes.some((c) => c.type === 'move_note' || c.type === 'move_directory') || m.undoOf) {
    const expectedPaths = m.coverage
      .map((c) => {
        const changed = m.objects.find((o) => o.kind === 'file' && o.note && o.id === c.id);
        return changed && changed.kind === 'file' ? changed.to : c.path;
      })
      .sort();
    if (
      JSON.stringify(scanFiles(config.knowledgeRoot).notes.sort()) !== JSON.stringify(expectedPaths)
    )
      fail(409, 'ORGANIZATION_EVIDENCE_CONFLICT');
    for (const source of m.coverage) {
      const changed = m.objects.find((o) => o.kind === 'file' && o.note && o.id === source.id);
      const path = changed && changed.kind === 'file' ? changed.to : source.path,
        body = readBody(config, path),
        expectedHash = changed && changed.kind === 'file' ? changed.afterHash : source.hash;
      if (body.hash !== expectedHash || (!changed && !sameEvidence(body.evidence, source.evidence)))
        fail(409, 'ORGANIZATION_EVIDENCE_CONFLICT');
    }
  }
  return db
    .transaction(() => {
      const existing = db
        .prepare('SELECT status,result FROM operations WHERE id=?')
        .get(m.operationId) as any;
      if (existing?.status === 'succeeded') return JSON.parse(existing.result);
      for (const o of m.objects)
        if (o.kind === 'directory' && o.business && o.from)
          db.prepare('UPDATE organization_directories SET active=0 WHERE id=?').run(o.id);
      for (const o of m.objects) {
        if (o.kind === 'directory' && o.business) {
          const s = evidence(join(config.knowledgeRoot, o.to));
          db.prepare(
            'INSERT INTO organization_directories(id,library_id,path,active,dev,ino,birthtime_ns) VALUES(?,?,?,1,?,?,?) ON CONFLICT(id) DO UPDATE SET path=excluded.path,active=1,dev=excluded.dev,ino=excluded.ino,birthtime_ns=excluded.birthtime_ns',
          ).run(o.id, m.libraryId, o.to, s.dev, s.ino, s.birthtime);
        } else if (o.kind === 'remove_directory')
          db.prepare('UPDATE organization_directories SET active=0 WHERE id=?').run(o.id);
      }
      for (const o of m.objects)
        if (o.kind === 'file') {
          if (o.note) {
            db.prepare('UPDATE notes SET path=? WHERE id=? AND active=1').run(o.to, o.id);
            if (o.from !== o.to) {
              db.prepare('UPDATE document_state SET active=0 WHERE note_id=?').run(o.id);
              db.prepare('UPDATE chunks SET active=0 WHERE note_id=?').run(o.id);
            }
            const s = evidence(join(config.knowledgeRoot, o.to));
            enqueueSource(db, config, o.id, o.afterHash, s.mtime, s.size);
          } else db.prepare('UPDATE assets SET path=? WHERE id=?').run(o.to, o.id);
        }
      const state = syncDirectoryCatalog(config, db, { recovering: true });
      m.resultRevision = state.structureRevision;
      m.outputInventory = outputInventory(config, m);
      m.outputContentInventory = outputInventory(config, m, true);
      saveManifest(db, m);
      const result: OrganizationResult = {
        operationId: m.operationId,
        libraryId: m.libraryId,
        structureRevision: state.structureRevision,
        changes: m.changes,
        indexState: m.objects.some((o) => o.kind === 'file' && o.note) ? 'pending' : 'ready',
        undoAvailable: m.objects.length > 0 && !m.undoOf,
      };
      const finishedAt = Date.now(),
        retentionDays = readOrganizationSettings(db).retentionDays;
      db.prepare(
        "UPDATE organization_jobs SET status='succeeded',finished_at=?,expires_at=?,manifest=?,error=NULL WHERE id=?",
      ).run(finishedAt, finishedAt + retentionDays * 86400000, JSON.stringify(m), m.operationId);
      db.prepare(
        "UPDATE operations SET status='succeeded',result=?,error=NULL,updated_at=? WHERE id=?",
      ).run(JSON.stringify(result), Date.now(), m.operationId);
      if (m.undoOf)
        db.prepare('UPDATE organization_jobs SET undo_id=? WHERE id=?').run(
          m.operationId,
          m.undoOf,
        );
      return result;
    })
    .immediate();
}
export function outputInventory(config: AppConfig, m: OrganizationManifest, contentOnly = false) {
  const result: unknown[] = [];
  const seen = new Set<string>();
  const visit = (path: string) => {
    if (seen.has(path)) return;
    seen.add(path);
    const file = join(config.knowledgeRoot, path);
    const s = lstatSync(file, { bigint: true });
    if (s.isSymbolicLink() || (!s.isFile() && !s.isDirectory())) fail(409, 'UNDO_CONFLICT');
    const e = evidence(file);
    result.push(
      contentOnly
        ? [path, s.isFile() ? restoreHash(file) : 'directory']
        : [path, e, s.isFile() ? restoreHash(file) : null],
    );
    if (s.isDirectory()) for (const name of readdirSync(file).sort()) visit(path + '/' + name);
  };
  for (const o of m.objects) {
    if (o.kind === 'remove_directory') continue;
    visit(o.to);
  }
  return sha256(JSON.stringify(result));
}
