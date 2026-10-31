import { constants, openSync, closeSync, fstatSync, lstatSync, readFileSync } from 'node:fs';
import { parseDiagramDocument } from '../../../shared/diagram-document.js';
import { isWhiteboard } from '../../../shared/whiteboard.js';
import type { DocumentType } from '../../../shared/diagram-resource.js';
import { hasDiagramDeclarationSync } from './diagram-declaration.js';
import { fileVersionStamp } from './file-reader.js';
import { limits } from './limits.js';
import { fail } from './errors.js';
type Metadata = { documentType: DocumentType; title?: string };
/** Rebuildable cache, keyed by physical bytes/version rather than the database type hint. */
export function documentMetadataReader() {
  const cache = new Map<string, { signature: string; metadata: Metadata }>();
  return (file: string, logicalPath: string): Metadata => {
    if (isWhiteboard(logicalPath)) return { documentType: 'whiteboard' };
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(fd, { bigint: true }),
        signature = fileVersionStamp(before);
      if (!before.isFile() || before.nlink !== 1n) fail(400, 'INVALID_PATH');
      const cached = cache.get(file);
      if (cached?.signature === signature) return cached.metadata;
      let metadata: Metadata = { documentType: 'markdown' };
      // Ordinary files, including metadata-only files >20MiB, are never fully loaded for type detection.
      if (before.size <= BigInt(limits.file) && hasDiagramDeclarationSync(file)) {
        let content: string;
        try {
          content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
            readFileSync(fd),
          );
        } catch {
          return fail(422, 'INVALID_UTF8');
        }
        const parsed = parseDiagramDocument(content);
        if (parsed.status === 'diagram')
          metadata = { documentType: parsed.type, title: parsed.title };
      }
      if (
        signature !== fileVersionStamp(fstatSync(fd, { bigint: true })) ||
        signature !== fileVersionStamp(lstatSync(file, { bigint: true }))
      )
        fail(409, 'VERSION_CONFLICT');
      if (cache.size >= 128) cache.clear();
      cache.set(file, { signature, metadata });
      return metadata;
    } finally {
      closeSync(fd);
    }
  };
}
