import type { AppConfig } from '../../shared/contracts.js';
import type { AppDatabase } from './db.js';
import type { ReadInput, ReadPage, Principal } from '../../shared/knowledge-contracts.js';
import type { PublicProjection } from './public-diagram-projection.js';
import { acquireRead, chargeRate, signCursor, decodeCursor } from './agent/budgets.js';
import { readPolicies, utf8Prefix, limits } from './knowledge/limits.js';
import { sha256 } from './knowledge/operations.js';
import { fail } from './knowledge/errors.js';
/** Public cursors name a semantic projection, never an owner raw snapshot. Each page reprojects and reauthorizes. */
export function readPublicProjection(
  config: AppConfig,
  db: AppDatabase,
  p: Principal,
  projection: PublicProjection,
  input: ReadInput = {},
) {
  const policy = readPolicies.public,
    bytes = Buffer.from(projection.content),
    snapshotId = 'public:' + projection.fingerprint;
  if (input.cursor && (input.range || input.snapshotId)) fail(400, 'INVALID_INPUT');
  if (
    input.maxBytes != null &&
    (!Number.isInteger(input.maxBytes) || input.maxBytes < 4 || input.maxBytes > policy.maxBytes)
  )
    fail(400, 'INVALID_READ_BUDGET');
  const release = acquireRead(db, p, 'public');
  try {
    const starts = [0];
    for (let i = 0; i < bytes.length; i++) if (bytes[i] === 10) starts.push(i + 1);
    let cursor: any;
    if (input.cursor) {
      cursor = decodeCursor(config.secret, input.cursor);
      if (
        cursor.kind !== 'public-projection' ||
        cursor.channel !== 'public' ||
        cursor.principal !== p.id ||
        cursor.clientId !== p.clientId ||
        cursor.noteId !== projection.note.id
      )
        fail(403, 'FORBIDDEN');
      if (cursor.expiresAt <= Date.now()) fail(410, 'CURSOR_EXPIRED');
      if (cursor.fingerprint !== projection.fingerprint) fail(409, 'STALE_CURSOR');
    } else {
      if (input.snapshotId && input.snapshotId !== snapshotId) fail(404, 'SNAPSHOT_NOT_FOUND');
      const r = input.range;
      if (
        r &&
        (!Number.isSafeInteger(r.startLine) ||
          r.startLine < 1 ||
          (r.endLine != null && (!Number.isSafeInteger(r.endLine) || r.endLine < r.startLine)) ||
          (r.lineByteOffset != null &&
            (!Number.isSafeInteger(r.lineByteOffset) || r.lineByteOffset < 0)))
      )
        fail(400, 'INVALID_RANGE');
      const startLine = r?.startLine ?? 1,
        base = starts[startLine - 1] ?? bytes.length,
        startByte = base + (r?.lineByteOffset ?? 0),
        endByte = r?.endLine != null ? (starts[r.endLine] ?? bytes.length) : bytes.length;
      if (startByte > endByte || startByte > (starts[startLine] ?? bytes.length))
        fail(400, 'INVALID_RANGE');
      cursor = {
        kind: 'public-projection',
        channel: 'public',
        principal: p.id,
        clientId: p.clientId,
        noteId: projection.note.id,
        fingerprint: projection.fingerprint,
        startByte,
        endByte,
        maxBytes: input.maxBytes ?? policy.defaultBytes,
        pages: 0,
        bytes: 0,
        expiresAt: Date.now() + limits.ttl,
      };
    }
    if (cursor.pages >= policy.pages) fail(429, 'READ_BUDGET_EXCEEDED');
    if (cursor.startByte < bytes.length && (bytes[cursor.startByte] & 0xc0) === 0x80)
      fail(400, 'INVALID_UTF8_BOUNDARY');
    let part = utf8Prefix(bytes.subarray(cursor.startByte, cursor.endByte), cursor.maxBytes);
    let lines = 0;
    for (let i = 0; i < part.length; i++)
      if (part[i] === 10 && ++lines >= 100) {
        part = part.subarray(0, i + 1);
        break;
      }
    const end = cursor.startByte + part.length,
      used = cursor.bytes + part.length;
    if (used > policy.bytes) fail(429, 'READ_BUDGET_EXCEEDED');
    let line = 1;
    while (line < starts.length && starts[line] <= cursor.startByte) line++;
    const count = part.reduce((a, b) => a + (b === 10 ? 1 : 0), 0),
      hasMore = end < cursor.endByte;
    const data: ReadPage = {
      snapshotId,
      sourceHash: sha256(bytes),
      modifiedAt: projection.note.modifiedAt,
      content: part.toString('utf8'),
      startLine: line,
      endLine: line + count - (part.at(-1) === 10 ? 1 : 0),
      startByte: cursor.startByte,
      endByte: end,
      bytesReturned: part.length,
      hasMore,
      budgetRemainingBytes: policy.bytes - used,
      rangeHash: sha256(part),
      lineByteOffset: cursor.startByte - starts[line - 1],
      ...(hasMore
        ? {
            nextCursor: signCursor(config.secret, {
              ...cursor,
              startByte: end,
              pages: cursor.pages + 1,
              bytes: used,
            }),
          }
        : {}),
    };
    db.transaction(() => chargeRate(db, p, 'public', part.length)).immediate();
    return { kind: 'ready' as const, data };
  } finally {
    release();
  }
}
