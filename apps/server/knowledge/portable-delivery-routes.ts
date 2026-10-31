import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import type { AppConfig } from '../../../shared/contracts.js';
import { portableResourceLimits as limits } from '../../../shared/portable-resource-limits.js';
import type { AppDatabase } from '../../../packages/core/db.js';
import type { NoteService } from '../../../packages/core/notes.js';
import { webPrincipal } from '../../../packages/core/knowledge/core.js';
import { fail } from '../../../packages/core/knowledge/errors.js';
import { portableDeliveryService } from '../../../packages/core/portable-delivery/service.js';
import { portableStaging } from '../../../packages/core/portable-delivery/staging.js';

const requestSchema = z
  .object({
    selection: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('single'), noteId: z.string().uuid() }).strict(),
      z
        .object({
          kind: z.literal('multiple'),
          noteIds: z.array(z.string().uuid()).min(1).max(limits.documents),
        })
        .strict(),
      z.object({ kind: z.literal('directory'), path: z.string().max(2000) }).strict(),
    ]),
    requestId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  })
  .strict();

/** Normal owner session, Origin and CSRF hooks apply. No machine-local path input is accepted. */
export function registerPortableDeliveryRoutes(
  app: FastifyInstance,
  db: AppDatabase,
  runtime: () => { config: AppConfig; notes: NoteService },
) {
  const service = () => {
    const current = runtime();
    return portableDeliveryService(current.config, db, current.notes);
  };
  const principal = (req: FastifyRequest) => {
    const owner = (req as any).ownerId;
    if (typeof owner !== 'string') fail(401, 'UNAUTHORIZED');
    return { ...webPrincipal, id: owner, clientId: 'portable-owner' };
  };
  app.post('/api/portable-deliveries', async (req, reply) =>
    reply.code(201).send(await service().create(principal(req), requestSchema.parse(req.body))),
  );
  app.get<{ Params: { id: string } }>(
    '/api/portable-deliveries/:id/download',
    async (req, reply) => {
      const current = service(),
        p = principal(req),
        metadata = current.metadata(p, req.params.id),
        stream = await current.download(p, req.params.id);
      return reply
        .header(
          'Content-Disposition',
          "attachment; filename*=UTF-8''" + encodeURIComponent(metadata.fileName),
        )
        .header('Content-Length', metadata.sizeBytes)
        .header('Content-Security-Policy', "default-src 'none'; sandbox")
        .type(metadata.mime)
        .send(stream);
    },
  );
  app.post(
    '/api/portable-deliveries/import',
    { bodyLimit: limits.packageBytes + 16384 },
    async (req, reply) => {
      const p = principal(req),
        current = runtime(),
        stage = await portableStaging(current.config, db);
      let archivePath: string | undefined;
      const fields: Record<string, string> = {};
      try {
        for await (const part of req.parts({
          limits: { fileSize: limits.packageBytes, files: 1, fields: 2, parts: 3, fieldSize: 2048 },
        })) {
          if (part.type === 'file') {
            if (part.fieldname !== 'archive' || archivePath) fail(400, 'INVALID_PORTABLE_UPLOAD');
            archivePath = join(stage.directory, 'archive.tar.gz');
            let bytes = 0;
            await pipeline(
              part.file,
              new Transform({
                transform(chunk, _encoding, callback) {
                  try {
                    bytes += chunk.length;
                    stage.resize(bytes);
                    callback(null, chunk);
                  } catch (error) {
                    callback(error as Error);
                  }
                },
              }),
              createWriteStream(archivePath, { flags: 'wx', mode: 0o600 }),
            );
            if (part.file.truncated) fail(413, 'PORTABLE_BUDGET_EXCEEDED');
          } else {
            if (
              !['folderPath', 'requestId'].includes(part.fieldname) ||
              Object.hasOwn(fields, part.fieldname) ||
              part.valueTruncated ||
              typeof part.value !== 'string'
            )
              fail(400, 'INVALID_PORTABLE_UPLOAD');
            fields[part.fieldname] = part.value;
          }
        }
        if (!archivePath || !fields.requestId) fail(400, 'INVALID_PORTABLE_UPLOAD');
        const result = await service().importArchive(p, {
          archivePath,
          folderPath: fields.folderPath ?? '00-Inbox',
          requestId: fields.requestId,
        });
        return reply.code(201).send(result);
      } finally {
        await stage.release();
      }
    },
  );
}
