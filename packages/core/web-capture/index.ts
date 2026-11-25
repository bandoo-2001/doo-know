import { isIP } from 'node:net';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import type { IncomingMessage } from 'node:http';
import { fail, KnowledgeError } from '../knowledge/errors.js';
import {
  isPublicAddress,
  PublicHttpError,
  withPinnedPublicResponse,
  type RemoteDependencies,
} from '../portable-delivery/remote.js';
import { extractWebPage } from './extract.js';

const maxHtmlBytes = 2 * 1024 * 1024;
const maxUrlLength = 4096;

export type WebPagePreview = { title: string; sourceUrl: string; markdown: string };

function validDestination(url: URL) {
  const host = url.hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
  return isIP(host)
    ? isPublicAddress(host)
    : host.includes('.') && !/\.(?:localhost|local|internal)$/i.test(host);
}

export function normalizeWebCaptureUrl(value: string): string {
  const text = value.trim();
  let url: URL;
  try {
    if (text.length > maxUrlLength || /[\p{Cc}\\]/u.test(text)) throw Error();
    url = new URL(text);
  } catch {
    fail(400, 'WEB_CAPTURE_INVALID_URL', '请输入完整的 HTTP 或 HTTPS 网页链接');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port)
    fail(400, 'WEB_CAPTURE_INVALID_URL', '仅支持不带凭据且使用默认端口的 HTTP 或 HTTPS 链接');
  if (url.href.length > maxUrlLength) fail(400, 'WEB_CAPTURE_INVALID_URL', '网页链接过长');
  if (!validDestination(url)) fail(422, 'WEB_CAPTURE_BLOCKED', '仅支持访问公开网页');
  return url.href;
}

function htmlTooLarge(): never {
  return fail(413, 'WEB_CAPTURE_TOO_LARGE', '网页超过 2 MiB，无法生成预览');
}

async function readHtml(response: IncomingMessage): Promise<string> {
  const contentType = response.headers['content-type'] ?? '';
  const type = contentType.split(';', 1)[0].trim().toLowerCase();
  if (type !== 'text/html' && type !== 'application/xhtml+xml')
    fail(415, 'WEB_CAPTURE_UNSUPPORTED', '该链接未返回 HTML 网页');
  const length = response.headers['content-length'];
  if (length !== undefined && Number(length) > maxHtmlBytes) htmlTooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response) {
    const bytes = chunk as Buffer;
    size += bytes.length;
    if (size > maxHtmlBytes) htmlTooLarge();
    chunks.push(bytes);
  }
  let body = Buffer.concat(chunks, size);
  const decompressOptions = { maxOutputLength: maxHtmlBytes };
  try {
    switch (response.headers['content-encoding']?.toLowerCase().trim()) {
      case 'br':
        body = brotliDecompressSync(body, decompressOptions);
        break;
      case 'gzip':
        body = gunzipSync(body, decompressOptions);
        break;
      case 'deflate':
        body = inflateSync(body, decompressOptions);
        break;
      case undefined:
      case 'identity':
        break;
      default:
        fail(415, 'WEB_CAPTURE_UNSUPPORTED', '网页使用了不支持的压缩格式');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') htmlTooLarge();
    if (error instanceof KnowledgeError) throw error;
    fail(502, 'WEB_CAPTURE_UNAVAILABLE', '无法读取网页返回的正文', true);
  }

  const headerCharset = /\bcharset\s*=\s*["']?([\w.-]+)/i.exec(contentType)?.[1];
  const beginning = body.subarray(0, 4096).toString('latin1');
  const metaCharset = /<meta\b[^>]*?\bcharset\s*=\s*["']?([\w.-]+)/i.exec(beginning)?.[1];
  let charset = headerCharset ?? metaCharset ?? 'utf-8';
  if (body[0] === 0xff && body[1] === 0xfe) charset = 'utf-16le';
  if (body[0] === 0xfe && body[1] === 0xff) charset = 'utf-16be';
  if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) charset = 'utf-8';
  try {
    return new TextDecoder(charset).decode(body);
  } catch {
    fail(415, 'WEB_CAPTURE_UNSUPPORTED', '网页使用了不支持的字符编码');
  }
}

export function previewWebPage(url: string): Promise<WebPagePreview> {
  return fetchWebPage(url);
}

export async function fetchWebPage(
  input: string,
  deps: RemoteDependencies & { timeoutMs?: number } = {},
): Promise<WebPagePreview> {
  const sourceUrl = normalizeWebCaptureUrl(input);
  const target = new URL(sourceUrl);
  target.hash = '';
  const { html, finalUrl } = await withPinnedPublicResponse(
    target.href,
    {
      ...deps,
      timeoutMs: deps.timeoutMs ?? 12_000,
      redirects: 3,
      headers: { Accept: 'text/html, application/xhtml+xml', 'Accept-Encoding': 'identity' },
      checkUrl(url) {
        if (url.port || url.href.length > maxUrlLength || !validDestination(url))
          throw new PublicHttpError('destination', 'redirect points to an unsupported destination');
      },
    },
    async (response, finalUrl) => ({ html: await readHtml(response), finalUrl }),
  ).catch((error: unknown) => {
    if (error instanceof KnowledgeError) throw error;
    if (error instanceof PublicHttpError) {
      if (error.kind === 'destination') fail(422, 'WEB_CAPTURE_BLOCKED', '仅支持访问公开网页');
      if (error.kind === 'timeout')
        fail(504, 'WEB_CAPTURE_TIMEOUT', '网页响应超时，请稍后重试', true);
    }
    fail(502, 'WEB_CAPTURE_UNAVAILABLE', '无法读取网页，请核对链接或稍后重试', true);
  });
  return { ...extractWebPage(html, finalUrl), sourceUrl };
}
