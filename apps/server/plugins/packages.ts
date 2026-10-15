import { gunzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../../../packages/core/knowledge/operations.js';
import { fail } from '../../../packages/core/knowledge/errors.js';

export function packagePath(path: string) {
  return typeof path === 'string' && path.length <= 200 && /^[a-zA-Z0-9_./-]+$/.test(path)
    && !path.startsWith('/') && !path.split('/').some(p => p === '..' || p === '' || p.startsWith('.'));
}
export async function unpackPlugin(url: string, expected: string, destination: string) {
  const source = new URL(url);
  let bytes: Buffer;
  if (source.protocol === 'file:') bytes = readFileSync(fileURLToPath(source));
  else {
    if (source.protocol !== 'https:' && !(source.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(source.hostname))) fail(400, 'INVALID_PLUGIN_SOURCE');
    const response = await fetch(source, { signal: AbortSignal.timeout(120000), redirect: 'error' });
    if (!response.ok || Number(response.headers.get('content-length') || 0) > 32 * 1024 * 1024) fail(502, 'PLUGIN_DOWNLOAD_FAILED');
    const chunks: Uint8Array[] = []; let total = 0;
    for await (const part of response.body as any) { total += part.length; if (total > 32 * 1024 * 1024) fail(413, 'PLUGIN_PACKAGE_TOO_LARGE'); chunks.push(part); }
    bytes = Buffer.concat(chunks);
  }
  if (bytes.length > 32 * 1024 * 1024) fail(413, 'PLUGIN_PACKAGE_TOO_LARGE');
  if (sha256(bytes) !== expected) fail(400, 'PLUGIN_CHECKSUM_MISMATCH');
  let tar: Buffer;
  try { tar = gunzipSync(bytes, { maxOutputLength: 128 * 1024 * 1024 }); }
  catch { fail(400, 'INVALID_PLUGIN_PACKAGE'); }
  const seen = new Set<string>();
  const files: Record<string, string> = {};
  for (let offset = 0, count = 0; offset + 512 <= tar.length; count++) {
    if (count > 2048) fail(400, 'INVALID_PLUGIN_PACKAGE');
    const header = tar.subarray(offset, offset + 512); offset += 512;
    if (header.every(b => b === 0)) break;
    const string = (a: number, b: number) => header.subarray(a, b).toString('utf8').replace(/\0.*$/, '');
    let name = string(0, 100), prefix = string(345, 500);
    if (prefix) name = prefix + '/' + name;
    const type = string(156, 157) || '0';
    name = name.replace(/^\.\//, '').replace(/\/$/, '');
    const sizeText = string(124, 136).trim();
    if (!/^[0-7]+$/.test(sizeText)) fail(400, 'INVALID_PLUGIN_PACKAGE');
    const size = parseInt(sizeText, 8), checksum = parseInt(string(148, 156).trim(), 8);
    const actualChecksum = header.reduce((sum, b, i) => sum + (i >= 148 && i < 156 ? 32 : b), 0);
    if (checksum !== actualChecksum || size > 16 * 1024 * 1024 || offset + size > tar.length || !['0', '5'].includes(type)) fail(400, 'INVALID_PLUGIN_PACKAGE');
    if (name && name !== '.') {
      if (!packagePath(name) || seen.has(name)) fail(400, 'INVALID_PLUGIN_PACKAGE');
      seen.add(name); const target = join(destination, name);
      if (type === '5') mkdirSync(target, { recursive: true, mode: 0o700 });
      else { const content = tar.subarray(offset, offset + size); mkdirSync(dirname(target), { recursive: true, mode: 0o700 }); writeFileSync(target, content, { mode: 0o400, flag: 'wx' }); files[name] = sha256(content); }
    }
    offset += Math.ceil(size / 512) * 512;
  }
  return files;
}
