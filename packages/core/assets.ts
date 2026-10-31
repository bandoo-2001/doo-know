import { MEDIA_MIMES, mediaMime } from '../../shared/media.js';
import { inspectMediaFile } from './media.js';
import { assetStamp, openAsset, type AssetDescriptor } from './asset-stream.js';
import { portableStaging } from './portable-delivery/staging.js';
import { createWriteStream } from 'node:fs';
import { copyFile, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { portableResourceLimits } from '../../shared/portable-resource-limits.js';
export type { AssetDescriptor } from './asset-stream.js';
import { diagramCreationService } from './knowledge/diagram-creation.js';
import type { Principal } from '../../shared/knowledge-contracts.js';
import { fail } from './knowledge/errors.js';
import { workspaceWriteSync } from './workspace/gate.js';
import { randomUUID, createHash } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  writeFileSync,
  unlinkSync,
  openSync,
  readFileSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  linkSync,
} from 'node:fs';
import { dirname, join, extname, posix } from 'node:path';
import type { AppConfig, NoteDocument } from '../../shared/contracts.js';
import type { AppDatabase } from './db.js';
import type { NoteService } from './notes.js';
import { HttpError } from './errors.js';
import { safePath, sourceErrorCode } from './files.js';
import { references, localReference } from './render.js';
import { hasSavedAssetReference } from './knowledge/asset-references.js';
import { KnowledgeError } from './knowledge/errors.js';
import { SVG_MIME, SVG_POLICY } from '../../shared/svg-policy.js';
import { validateSvgSource } from './svg.js';
import { DIAGRAM_SOURCE_MIMES, validateDiagramSource } from './knowledge/diagram-artifacts.js';
const allowed: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.svg': SVG_MIME,
  ...DIAGRAM_SOURCE_MIMES,
  ...MEDIA_MIMES,
};
const max = 10 * 1024 * 1024;
function sniff(bytes: Buffer) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString())) return 'image/gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP')
    return 'image/webp';
  if (bytes.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
  return undefined;
}
export function assetService(config: AppConfig, db: AppDatabase, notes: NoteService) {
  function file(path: string) {
    const mime = allowed[extname(path).toLowerCase()];
    if (!mime) throw new HttpError(404, '附件不存在');
    if (mediaMime(path)) throw new HttpError(413, '媒体必须使用流式附件接口');
    const p = safePath(config.knowledgeRoot, path, 'asset');
    const fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const s = fstatSync(fd);
      if (!s.isFile() || s.size > (mime === SVG_MIME ? SVG_POLICY.maxBytes : max))
        throw new HttpError(404, '附件不存在');
      const bytes = readFileSync(fd);
      if (mime === SVG_MIME) {
        const result = validateSvgSource(bytes);
        if (!result.ok) throw new HttpError(404, '附件类型不允许');
        return { bytes: Buffer.from(result.presentation, 'utf8'), sourceBytes: bytes, mime };
      }
      if (mime === DIAGRAM_SOURCE_MIMES['.mmd'] || mime === DIAGRAM_SOURCE_MIMES['.excalidraw']) {
        if (mime === DIAGRAM_SOURCE_MIMES['.excalidraw'] && !path.split('/').includes('assets'))
          throw new HttpError(404, '附件不存在');
        validateDiagramSource(
          mime === DIAGRAM_SOURCE_MIMES['.mmd'] ? 'mermaid' : 'excalidraw',
          bytes,
        );
        return { bytes, mime };
      }
      if (sniff(bytes) !== mime) throw new HttpError(404, '附件类型不允许');
      return { bytes, mime };
    } finally {
      closeSync(fd);
    }
  }
  function inspect(path: string): AssetDescriptor {
    const mime = allowed[extname(path).toLowerCase()];
    if (!mime) throw new HttpError(404, '附件不存在');
    const absolutePath = safePath(config.knowledgeRoot, path, 'asset');
    const before = assetStamp(absolutePath);
    if (mediaMime(path)) inspectMediaFile(absolutePath, mime);
    else file(path);
    if (assetStamp(absolutePath) !== before) throw new HttpError(409, '附件已变化');
    return { path, absolutePath, mime, sizeBytes: lstatSync(absolutePath).size, stamp: before };
  }
  function inspectById(id: string) {
    const row = db.prepare('SELECT path FROM assets WHERE id=?').get(id) as
      | { path: string }
      | undefined;
    if (!row) throw new HttpError(404, '附件不存在');
    return inspect(row.path);
  }
  function register(path: string) {
    inspect(path);
    let a = db.prepare('SELECT id,path FROM assets WHERE path=?').get(path) as
      | { id: string; path: string }
      | undefined;
    if (!a) {
      a = { id: randomUUID(), path };
      db.prepare('INSERT INTO assets(id,path) VALUES(?,?)').run(a.id, path);
    }
    return { id: a.id, relativePath: path, mime: allowed[extname(path).toLowerCase()] };
  }
  function byId(id: string) {
    const a = db.prepare('SELECT path FROM assets WHERE id=?').get(id) as
      | { path: string }
      | undefined;
    if (!a) throw new HttpError(404, '附件不存在');
    try {
      return { path: a.path, ...file(a.path) };
    } catch {
      throw new HttpError(404, '附件不存在');
    }
  }
  function paths(n: NoteDocument) {
    return references(n.content)
      .map((url) => localReference(n.relativePath, url))
      .filter((p): p is string => !!p && !!allowed[extname(p).toLowerCase()]);
  }
  function mapUrl(n: NoteDocument, url: string, prefix = '/api/assets/') {
    const path = localReference(n.relativePath, url);
    if (!path) return;
    try {
      return prefix + register(path).id;
    } catch {
      return;
    }
  }
  function candidatePaths(id: string) {
    const n = notes.exists(id),
      found = new Set<string>();
    try {
      for (const path of paths(notes.getNote(id))) found.add(path);
    } catch (e) {
      if (!(e instanceof KnowledgeError) || e.code !== 'LARGE_FILE_MODE_REQUIRED') throw e;
    }
    const rel = `${dirname(n.path) === '.' ? '' : dirname(n.path) + '/'}assets`;
    try {
      const dir = safePath(config.knowledgeRoot, rel, 'asset');
      for (const entry of readdirSync(dir, { withFileTypes: true }))
        if (entry.isFile() && !entry.isSymbolicLink()) found.add(`${rel}/${entry.name}`);
    } catch {}
    return [...found];
  }
  function list(id: string) {
    return candidatePaths(id).flatMap((p) => {
      try {
        return [register(p)];
      } catch {
        return [];
      }
    });
  }
  function upload(
    id: string,
    name: string,
    mime: string,
    bytes: Buffer,
    requestId?: unknown,
    reservedTarget?: { path: string },
  ) {
    if (
      requestId !== undefined &&
      (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(requestId))
    )
      throw new HttpError(400, '上传请求标识不正确');
    const n = reservedTarget || notes.exists(id);
    if (bytes.length > max) throw new HttpError(413, '附件不能超过 10 MiB');
    const ext = extname(name).toLowerCase();
    if (mediaMime(name)) throw new HttpError(400, '媒体必须使用流式上传接口');
    if (!allowed[ext] || allowed[ext] !== mime)
      throw new HttpError(400, '仅允许真实 PNG/JPEG/GIF/WebP 图片、受限 SVG 和 PDF');
    if (mime === SVG_MIME) {
      const result = validateSvgSource(bytes);
      if (!result.ok)
        throw new HttpError(result.code === 'size-limit' ? 413 : 400, result.message, {
          code: result.code,
        });
    } else if (
      mime === DIAGRAM_SOURCE_MIMES['.mmd'] ||
      mime === DIAGRAM_SOURCE_MIMES['.excalidraw']
    ) {
      validateDiagramSource(
        mime === DIAGRAM_SOURCE_MIMES['.mmd'] ? 'mermaid' : 'excalidraw',
        bytes,
      );
    } else if (sniff(bytes) !== mime)
      throw new HttpError(400, '仅允许真实 PNG/JPEG/GIF/WebP 图片、受限 SVG 和 PDF');
    const folder = dirname(n.path);
    const rel = folder === '.' ? 'assets' : `${folder}/assets`;
    const directory = safePath(config.knowledgeRoot, rel, 'asset', true);
    try {
      mkdirSync(directory, { mode: 0o700 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory())
      throw new HttpError(400, '附件目录不允许');
    const uploadKey = requestId
      ? (requestId.startsWith('diagram-') ? 'diagram-' : 'upload-') +
        createHash('sha256')
          .update(id + '\0' + requestId)
          .digest('hex')
      : randomUUID();
    const path = `${rel}/${uploadKey}${ext}`,
      target = safePath(config.knowledgeRoot, path, 'asset', true);
    if (requestId) {
      for (const candidateExt of Object.keys(allowed)) {
        const candidate = safePath(
          config.knowledgeRoot,
          `${rel}/${uploadKey}${candidateExt}`,
          'asset',
          true,
        );
        try {
          const info = lstatSync(candidate);
          if (
            candidateExt !== ext ||
            !info.isFile() ||
            info.isSymbolicLink() ||
            info.nlink !== 1 ||
            !readFileSync(candidate).equals(bytes)
          )
            throw new HttpError(409, '同一上传请求的附件内容已变化');
          return { ...register(path), markdownPath: posix.relative(folder, path) };
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
        }
      }
    }
    writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
    try {
      const a = register(path);
      return { ...a, markdownPath: posix.relative(folder, path) };
    } catch (e) {
      // Stable upload IDs are retry receipts: keep immutable partial files for the same request.
      if (!requestId) unlinkSync(target);
      throw e;
    }
  }
  async function savedAsset(noteId: string, path: string) {
    const note = notes.exists(noteId);
    // Native diagram originals are authorized only by the semantic public projection facade.
    if (/\.(?:excalidraw|mmd)$/i.test(path)) fail(403, 'DIAGRAM_SOURCE_FORBIDDEN');
    if (!allowed[extname(path).toLowerCase()]) throw new HttpError(404, '附件不存在');
    if (!(await hasSavedAssetReference(notes.readableSource(noteId).file, note.path, path)))
      throw new HttpError(404, '附件不存在');
    return { path, ...file(path) };
  }
  async function publicAsset(noteId: string, id: string) {
    const a = db.prepare('SELECT path FROM assets WHERE id=?').get(id) as
      | { path: string }
      | undefined;
    if (!a) throw new HttpError(404, '附件不存在');
    return savedAsset(noteId, a.path);
  }
  async function publicSource(noteId: string, source: string) {
    const note = notes.exists(noteId),
      path = localReference(note.path, source);
    if (!path) throw new HttpError(404, '附件不存在');
    return savedAsset(noteId, path);
  }
  async function publicInspect(noteId: string, lookup: { id?: string; source?: string }) {
    const note = notes.exists(noteId);
    const path = lookup.id
      ? inspectById(lookup.id).path
      : localReference(note.path, lookup.source || '');
    if (!path) throw new HttpError(404, '附件不存在');
    if (/\.(?:excalidraw|mmd)$/i.test(path)) fail(403, 'DIAGRAM_SOURCE_FORBIDDEN');
    if (!(await hasSavedAssetReference(notes.readableSource(noteId).file, note.path, path)))
      throw new HttpError(404, '附件不存在');
    return inspect(path);
  }
  async function uploadStream(
    id: string,
    name: string,
    mime: string,
    stream: AsyncIterable<Uint8Array>,
    requestId?: unknown,
    options: { check?: () => void } = {},
  ) {
    if (
      requestId !== undefined &&
      (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(requestId))
    )
      throw new HttpError(400, '上传请求标识不正确');
    const note = notes.exists(id),
      expectedPath = note.path,
      ext = extname(name).toLowerCase();
    if (!allowed[ext] || allowed[ext] !== mime)
      throw new HttpError(400, '附件扩展名与 MIME 不匹配');
    const maximum = mediaMime(name) ? portableResourceLimits.mediaBytes : max;
    const stage = await portableStaging(config, db);
    const staged = join(stage.directory, 'upload' + ext);
    let total = 0,
      prepared: string | undefined;
    try {
      await pipeline(
        Readable.from(stream),
        new Transform({
          transform(chunk, _encoding, callback) {
            try {
              options.check?.();
              total += chunk.length;
              if (total > maximum) throw new HttpError(413, '附件超过配置配额');
              stage.resize(total);
              callback(null, chunk);
            } catch (e) {
              callback(e as Error);
            }
          },
        }),
        createWriteStream(staged, { flags: 'wx', mode: 0o600 }),
      );
      if (mediaMime(name)) inspectMediaFile(staged, mime);
      else {
        const bytes = readFileSync(staged);
        if (mime === SVG_MIME) {
          const result = validateSvgSource(bytes);
          if (!result.ok)
            throw new HttpError(result.code === 'size-limit' ? 413 : 400, result.message, {
              code: result.code,
            });
        } else if (
          mime === DIAGRAM_SOURCE_MIMES['.mmd'] ||
          mime === DIAGRAM_SOURCE_MIMES['.excalidraw']
        )
          validateDiagramSource(
            mime === DIAGRAM_SOURCE_MIMES['.mmd'] ? 'mermaid' : 'excalidraw',
            bytes,
          );
        else if (sniff(bytes) !== mime) throw new HttpError(400, '附件 MIME 与文件结构不匹配');
      }
      const folder = dirname(expectedPath),
        rel = folder === '.' ? 'assets' : folder + '/assets';
      workspaceWriteSync(db, { kind: 'asset.prepare-upload' }, () => {
        if (notes.exists(id).path !== expectedPath) throw new HttpError(409, '笔记已移动');
        const dir = safePath(config.knowledgeRoot, rel, 'asset', true);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        safePath(config.knowledgeRoot, rel, 'asset');
      });
      const key = requestId
        ? 'upload-' +
          createHash('sha256')
            .update(id + '\0' + requestId)
            .digest('hex')
        : randomUUID();
      const path = rel + '/' + key + ext,
        target = safePath(config.knowledgeRoot, path, 'asset', true);
      prepared = join(dirname(target), '.upload-' + randomUUID());
      // Copy outside the workspace lock; publication below uses an exclusive same-directory link.
      stage.resize(total * 2);
      await copyFile(staged, prepared, constants.COPYFILE_EXCL);
      const { hashFile } = await import('./portable-delivery/manifest.js');
      const hash = await hashFile(prepared!);
      let retry: { path: string; descriptor: AssetDescriptor } | undefined;
      if (requestId)
        for (const suffix of Object.keys(allowed)) {
          const candidate = rel + '/' + key + suffix;
          try {
            const descriptor = inspect(candidate);
            if (suffix !== ext || (await hashFile(descriptor.absolutePath)) !== hash)
              throw new HttpError(409, '同一上传请求的附件内容已变化');
            retry = { path: candidate, descriptor };
            break;
          } catch (e) {
            if (sourceErrorCode(e) !== 'ENOENT') throw e;
          }
        }
      return workspaceWriteSync(db, { kind: 'asset.upload' }, () => {
        options.check?.();
        if (notes.exists(id).path !== expectedPath) throw new HttpError(409, '笔记已移动');
        safePath(config.knowledgeRoot, rel, 'asset');
        if (retry) {
          if (assetStamp(retry.descriptor.absolutePath) !== retry.descriptor.stamp)
            throw new HttpError(409, '附件已变化');
          return { ...register(retry.path), markdownPath: posix.relative(folder, retry.path) };
        }
        if (lstatSync(prepared!).size !== total) throw new HttpError(409, '上传暂存已变化');
        try {
          linkSync(prepared!, target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST')
            throw new HttpError(409, '附件已发布，请重试同一上传请求');
          throw error;
        }
        unlinkSync(prepared!);
        prepared = undefined;
        return { ...register(path), markdownPath: posix.relative(folder, path) };
      });
    } finally {
      if (prepared) await unlink(prepared).catch(() => {});
      await stage.release();
    }
  }
  return {
    inspect,
    inspectById,
    publicInspect,
    open: openAsset,
    uploadStream,
    file,
    register,
    byId,
    mapUrl,
    list,
    candidatePaths,
    upload: (id: string, name: string, mime: string, bytes: Buffer, requestId?: unknown) =>
      workspaceWriteSync(db, { kind: 'asset.upload' }, () =>
        upload(id, name, mime, bytes, requestId),
      ),
    uploadForDiagramCreation: (
      principal: Principal,
      intentId: string,
      name: string,
      mime: string,
      bytes: Buffer,
      requestId: string,
    ) =>
      workspaceWriteSync(db, { kind: 'asset.diagram-creation' }, () => {
        const intent = diagramCreationService(config, db, principal).get(intentId);
        if (!['reserved', 'prepared'].includes(intent.status))
          fail(409, 'CREATION_INTENT_UNAVAILABLE');
        return upload(intent.noteId, name, mime, bytes, requestId, { path: intent.relativePath });
      }),
    publicAsset,
    publicSource,
  };
}
