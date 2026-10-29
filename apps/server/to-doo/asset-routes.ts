import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ToDooAssets } from '../../../packages/core/to-doo/assets.js';
import { HttpError } from '../../../packages/core/errors.js';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const max = 10 * 1024 * 1024;
function disposition(name: string, inline: boolean) {
  const ascii = name.replace(/[^A-Za-z0-9._ -]/g, '_');
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase(),
  );
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
export function registerToDooAssetRoutes(app: FastifyInstance, getAssets: () => ToDooAssets) {
  app.post<{ Params: { id: string } }>(
    '/api/to-doo/tasks/:id/assets',
    { bodyLimit: max + 8192 },
    async (req, reply) => {
      const taskId = id.parse(req.params.id);
      let file: { name: string; mime: string; bytes: Buffer } | null = null;
      const fields: Record<string, string> = {};
      for await (const part of req.parts({
        limits: { files: 1, fields: 2, parts: 3, fileSize: max, fieldSize: 256 },
      })) {
        if (part.type === 'file') {
          if (part.fieldname !== 'file' || file) throw new HttpError(400, '每次请选择一个附件');
          const bytes = await part.toBuffer();
          if (part.file.truncated) throw new HttpError(413, '附件不能超过 10 MiB');
          file = { name: part.filename, mime: part.mimetype, bytes };
        } else {
          if (
            !['requestId', 'expectedRevision'].includes(part.fieldname) ||
            Object.hasOwn(fields, part.fieldname) ||
            typeof part.value !== 'string' ||
            part.valueTruncated
          )
            throw new HttpError(400, '上传字段格式不正确');
          fields[part.fieldname] = part.value;
        }
      }
      if (!file) throw new HttpError(400, '请选择附件');
      const input = z.object({ requestId: id, expectedRevision: id }).strict().parse(fields);
      const result = getAssets().upload({ taskId, ...input, ...file });
      return reply.code(result.replayed ? 200 : 201).send(result);
    },
  );
  app.get<{ Params: { id: string; hash: string }; Querystring: { preview?: string } }>(
    '/api/to-doo/tasks/:id/assets/:hash',
    (req, reply) => {
      const asset = getAssets().get(id.parse(req.params.id), hash.parse(req.params.hash));
      const inline =
        req.query.preview === 'true' &&
        ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(asset.mime);
      return reply
        .type(asset.mime)
        .header('Content-Disposition', disposition(asset.name, inline))
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cache-Control', 'private, no-store')
        .header('Content-Security-Policy', "default-src 'none'; sandbox; frame-ancestors 'none'")
        .send(asset.bytes);
    },
  );
  app.delete<{ Params: { id: string; hash: string } }>(
    '/api/to-doo/tasks/:id/assets/:hash',
    (req) =>
      getAssets().remove({
        taskId: id.parse(req.params.id),
        hash: hash.parse(req.params.hash),
        ...z.object({ requestId: id, expectedRevision: id }).strict().parse(req.body),
      }),
  );
}
