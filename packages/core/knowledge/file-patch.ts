import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { PatchEdit } from '../../../shared/knowledge-contracts.js';
import type { SnapshotRow } from './snapshots.js';
import { readBlocks } from './file-reader.js';
import { fail } from './errors.js';
export type ResolvedEdit = { start: number; end: number; insert: Buffer };
export function validateEdits(edits: PatchEdit[], maxBytes: number) {
  if (!Array.isArray(edits) || !edits.length || edits.length > 20) fail(400, 'INVALID_PATCH');
  let bytes = 0;
  for (const e of edits) {
    if (e?.type === 'replace_text') {
      if (typeof e.before !== 'string' || !e.before.length || typeof e.after !== 'string')
        fail(400, 'INVALID_PATCH');
      bytes += Buffer.byteLength(e.before) + Buffer.byteLength(e.after);
    } else if (e?.type === 'replace_range') {
      if (
        typeof e.insert !== 'string' ||
        !Number.isSafeInteger(e.startByte) ||
        !Number.isSafeInteger(e.endByte) ||
        e.startByte < 0 ||
        e.endByte < e.startByte ||
        typeof e.expectedRangeHash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(e.expectedRangeHash)
      )
        fail(400, 'INVALID_PATCH');
      bytes += Buffer.byteLength(e.insert);
    } else fail(400, 'INVALID_PATCH');
  }
  if (bytes > maxBytes) fail(413, 'REQUEST_TOO_LARGE');
}
export async function resolveEdits(
  snapshot: SnapshotRow,
  edits: PatchEdit[],
  signal?: AbortSignal,
): Promise<ResolvedEdit[]> {
  const ranges: ResolvedEdit[] = [];
  for (const edit of edits) {
    if (edit.type === 'replace_text') {
      const before = Buffer.from(edit.before);
      let carry = Buffer.alloc(0),
        offset = 0,
        matches = 0,
        found = -1;
      for await (const bytes of readBlocks(snapshot.path, 0, undefined, signal)) {
        const block = Buffer.concat([carry, bytes]);
        let at = 0;
        while ((at = block.indexOf(before, at)) !== -1) {
          found = offset - carry.length + at;
          if (++matches > 1) fail(409, 'PATCH_NOT_UNIQUE');
          at++;
        }
        offset += bytes.length;
        carry = Buffer.from(block.subarray(Math.max(0, block.length - before.length + 1)));
      }
      if (matches !== 1) fail(409, 'PATCH_NOT_FOUND');
      ranges.push({ start: found, end: found + before.length, insert: Buffer.from(edit.after) });
    } else {
      if (edit.endByte > snapshot.size_bytes) fail(400, 'INVALID_RANGE');
      const fd = await open(snapshot.path, 'r');
      try {
        for (const at of [edit.startByte, edit.endByte]) {
          if (at === snapshot.size_bytes) continue;
          const b = Buffer.alloc(1);
          await fd.read(b, 0, 1, at);
          if ((b[0] & 0xc0) === 0x80) fail(400, 'INVALID_UTF8_BOUNDARY');
        }
      } finally {
        await fd.close();
      }
      const h = createHash('sha256');
      for await (const bytes of readBlocks(snapshot.path, edit.startByte, edit.endByte, signal))
        h.update(bytes);
      if (h.digest('hex') !== edit.expectedRangeHash) fail(409, 'RANGE_HASH_CONFLICT');
      ranges.push({ start: edit.startByte, end: edit.endByte, insert: Buffer.from(edit.insert) });
    }
  }
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < ranges.length; i++)
    if (ranges[i].start < ranges[i - 1].end || ranges[i].start === ranges[i - 1].start)
      fail(400, 'OVERLAPPING_PATCH');
  return ranges;
}
