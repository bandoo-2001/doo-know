import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import { MAX_WHITEBOARD_BYTES, parseWhiteboard } from '../../../shared/whiteboard.js';
import { SVG_MIME } from '../../../shared/svg-policy.js';
import type { AppDatabase } from '../db.js';
import type { NoteService } from '../notes.js';
import type { assetService } from '../assets.js';
import { HttpError } from '../errors.js';
import { validateSvgSource } from '../svg.js';
import { workspaceWriteSync } from '../workspace/gate.js';
import { beginOperation, completeOperation, existingResult, type OperationRow } from './operations.js';

export type DiagramKind = 'svg' | 'mermaid' | 'excalidraw';
export const DIAGRAM_SOURCE_MIMES = {
  '.mmd': 'text/plain',
  '.excalidraw': 'application/vnd.excalidraw+json',
} as const;
const formats = {
  svg: { extension: '.svg', mime: SVG_MIME },
  mermaid: { extension: '.mmd', mime: DIAGRAM_SOURCE_MIMES['.mmd'] },
  excalidraw: { extension: '.excalidraw', mime: DIAGRAM_SOURCE_MIMES['.excalidraw'] },
};
const maxPng = 10 * 1024 ** 2;
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

/** Validate source snapshots without normalizing or replacing their editable original bytes. */
export function validateDiagramSource(kind: DiagramKind, bytes: Uint8Array) {
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new HttpError(400, '图形源文件必须是有效 UTF-8');
  }
  if (kind === 'svg') {
    const validation = validateSvgSource(bytes);
    if (!validation.ok)
      throw new HttpError(validation.code === 'size-limit' ? 413 : 400, validation.message, { code: validation.code });
  } else if (kind === 'mermaid') {
    if (source.length > 50_000) throw new HttpError(413, '流程图内容不能超过 50000 个字符');
    if (!source.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(source))
      throw new HttpError(400, '流程图源文件必须是文本');
    // These snapshots are self-contained. Browser rendering separately checks the generated SVG.
    if (/\b(?:https?|ftp|file|data|javascript):|\/\/|@import\b|url\s*\(/i.test(source))
      throw new HttpError(400, '图形源文件不允许外部资源');
  } else {
    if (bytes.length > MAX_WHITEBOARD_BYTES) throw new HttpError(413, '白板文件不能超过 8 MiB');
    try {
      const scene = parseWhiteboard(source);
      if (scene.elements.some(element => ['embeddable', 'iframe'].includes(element.type)))
        throw Error('图形源文件不允许外部资源');
    } catch (cause) {
      throw new HttpError(400, (cause as Error).message);
    }
  }
  return source;
}

/** Check the real PNG signature and IHDR before accepting a bounded raster preview. */
function validatePng(bytes: Buffer) {
  if (bytes.length > maxPng) throw new HttpError(413, 'PNG 预览不能超过 10 MiB');
  if (
    bytes.length < 33 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.readUInt32BE(8) !== 13 || bytes.subarray(12, 16).toString('ascii') !== 'IHDR'
  ) throw new HttpError(400, '预览必须是有效的 PNG 图片');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width > 8192 || height > 8192 || width * height > 16_777_216)
    throw new HttpError(400, 'PNG 预览尺寸超限');
  const bitDepth = bytes[24], color = bytes[25];
  const validDepth: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
  if (!validDepth[color]?.includes(bitDepth) || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] > 1)
    throw new HttpError(400, '预览必须是有效的 PNG 图片');
  let offset = 33, image = false, end = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset), type = bytes.subarray(offset + 4, offset + 8).toString('ascii');
    if (length > bytes.length - offset - 12 || type === 'IHDR') break;
    if (type === 'IDAT' && length > 0) image = true;
    if (type === 'IEND') { end = length === 0 && offset + 12 === bytes.length; break; }
    offset += length + 12;
  }
  if (!image || !end) throw new HttpError(400, '预览必须是完整的 PNG 图片');
}

