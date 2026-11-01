import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import {
  request as httpRequest,
  type RequestOptions,
  type IncomingMessage,
  type ClientRequest,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { portableResourceLimits as limits } from '../../../shared/portable-resource-limits.js';
import { MEDIA_MIMES } from '../../../shared/media.js';
export const resourceExtensions: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    Object.entries({
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.pdf': 'application/pdf',
      '.svg': 'image/svg+xml',
      ...MEDIA_MIMES,
    }).map(([ext, mime]) => [mime, ext]),
  ),
);
export type RemoteDependencies = {
  resolve?: (hostname: string) => Promise<{ address: string; family: number }[]>;
  request?: (
    url: URL,
    options: RequestOptions,
    callback: (response: IncomingMessage) => void,
  ) => ClientRequest;
};
/** Conservative global-unicast allowlist. All DNS answers must pass, on every redirect. */
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || b === 2 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (isIP(address) === 6) {
    if (address.includes('%')) return false;
    const groups = address.toLowerCase().split(':'),
      first = parseInt(groups[0] || '0', 16),
      second = parseInt(groups[1] || '0', 16);
    // Global unicast only; exclude transition, protocol-assignment and documentation ranges.
    return (
      first >= 0x2000 &&
      first <= 0x3fff &&
      first !== 0x2002 &&
      first !== 0x3fff &&
      !(first === 0x2001 && (second <= 0x1ff || second === 0xdb8))
    );
  }
  return false;
}
export function resourceDiagnostic(value: string) {
  if (/^data:/i.test(value)) return value.slice(0, value.indexOf(',') + 1) + '[inline bytes]';
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    return url.toString().slice(0, 2048);
  } catch {
    return value.slice(0, 2048);
  }
}
function resourceError(message: string) {
  return Object.assign(Error(message), { code: 'PORTABLE_REMOTE_RESOURCE_FAILED' });
}
export async function stageRemoteResource(
  value: string,
  options: RemoteDependencies & {
    destination: string;
    maxBytes?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    onBytes?: (bytes: number) => void;
  },
) {
  const controller = new AbortController(),
    timeout = setTimeout(
      () => controller.abort(resourceError('resource timeout')),
      options.timeoutMs ?? limits.resourceTimeoutMs,
    );
  const abort = () =>
    controller.abort(options.signal?.reason ?? resourceError('resource cancelled'));
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener('abort', abort, { once: true });
  const signal = controller.signal;
  let active: ClientRequest | undefined;
  const aborted = () =>
    active?.destroy(
      signal.reason instanceof Error ? signal.reason : resourceError('resource cancelled'),
    );
  signal.addEventListener('abort', aborted);
  try {
    let url = new URL(value),
      response: IncomingMessage | undefined;
    for (let hop = 0; ; hop++) {
      if (signal.aborted) throw signal.reason;
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        throw resourceError('resource protocol/credentials forbidden');
      const host = url.hostname.replace(/^\[|\]$/g, '');
      const addresses = isIP(host)
        ? [{ address: host, family: isIP(host) }]
        : await Promise.race([
            (options.resolve ?? ((h) => lookup(h, { all: true, verbatim: true })))(host),
            new Promise<never>((_, reject) =>
              signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
            ),
          ]);
      if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address)))
        throw resourceError('resource address forbidden');
      const pinned = addresses[0];
      response = await new Promise<IncomingMessage>((resolve, reject) => {
        const request =
          options.request ??
          ((u, o, cb) => (u.protocol === 'https:' ? httpsRequest : httpRequest)(u, o, cb));
        active = request(
          url,
          {
            method: 'GET',
            agent: false,
            family: pinned.family,
            headers: { Accept: Object.keys(resourceExtensions).join(', ') },
            signal,
            lookup: ((_hostname: string, _lookupOptions: unknown, callback: any) =>
              callback(null, pinned.address, pinned.family)) as any,
          },
          resolve,
        );
        active.once('error', reject);
        active.end();
      });
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
        const location = response.headers.location;
        response.destroy();
        if (!location || hop >= limits.redirects) throw resourceError('resource redirect limit');
        const next = new URL(location, url);
        if (url.protocol === 'https:' && next.protocol === 'http:')
          throw resourceError('resource redirect downgrade');
        url = next;
        continue;
      }
      if (response.statusCode !== 200) {
        response.destroy();
        throw resourceError('resource HTTP unavailable');
      }
      break;
    }
    const mime = String(response!.headers['content-type'] ?? '')
        .split(';')[0]
        .trim()
        .toLowerCase(),
      ext = resourceExtensions[mime];
    if (!ext) {
      response!.destroy();
      throw resourceError('resource MIME unsupported');
    }
    const maximum = Math.min(
      options.maxBytes ?? Infinity,
      MEDIA_MIMES[ext] ? limits.mediaBytes : limits.attachmentBytes,
    );
    const length = response!.headers['content-length'];
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maximum)) {
      response!.destroy();
      throw resourceError('resource quota exceeded');
    }
    let sizeBytes = 0;
    const hash = createHash('sha256');
    await pipeline(
      response!,
      new Transform({
        transform(chunk, _encoding, callback) {
          try {
            sizeBytes += chunk.length;
            if (sizeBytes > maximum) throw resourceError('resource quota exceeded');
            options.onBytes?.(sizeBytes);
            hash.update(chunk);
            callback(null, chunk);
          } catch (e) {
            callback(e as Error);
          }
        },
      }),
      createWriteStream(options.destination, { flags: 'wx', mode: 0o600 }),
      { signal },
    );
    if (signal.aborted) throw signal.reason;
    return { mime, ext, sizeBytes, sha256: hash.digest('hex') };
  } catch (error) {
    active?.destroy();
    await unlink(options.destination).catch(() => {});
    if (signal.aborted) throw signal.reason;
    throw error;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', aborted);
    options.signal?.removeEventListener('abort', abort);
  }
}
export async function stageDataResource(
  value: string,
  options: { destination: string; onBytes?: (bytes: number) => void },
) {
  const match = /^data:([^;,]+)(?:;charset=(?:utf-8|us-ascii))?(;base64)?,/i.exec(value);
  if (!match) throw resourceError('typed data resource required');
  const mime = match[1].toLowerCase(),
    ext = resourceExtensions[mime];
  if (!ext) throw resourceError('data resource MIME unsupported');
  const maximum = MEDIA_MIMES[ext] ? limits.mediaBytes : limits.attachmentBytes;
  const payload = value.slice(match[0].length),
    hash = createHash('sha256');
  let sizeBytes = 0;
  async function* chunks() {
    if (match![2]) {
      if (payload.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload))
        throw resourceError('invalid base64 resource');
      for (let at = 0; at < payload.length; at += 65536)
        yield Buffer.from(payload.slice(at, at + 65536), 'base64');
    } else {
      // Percent-encoded bytes, including non-UTF8 payloads, are decoded without a whole-file Buffer.
      let chunk: number[] = [];
      for (let at = 0; at < payload.length; at++) {
        if (payload[at] === '%') {
          if (!/^[a-f0-9]{2}$/i.test(payload.slice(at + 1, at + 3)))
            throw resourceError('invalid data resource');
          chunk.push(parseInt(payload.slice(at + 1, at + 3), 16));
          at += 2;
        } else {
          const c = payload.charCodeAt(at);
          if (c > 127) throw resourceError('data resource must encode bytes');
          chunk.push(c);
        }
        if (chunk.length >= 16384) {
          yield Buffer.from(chunk);
          chunk = [];
        }
      }
      if (chunk.length) yield Buffer.from(chunk);
    }
  }
  try {
    await pipeline(
      Readable.from(chunks()),
      new Transform({
        transform(chunk, _encoding, callback) {
          try {
            sizeBytes += chunk.length;
            if (sizeBytes > maximum) throw resourceError('resource quota exceeded');
            options.onBytes?.(sizeBytes);
            hash.update(chunk);
            callback(null, chunk);
          } catch (e) {
            callback(e as Error);
          }
        },
      }),
      createWriteStream(options.destination, { flags: 'wx', mode: 0o600 }),
    );
    return { mime, ext, sizeBytes, sha256: hash.digest('hex') };
  } catch (e) {
    await unlink(options.destination).catch(() => {});
    throw e;
  }
}
