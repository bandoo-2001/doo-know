import { rewriteLibraryReferences } from '../organization/references.js';
import { sha256 } from './operations.js';
import { fail } from './errors.js';
import type { AppDatabase } from '../db.js';
import type { DiagramVersionManifest } from './diagram-publications.js';

/** Complete syntax-level links from one verified immutable source, including duplicate JSON keys. */
export type NativeLinkProof = {
  version: 1;
  sourcePath: string;
  sourceHash: string;
  links: string[];
};

export function captureNativeLinkProof(
  sourcePath: string,
  sourceHash: string,
  source: string,
): NativeLinkProof {
  if (sha256(source) !== sourceHash) fail(409, 'DIAGRAM_SOURCE_CONFLICT');
  const links: string[] = [];
  rewriteLibraryReferences(source, sourcePath, sourcePath, [], true, (url) => links.push(url));
  return { version: 1, sourcePath, sourceHash, links };
}

/** A proof can quarantine an unavailable source; it never grants authority to modify or publish it. */
export function nativeLinkProofUnaffected(
  proof: NativeLinkProof | undefined,
  sourcePath: string,
  sourceHash: string,
  moves: { from: string; to: string }[],
) {
  if (
    !proof ||
    proof.version !== 1 ||
    proof.sourcePath !== sourcePath ||
    proof.sourceHash !== sourceHash ||
    !Array.isArray(proof.links) ||
    proof.links.some((url) => typeof url !== 'string')
  )
    return false;
  try {
    // Replay the same reference rules against all recorded native links. No
    // basename, directory, text summary, or empty-source inference is allowed.
    const source = JSON.stringify({ elements: proof.links.map((link) => ({ link })) });
    return !rewriteLibraryReferences(source, sourcePath, sourcePath, moves, true).changed;
  } catch {
    return false;
  }
}

export function hasUnaffectedPublishedNativeLinks(
  db: AppDatabase,
  input: {
    noteId: string;
    documentHash: string;
    documentPath: string;
    sourcePath: string;
    sourceHash: string;
    moves: { from: string; to: string }[];
  },
) {
  const { documentPath, sourcePath, sourceHash, moves } = input;
  const relocated = (path: string) => {
    const move = [...moves]
      .sort((a, b) => b.from.length - a.from.length)
      .find((m) => path === m.from || path.startsWith(m.from + '/'));
    return move ? move.to + path.slice(move.from.length) : path;
  };
  if (relocated(documentPath) !== documentPath || relocated(sourcePath) !== sourcePath)
    return false;
  const row = db
    .prepare(
      'SELECT manifest FROM diagram_document_versions WHERE note_id=? AND document_hash=? AND path=?',
    )
    .get(input.noteId, input.documentHash, documentPath) as { manifest: string } | undefined;
  if (!row) return false;
  try {
    const manifest = JSON.parse(row.manifest) as DiagramVersionManifest;
    return (
      manifest.type === 'whiteboard' &&
      manifest.sourceHash === sourceHash &&
      manifest.resources.some(
        (r) => r.role === 'source' && r.path === sourcePath && r.hash === sourceHash,
      ) &&
      nativeLinkProofUnaffected(manifest.nativeLinks, sourcePath, sourceHash, moves)
    );
  } catch {
    return false;
  }
}