type Assets = ReturnType<typeof assetService>;
type Artifact = ReturnType<Assets['upload']>;
export type DiagramArtifacts = { sourceHash: string; preview: Artifact; source: Artifact };

export function diagramArtifactService(db: AppDatabase, notes: NoteService, assets: Assets, principal: Principal) {
  function prepare(noteId: string, value: unknown): DiagramArtifacts {
    const input = value as Record<string, unknown>;
    if (
      !input || !['svg', 'mermaid', 'excalidraw'].includes(input.kind as string) ||
      typeof input.source !== 'string' || typeof input.sourceHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(input.sourceHash) || typeof input.pngBase64 !== 'string' ||
      typeof input.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(input.requestId)
    ) throw new HttpError(400, '图形附件请求格式不正确');
    const kind = input.kind as DiagramKind, source = Buffer.from(input.source, 'utf8');
    const sourceHash = sha256(source);
    if (input.sourceHash !== sourceHash) throw new HttpError(400, '图形源码摘要不匹配');
    // Bound before decoding: JSON base64 must not allocate beyond the normal attachment limit.
    if (input.pngBase64.length > Math.ceil(maxPng / 3) * 4)
      throw new HttpError(413, 'PNG 预览不能超过 10 MiB');
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.pngBase64))
      throw new HttpError(400, 'PNG 预览 Base64 编码不正确');
    const png = Buffer.from(input.pngBase64, 'base64');
    if (png.toString('base64') !== input.pngBase64) throw new HttpError(400, 'PNG 预览 Base64 编码不正确');
    notes.exists(noteId);
    const operationKind = 'diagram-artifacts:' + noteId;
    const params = { noteId, kind, sourceHash, previewHash: sha256(png) };
    // Check retries before validation so a changed payload can never repurpose a receipt.
    const prior = db.prepare('SELECT * FROM operations WHERE principal=? AND client_id=? AND kind=? AND request_id=?')
      .get(principal.id, principal.clientId, operationKind, input.requestId) as OperationRow | undefined;
    if (prior) beginOperation(db, principal, operationKind, input.requestId, params);
    validateDiagramSource(kind, source);
    validatePng(png);
    // Commit the hash binding before any file write. A prepared receipt can be resumed after restart.
    const { operation } = db.transaction(() => beginOperation(db, principal, operationKind, input.requestId as string, params)).immediate();
    return db.transaction(() => {
      const current = db.prepare('SELECT * FROM operations WHERE id=?').get(operation.id) as OperationRow;
      if (current.status !== 'prepared') {
        const result = existingResult(current) as DiagramArtifacts;
        try {
          const savedSource = assets.file(result.source.relativePath), savedPreview = assets.file(result.preview.relativePath);
          if (sha256(savedSource.sourceBytes ?? savedSource.bytes) !== sourceHash || sha256(savedPreview.bytes) !== params.previewHash)
            throw new HttpError(409, '图形附件已变化，请核对原始文件');
        } catch {
          throw new HttpError(409, '图形附件已变化，请核对原始文件');
        }
        // Receipts bind immutable files. Their Markdown destinations belong to the note's
        // current directory, which can change before the user inserts the prepared group.
        const folder = posix.dirname(notes.exists(noteId).path);
        const rebase = (artifact: Artifact) => ({ ...artifact, markdownPath: posix.relative(folder, artifact.relativePath) });
        return { ...result, source: rebase(result.source), preview: rebase(result.preview) };
      }
      const format = formats[kind];
      const sourceAsset = assets.upload(noteId, 'diagram' + format.extension, format.mime, source, 'diagram-' + operation.id + '-source');
      const preview = assets.upload(noteId, 'diagram.png', 'image/png', png, 'diagram-' + operation.id + '-preview');
      const result = { sourceHash, preview, source: sourceAsset };
      completeOperation(db, operation.id, result);
      return result;
    }).immediate();
  }
  return {
    prepare: (noteId: string, input: unknown) => workspaceWriteSync(db, { kind: 'diagram-artifacts.prepare' }, () => prepare(noteId, input)),
  };
}
