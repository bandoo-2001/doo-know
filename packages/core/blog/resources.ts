import { createHash } from 'node:crypto';
import { HttpError } from '../errors.js';
import { BlogError } from './errors.js';
import { validateRelative } from '../files.js';
import { requireScope, canAccessPath } from '../agent/auth.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';

export const blogHash = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
export function authorizeBlogPath(p: Principal, path: string, asset = false) {
  requireScope(p, 'knowledge:read');
  validateRelative(path, asset ? 'asset' : 'note');
  if (!canAccessPath(p, path))
    throw new BlogError(403, '资源不在授权目录内', { code: 'FORBIDDEN' });
}
export function publicationPng(base64: unknown): Buffer {
  if (
    typeof base64 !== 'string' ||
    base64.length > Math.ceil((10 * 1024 ** 2) / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)
  )
    throw new BlogError(400, 'PNG 预览编码不正确');
  const bytes = Buffer.from(base64, 'base64');
  if (
    bytes.toString('base64') !== base64 ||
    bytes.length < 45 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.subarray(12, 16).toString() !== 'IHDR'
  )
    throw new BlogError(400, '预览必须是有效 PNG');
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20);
  if (!width || !height || width > 8192 || height > 8192 || width * height > 16777216)
    throw new BlogError(400, 'PNG 预览尺寸超限');
  const depths: Record<number, number[]> = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  };
  if (
    !depths[bytes[25]]?.includes(bytes[24]) ||
    bytes[26] !== 0 ||
    bytes[27] !== 0 ||
    bytes[28] > 1
  )
    throw new BlogError(400, 'PNG 预览格式不正确');
  let offset = 33,
    image = false,
    ended = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset),
      kind = bytes.subarray(offset + 4, offset + 8).toString();
    if (length > bytes.length - offset - 12 || kind === 'IHDR') break;
    if (kind === 'IDAT' && length) image = true;
    if (kind === 'IEND') {
      ended = length === 0 && offset + 12 === bytes.length;
      break;
    }
    offset += length + 12;
  }
  if (!image || !ended) throw new BlogError(400, 'PNG 预览不完整');
  return bytes;
}
