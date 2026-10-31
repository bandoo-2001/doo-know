import {isDocument,isWhiteboard,MAX_WHITEBOARD_BYTES,parseWhiteboard} from '../../../shared/whiteboard.js';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { join, posix, extname } from 'node:path';
import { createHash } from 'node:crypto';
import type { ImportRequest, ImportPreview } from '../../../shared/transfer-contracts.js';
import { safePath, validName, validateRelative } from '../../../packages/core/files.js';
import { HttpError } from '../../../packages/core/errors.js';
import { localReference, references } from '../../../packages/core/render.js';
import { markdownDestinationSpans } from '../../../shared/markdown-destinations.js';
import { SVG_MIME } from '../../../shared/svg-policy.js';
import { validateSvgSource } from '../../../packages/core/svg.js';
import { DIAGRAM_SOURCE_MIMES, validateDiagramSource } from '../../../packages/core/knowledge/diagram-artifacts.js';

export const IMPORT_BODY_LIMIT = 30 * 1024 ** 2;
const mimeTypes: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.svg': SVG_MIME,
  ...DIAGRAM_SOURCE_MIMES,
};
/** Editable design snapshots beneath assets are attachments, never standalone whiteboard notes. */
export const isImportDocument = (path: string) => isDocument(path) && !path.split('/').includes('assets');
export const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
export function relativeInput(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 2000 ||
    value.includes('%') ||
    value.includes('\\') ||
    value.startsWith('/') ||
    value.split('/').some((p) => !validName(p))
  )
    throw new HttpError(400, '相对路径不允许');
  return value;
}
export function assetMime(path: string, bytes: Buffer) {
  const type = mimeTypes[extname(path).toLowerCase()];
  if (type === SVG_MIME) {
    const validation = validateSvgSource(bytes);
    if (!validation.ok) throw new HttpError(validation.code === 'size-limit' ? 413 : 400, validation.message);
    return type;
  }
  if (type === DIAGRAM_SOURCE_MIMES['.excalidraw'] || type === DIAGRAM_SOURCE_MIMES['.mmd']) {
    if (type === DIAGRAM_SOURCE_MIMES['.excalidraw'] && !path.split('/').includes('assets'))
      throw new HttpError(400, '白板源快照必须位于 assets 目录');
    validateDiagramSource(type === DIAGRAM_SOURCE_MIMES['.mmd'] ? 'mermaid' : 'excalidraw', bytes);
    return type;
  }
  const actual = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? 'image/png'
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      ? 'image/jpeg'
      : ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString())
        ? 'image/gif'
        : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP'
          ? 'image/webp'
          : bytes.subarray(0, 5).toString() === '%PDF-'
            ? 'application/pdf'
            : undefined;
  if (!type || actual !== type) throw new HttpError(400, '附件只允许真实 PNG/JPEG/GIF/WebP/PDF');
  return type;
}
/** Check existing ancestors even when several descendants do not exist yet. */
export function targetPath(root: string, relative: string, kind: 'note' | 'asset' | 'folder') {
  validateRelative(relative, kind);
  const base = realpathSync(root);
  let current = base;
  const parts = relative.split('/');
  for (let n = 0; n < parts.length; n++) {
    current = join(current, parts[n]);
    try {
      const info = lstatSync(current);
      if (
        info.isSymbolicLink() ||
        (info.nlink > 1 && !info.isDirectory()) ||
        (n < parts.length - 1 && !info.isDirectory()) ||
        (n === parts.length - 1 &&
          (kind === 'folder' ? !info.isDirectory() : kind === 'note' ? !info.isFile() : false))
      )
        throw new HttpError(400, '路径包含链接或无效目录');
    } catch (e) {
      if ((e as any).code === 'ENOENT') break;
      throw e;
    }
  }
  return join(base, relative);
}
export function parseImport(input: unknown): ImportRequest {
  const b = input as ImportRequest;
  if (
    !b ||
    !Array.isArray(b.entries) ||
    !b.entries.length ||
    b.entries.length > 200 ||
    !['skip', 'rename'].includes(b.collision)
  )
    throw new HttpError(400, '请选择 1–200 个文件和冲突策略');
  const folder = b.folderPath === undefined ? '00-Inbox' : b.folderPath;
  if (folder !== '') {
    relativeInput(folder);
    validateRelative(folder, 'folder');
  }
  const seen = new Set<string>();
  let total = 0;
  const entries = b.entries.map((entry) => {
    if (!entry || typeof entry.content !== 'string' || !['utf8', 'base64'].includes(entry.encoding))
      throw new HttpError(400, '文件格式不正确');
    const path = relativeInput(entry.path);
    if (seen.has(path)) throw new HttpError(400, '文件路径重复');
    seen.add(path);
    const bytes = entryBytes(entry);
    const note = isImportDocument(path);
    if (bytes.length > (note ? (isWhiteboard(path) ? MAX_WHITEBOARD_BYTES : 1024 ** 2) : 10 * 1024 ** 2))
      throw new HttpError(413, '单个文件超过导入上限');
    if (note) {
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        throw new HttpError(400, 'Markdown 必须是 UTF-8');
      }
    if (isWhiteboard(path)) { try { parseWhiteboard(bytes.toString('utf8')); } catch(e) { throw new HttpError(400, (e as Error).message); } }
    } else assetMime(path, bytes);
    total += bytes.length;
    if (total > 20 * 1024 ** 2) throw new HttpError(413, '导入总量不能超过 20 MiB');
    validateRelative(posix.join(folder, path), note ? 'note' : 'asset');
    return { path, encoding: entry.encoding, content: entry.content };
  });
  return { entries, folderPath: folder, collision: b.collision, requestId: b.requestId };
}
export function entryBytes(entry: ImportRequest['entries'][number]) {
  if (
    entry.encoding === 'base64' &&
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(entry.content)
  )
    throw new HttpError(400, 'Base64 编码不正确');
  return Buffer.from(entry.content, entry.encoding === 'base64' ? 'base64' : 'utf8');
}
export function importPreview(root: string, b: ImportRequest): ImportPreview {
  const reserved = new Set<string>();
  let totalBytes = 0;
  const items = b.entries.map((entry) => {
    const kind = isImportDocument(entry.path) ? ('note' as const) : ('asset' as const);
    let path = posix.join(b.folderPath || '', entry.path);
    targetPath(root, path, kind);
    const collision = existsSync(join(root, path)) || reserved.has(path);
    if (collision && b.collision === 'rename') {
      const ext = extname(path),
        parent = posix.dirname(path),
        stem = Array.from(posix.basename(path).slice(0, -ext.length));
      let count = 2;
      do {
        const suffix = ` (${count++})${ext}`,
          name = [...stem];
        while (Buffer.byteLength(name.join('') + suffix) > 180) name.pop();
        path = posix.join(parent, name.join('') + suffix);
        if (count > 10000) throw new HttpError(409, '同名文件过多');
        targetPath(root, path, kind);
      } while (existsSync(join(root, path)) || reserved.has(path));
    }
    reserved.add(path);
    const bytes = entryBytes(entry).length;
    totalBytes += bytes;
    return {
      path: entry.path,
      targetPath: path,
      kind,
      bytes,
      decision: collision
        ? b.collision === 'skip'
          ? ('skip' as const)
          : ('rename' as const)
        : ('create' as const),
    };
  });
  const mapped = new Set(items.map((i) => i.path)),
    warnings: string[] = [];
  for (const entry of b.entries.filter((e) => e.path.toLowerCase().endsWith('.md')))
    for (const source of references(entryBytes(entry).toString('utf8'))) {
      const local = localReference(entry.path, source);
      if (local && !mapped.has(local)) warnings.push(`${entry.path}: 未随批次提供引用 ${local}`);
    }
  return { items, totalBytes, warnings: [...new Set(warnings)].slice(0, 100) };
}
/** Rewrite only parsed link/image and reference-definition destination source spans. */
export function rewriteImportReferences(
  content: string,
  sourcePath: string,
  target: string,
  mapping: Map<string, string>,
) {
  const destinationFor = (url: string) => {
    const path = localReference(sourcePath, url),
      resolved = path && mapping.get(path);
    if (!resolved) return;
    const suffix = url.match(/[?#].*$/)?.[0] || '';
    return (
      posix.relative(posix.dirname(target), resolved).split('/').map(encodeURIComponent).join('/') +
      suffix
    );
  };
  if (
    !references(content).some((url) => {
      const next = destinationFor(url);
      return next !== undefined && next !== url;
    })
  )
    return content;
  const replacements = markdownDestinationSpans(content)
    .flatMap((span) => {
      let replacement = destinationFor(span.url);
      if (replacement === undefined || replacement === span.url) return [];
      if (span.wiki) {
        const path = decodeURIComponent(replacement.split(/[?#]/)[0]);
        // Wiki delimiters cannot express every valid filename. Fall back to an ordinary
        // explicit link while escaping its formerly plain-text label, rather than changing it.
        if (/[|#?\]\\\u0000-\u001f]/.test(path)) {
          replacement = `[${parserEscapeLabel(span.wiki.label)}](<${replacement}>)`;
        } else {
          replacement = `[[${path}${span.wiki.fragment}|${span.wiki.label}]]`;
          if (span.wiki.table) replacement = replacement.replaceAll('|', '\\|');
        }
      }
      return [{ ...span, replacement }];
    })
    .sort((a, b) => b.start - a.start);
  for (const span of replacements)
    content = content.slice(0, span.start) + span.replacement + content.slice(span.end);
  return content;
}

function parserEscapeLabel(label: string) {
  return label.replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g, '\\$&');
}
