import { createHash } from 'node:crypto';
import { HttpError } from '../errors.js';
import { validatePng } from '../knowledge/diagram-artifacts.js';
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
  if (bytes.toString('base64') !== base64) throw new BlogError(400, 'PNG 预览编码不正确');
  try {
    validatePng(bytes);
  } catch (error) {
    if (error instanceof HttpError) throw new BlogError(error.statusCode, error.message);
    throw error;
  }
  return bytes;
}
