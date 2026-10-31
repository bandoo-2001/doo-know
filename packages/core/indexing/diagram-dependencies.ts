import { portableResourceLimits } from '../../../shared/portable-resource-limits.js';
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import type { AppConfig } from '../../../shared/contracts.js';
import type { AppDatabase } from '../db.js';
import { safePath } from '../files.js';
import { fileVersionStamp } from '../knowledge/file-reader.js';
import { sha256 } from '../knowledge/operations.js';
import type { DiagramVersionManifest } from '../knowledge/diagram-publications.js';

/** Check published dependency bytes without turning assets into note identities. */
export function diagramDependencyChecker(config: AppConfig, db: AppDatabase) {
  const cache = new Map<string, { signature: string; hash: string }>();
  function matches(path: string, role: 'source' | 'preview', expected: string) {
    const fd = openSync(
      safePath(config.knowledgeRoot, path, 'asset'),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = fstatSync(fd, { bigint: true });
      if (
        !before.isFile() ||
        before.nlink !== 1n ||
        before.size >
          BigInt(
            role === 'source'
              ? portableResourceLimits.whiteboardBytes
              : portableResourceLimits.pngBytes,
          )
      )
        return false;
      const signature = fileVersionStamp(before),
        old = cache.get(path);
      if (old?.signature === signature) return old.hash === expected;
      const bytes = readFileSync(fd);
      if (
        BigInt(bytes.length) !== before.size ||
        signature !== fileVersionStamp(fstatSync(fd, { bigint: true }))
      )
        return false;
      const hash = sha256(bytes);
      if (cache.size >= 256) cache.clear();
      cache.set(path, { signature, hash });
      return hash === expected;
    } finally {
      closeSync(fd);
    }
  }
  return {
    conflicted(noteId: string, path: string, mainHash: string, conflicts: ReadonlySet<string>) {
      const row = db
        .prepare(
          'SELECT manifest FROM diagram_document_versions WHERE note_id=? AND document_hash=? AND path=?',
        )
        .get(noteId, mainHash, path) as { manifest: string } | undefined;
      if (!row) return false; // Unpublished/external formats have a separate import/recovery workflow.
      try {
        const manifest = JSON.parse(row.manifest) as DiagramVersionManifest;
        if (
          !Array.isArray(manifest.resources) ||
          !manifest.resources.some((r) => r.role === 'preview')
        )
          return true;
        return manifest.resources.some(
          (resource) =>
            !['source', 'preview'].includes(resource.role) ||
            typeof resource.path !== 'string' ||
            !/^[a-f0-9]{64}$/.test(resource.hash) ||
            conflicts.has(resource.path) ||
            !matches(resource.path, resource.role, resource.hash),
        );
      } catch {
        return true;
      }
    },
  };
}

/** Asset-only events can use a quick scan; ordinary unrelated uploads need no graph scan. */
export function isDiagramDependencyPath(db: AppDatabase, path: string) {
  try {
    return !!db
      .prepare(
        `SELECT 1 FROM diagram_document_versions v
      JOIN notes n ON n.id=v.note_id AND n.path=v.path AND n.active=1
      JOIN document_state d ON d.note_id=n.id AND d.content_hash=v.document_hash
      JOIN json_each(CASE WHEN json_valid(v.manifest) THEN v.manifest ELSE '{}' END,'$.resources') r
      WHERE json_extract(r.value,'$.path')=? OR substr(json_extract(r.value,'$.path'),1,length(?)+1)=?||'/' LIMIT 1`,
      )
      .get(path, path, path);
  } catch {
    return true;
  } // A malformed registry is checked conservatively by reconciliation.
}
