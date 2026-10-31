import { fileVersionStamp } from './file-reader.js';
import { openSync, closeSync, fstatSync, readFileSync, constants } from 'node:fs';
import type { AppConfig } from '../../../shared/contracts.js';
import { MAX_WHITEBOARD_BYTES } from '../../../shared/whiteboard.js';
import { safePath } from '../files.js';
import { fail } from './errors.js';

export function readBoundDiagramAssetSnapshot(
  config: AppConfig,
  path: string,
  role: 'source' | 'preview',
) {
  const fd = openSync(
    safePath(config.knowledgeRoot, path, 'asset'),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const before = fstatSync(fd, { bigint: true });
    if (
      !before.isFile() ||
      before.size > BigInt(role === 'source' ? MAX_WHITEBOARD_BYTES : 10 * 1024 * 1024)
    )
      fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
    const bytes = readFileSync(fd),
      after = fstatSync(fd, { bigint: true });
    if (
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      before.size !== after.size ||
      bytes.length !== Number(after.size)
    )
      fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
    return { bytes, signature: fileVersionStamp(after) };
  } finally {
    closeSync(fd);
  }
}

export function readBoundDiagramAsset(config: AppConfig, path: string, role: 'source' | 'preview') {
  return readBoundDiagramAssetSnapshot(config, path, role).bytes;
}
