import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import https from 'node:https';
import { validateHeaderName, validateHeaderValue } from 'node:http';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';

const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(address, prefix, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [address, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
] as const)
  blocked.addSubnet(address, prefix, 'ipv6');
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4
    ? !blocked.check(address, 'ipv4')
    : family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}
export class ToDooNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToDooNetworkError';
  }
}
export type PinnedTarget = { url: URL; address: string; family: 4 | 6 };
export type NetworkResponse = { status: number; headers: Record<string, string>; body: Buffer };
export type NetworkInput = {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: Buffer;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
};
type PreparedInput = {
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: Buffer;
  maxBytes: number;
  timeoutMs: number;
};
export type ToDooNetwork = {
  request(input: NetworkInput): Promise<NetworkResponse>;
  validate(url: string, timeoutMs?: number): Promise<PinnedTarget>;
};
type Options = {
  resolve?: (host: string) => Promise<{ address: string; family: number }[]>;
  send?: (target: PinnedTarget, input: PreparedInput) => Promise<NetworkResponse>;
  concurrency?: number;
};

function parseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ToDooNetworkError('Invalid network destination');
  }
  if (url.protocol !== 'https:')
    throw new ToDooNetworkError('HTTPS network destinations are required');
  if (url.username || url.password)
    throw new ToDooNetworkError('URL credentials are not supported');
  if (url.port && url.port !== '443') throw new ToDooNetworkError('Only HTTPS port 443 is allowed');
  if (url.hash) throw new ToDooNetworkError('Network destination must not contain a fragment');
  return url;
}
async function nativeSend(target: PinnedTarget, input: PreparedInput): Promise<NetworkResponse> {
  // No pooled connection or secondary DNS resolution can escape this pinned target.
  return new Promise((resolve, reject) => {
    const agent = new https.Agent({
      keepAlive: false,
      maxSockets: 1,
      lookup: ((_host: unknown, options: unknown, callback: Function) => {
        if (options && typeof options === 'object' && (options as { all?: boolean }).all)
          callback(null, [{ address: target.address, family: target.family }]);
        else callback(null, target.address, target.family);
      }) as any,
    });
    const request = https.request(
      target.url,
      {
        method: input.method,
        headers: input.headers,
        agent,
        servername: isIP(target.url.hostname) ? undefined : target.url.hostname,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > input.maxBytes) {
            response.destroy(new ToDooNetworkError('Network response exceeds size budget'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(response.headers))
            if (value !== undefined) headers[key] = Array.isArray(value) ? value.join(', ') : value;
          resolve({ status: response.statusCode || 502, headers, body: Buffer.concat(chunks) });
        });
      },
    );
    const timer = setTimeout(() => {
      request.destroy(new ToDooNetworkError('Network request timed out'));
    }, input.timeoutMs);
    request.on('socket', (socket) =>
      socket.once('secureConnect', () => {
        const actual = socket.remoteAddress;
        const equal =
          actual === target.address ||
          (target.family === 4 && actual === '::ffff:' + target.address);
        if (!equal)
          request.destroy(
            new ToDooNetworkError('Connected destination does not match pinned address'),
          );
      }),
    );
    request.once('error', () => reject(new ToDooNetworkError('Network request failed')));
    request.once('close', () => {
      clearTimeout(timer);
      agent.destroy();
    });
    if (input.body) request.write(input.body);
    request.end();
  });
}
export function createToDooNetwork(options: Options = {}): ToDooNetwork {
  const resolver = options.resolve ?? ((host) => lookup(host, { all: true, verbatim: true }));
  const send = options.send ?? nativeSend;
  let active = 0;
  const waiting: (() => void)[] = [];
  const maximum = Math.max(1, Math.min(options.concurrency ?? 4, 16));
  async function validate(value: string, timeoutMs = 15000): Promise<PinnedTarget> {
    const url = parseUrl(value),
      hostname = url.hostname.replace(/^\[|\]$/g, '');
    let addresses: { address: string; family: number }[];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      addresses = isIP(hostname)
        ? [{ address: hostname, family: isIP(hostname) }]
        : await Promise.race([
            resolver(hostname),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(
                () => reject(new ToDooNetworkError('Network destination lookup timed out')),
                timeoutMs,
              );
            }),
          ]);
    } catch (error) {
      if (error instanceof ToDooNetworkError) throw error;
      throw new ToDooNetworkError('Network destination resolution failed');
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (
      !addresses.length ||
      addresses.some((item) => ![4, 6].includes(item.family) || !isPublicAddress(item.address))
    )
      throw new ToDooNetworkError('Network destination address is not public');
    return { url, address: addresses[0].address, family: addresses[0].family as 4 | 6 };
  }
  async function request(input: NetworkInput): Promise<NetworkResponse> {
    if (waiting.length >= 64) throw new ToDooNetworkError('Network concurrency budget exceeded');
    if (active >= maximum) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      let url = parseUrl(input.url);
      const headers: Record<string, string> = { 'accept-encoding': 'gzip, br, deflate' };
      for (const [name, value] of Object.entries(input.headers ?? {})) {
        try {
          validateHeaderName(name);
          validateHeaderValue(name, value);
        } catch {
          throw new ToDooNetworkError('Invalid network header');
        }
        const key = name.toLowerCase();
        if (['host', 'connection', 'transfer-encoding', 'proxy-authorization'].includes(key))
          throw new ToDooNetworkError('Unsafe network header');
        if (/[\r\n]/.test(name + value)) throw new ToDooNetworkError('Invalid network header');
        headers[key] = value;
      }
      const timeoutMs = Math.min(Math.max(input.timeoutMs ?? 15000, 1), 60000),
        deadline = Date.now() + timeoutMs;
      const maxBytes = Math.min(Math.max(input.maxBytes ?? 10 * 1024 * 1024, 1), 20 * 1024 * 1024);
      const redirects = Math.min(Math.max(input.maxRedirects ?? 3, 0), 3);
      for (let hop = 0; ; hop++) {
        if (Date.now() >= deadline) throw new ToDooNetworkError('Network request timed out');
        const target = await validate(url.toString(), deadline - Date.now());
        const response = await send(target, {
          method: input.method ?? 'GET',
          headers: { ...headers },
          body: input.body,
          maxBytes,
          timeoutMs: Math.max(1, deadline - Date.now()),
        });
        if (response.body.length > maxBytes)
          throw new ToDooNetworkError('Network response exceeds size budget');
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          if (hop >= redirects || input.method === 'POST')
            throw new ToDooNetworkError('Network redirect limit reached');
          if (!response.headers.location) throw new ToDooNetworkError('Invalid network redirect');
          const next = parseUrl(new URL(response.headers.location, url).toString());
          if (next.origin !== url.origin) {
            delete headers.authorization;
            delete headers.cookie;
            delete headers['if-none-match'];
            delete headers['if-modified-since'];
          }
          url = next;
          continue;
        }
        const encoding = response.headers['content-encoding']?.trim().toLowerCase();
        if (encoding && encoding !== 'identity') {
          try {
            const decoder =
              encoding === 'gzip'
                ? gunzipSync
                : encoding === 'br'
                  ? brotliDecompressSync
                  : encoding === 'deflate'
                    ? inflateSync
                    : null;
            if (!decoder) throw new Error('unsupported');
            response.body = decoder(response.body, { maxOutputLength: maxBytes });
            delete response.headers['content-encoding'];
            delete response.headers['content-length'];
          } catch {
            throw new ToDooNetworkError('Network decompression budget or encoding limit exceeded');
          }
        }
        return response;
      }
    } finally {
      active--;
      waiting.shift()?.();
    }
  }
  return { request, validate };
}
