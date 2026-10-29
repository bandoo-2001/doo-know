import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import type { AppDatabase } from '../db.js';
import { HttpError } from '../errors.js';
import { readKnowledgeDataFile, writeKnowledgeDataFile } from '../knowledge-data.js';
import { workspaceWriteSync } from '../workspace/gate.js';
import type { ToDooService, ToDooTask } from '../../../shared/to-doo-contracts.js';

const MAX_BYTES = 10 * 1024 * 1024;
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const hashBytes = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const allowed: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/plain',
  '.csv': 'text/plain',
  '.log': 'text/plain',
};
function sniff(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  )
    return 'image/webp';
  if (bytes.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  return null;
}
function validateFile(name: string, mime: string, bytes: Buffer) {
  if (!name || name.length > 256 || /[\x00-\x1f\x7f/\\]/.test(name))
    throw new HttpError(400, '附件名称不允许路径或控制字符');
  if (bytes.length > MAX_BYTES) throw new HttpError(413, '附件不能超过 10 MiB');
  const expected = allowed[extname(name).toLowerCase()];
  mime = mime.toLowerCase().split(';')[0].trim();
  if (!expected) throw new HttpError(400, '仅允许 PNG/JPEG/GIF/WebP、PDF 和纯文本附件');
  if (
    mime === '' ||
    mime === 'application/octet-stream' ||
    (expected === 'text/plain' &&
      ['text/csv', 'text/markdown', 'text/x-markdown'].includes(mime)) ||
    (expected === 'image/jpeg' && mime === 'image/jpg')
  )
    mime = expected;
  if (expected !== mime) throw new HttpError(400, '仅允许 PNG/JPEG/GIF/WebP、PDF 和纯文本附件');
  if (mime === 'text/plain') {
    let value: string;
    try {
      value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new HttpError(400, '纯文本附件必须为有效 UTF-8');
    }
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value))
      throw new HttpError(400, '纯文本附件包含二进制控制字符');
  } else if (sniff(bytes) !== mime) throw new HttpError(400, '附件内容与声明类型不一致');
  return mime;
}
export type ToDooAssetUpload = {
  taskId: string;
  name: string;
  mime: string;
  bytes: Buffer;
  requestId: string;
  expectedRevision: string;
};
export function createToDooAssets(
  service: ToDooService,
  options: { knowledgeRoot: string; db: AppDatabase },
) {
  function task(id: string): ToDooTask {
    if (!idPattern.test(id)) throw new HttpError(404, '任务附件不存在');
    const entity = service.getEntity('task', id) as ToDooTask | undefined;
    if (!entity || entity.deletedAt) throw new HttpError(404, '任务附件不存在');
    return entity;
  }
  function upload(input: ToDooAssetUpload) {
    if (!idPattern.test(input.requestId) || !idPattern.test(input.expectedRevision))
      throw new HttpError(400, '上传请求标识或版本不正确');
    const name = input.name.normalize('NFC'),
      mime = validateFile(name, input.mime, input.bytes);
    task(input.taskId);
    const hash = hashBytes(input.bytes),
      path = 'apps/to-doo/assets/' + hash;
    workspaceWriteSync(options.db, { kind: 'to-doo.asset.upload' }, () => {
      const existing = readKnowledgeDataFile(options.knowledgeRoot, path);
      if (existing) {
        if (hashBytes(existing) !== hash || !existing.equals(input.bytes))
          throw new HttpError(409, '附件哈希校验失败，请核对同步冲突');
        return;
      }
      try {
        writeKnowledgeDataFile(options.knowledgeRoot, path, input.bytes, null);
      } catch (error) {
        const raced = readKnowledgeDataFile(options.knowledgeRoot, path);
        if (!raced || !raced.equals(input.bytes)) throw error;
      }
    });
    // The immutable asset may outlive a failed CAS. Retrying never overwrites user data.
    return service.command({
      requestId: input.requestId,
      action: 'attach_asset',
      payload: {
        taskId: input.taskId,
        expectedRevision: input.expectedRevision,
        attachment: { hash, name, mime, size: input.bytes.length },
      },
    });
  }
  function get(taskId: string, hash: string) {
    if (!hashPattern.test(hash)) throw new HttpError(404, '任务附件不存在');
    return workspaceWriteSync(options.db, { kind: 'to-doo.asset.read' }, () => {
      const item = task(taskId).attachments.find((attachment) => attachment.hash === hash);
      if (!item) throw new HttpError(404, '任务附件不存在');
      const bytes = readKnowledgeDataFile(options.knowledgeRoot, 'apps/to-doo/assets/' + hash);
      if (!bytes) throw new HttpError(404, '附件内容尚未同步或已缺失');
      if (bytes.length !== item.size || hashBytes(bytes) !== hash)
        throw new HttpError(409, '附件内容损坏或哈希校验失败');
      validateFile(item.name, item.mime, bytes);
      return { ...item, bytes };
    });
  }
  function remove(input: {
    taskId: string;
    hash: string;
    requestId: string;
    expectedRevision: string;
  }) {
    if (
      !hashPattern.test(input.hash) ||
      !idPattern.test(input.requestId) ||
      !idPattern.test(input.expectedRevision)
    )
      throw new HttpError(400, '附件解除关联请求格式不正确');
    task(input.taskId);
    return service.command({
      requestId: input.requestId,
      action: 'detach_asset',
      payload: { taskId: input.taskId, hash: input.hash, expectedRevision: input.expectedRevision },
    });
  }
  return { upload, get, remove };
}
export type ToDooAssets = ReturnType<typeof createToDooAssets>;
