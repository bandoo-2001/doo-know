import {
  portableInputSnapshot,
  extractPortableStream,
  type PortableInputSnapshot,
} from '../../../packages/core/portable-delivery/input-snapshot.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { portableOwnerJobs } from './portable-owner-jobs.js';
import { stagePortableDirectory } from './portable-directory-upload.js';
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
  checkOwner?: (req: FastifyRequest) => void,
) {
  const jobs = portableOwnerJobs(db);
  const service = () => {
    const current = runtime();
    return portableDeliveryService(current.config, db, current.notes);
  };
  const principal = (req: FastifyRequest) => {
    const owner = (req as any).ownerId;
    if (typeof owner !== 'string') fail(401, 'UNAUTHORIZED');
    return { ...webPrincipal, id: owner, clientId: 'portable-owner' };
  };
  app.get<{ Params: { id: string } }>('/api/portable-previews/:id', async (req) => {
    checkOwner?.(req);
    return service().previews.get(principal(req), {
      previewId: z.string().uuid().parse(req.params.id),
    });
  });
  app.post<{ Params: { id: string } }>(
    '/api/portable-previews/:id/prepare',
    { bodyLimit: 15 * 1024 * 1024 },
    async (req) => {
      checkOwner?.(req);
      const input = z
        .object({
          sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
          pngBase64: z.string().max(Math.ceil((10 * 1024 ** 2) / 3) * 4),
          requestId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
        })
        .strict()
        .parse(req.body);
      return service().previews.prepare(principal(req), {
        ...input,
        previewId: z.string().uuid().parse(req.params.id),
      });
    },
  );
  app.post<{ Params: { id: string } }>('/api/portable-previews/:id/cancel', async (req) => {
    checkOwner?.(req);
    z.object({}).strict().parse(req.body);
    return service().previews.cancel(principal(req), z.string().uuid().parse(req.params.id));
  });
  app.post('/api/portable-deliveries', async (req, reply) => {
    const controller = new AbortController();
    const cancel = () => {
      if (!reply.raw.writableEnded) controller.abort(Error('PORTABLE_CANCELLED'));
    };
    reply.raw.once('close', cancel);
    try {
      const p = principal(req),
        input = requestSchema.parse(req.body);
      return reply.code(201).send(
        await jobs.run(
          p.id,
          input.requestId,
          'export',
          input,
          async (signal, checkJob) =>
            service().create(p, input, {
              signal,
              check: () => {
                checkJob();
                checkOwner?.(req);
                return principal(req);
              },
            }),
          controller.signal,
        ),
      );
    } finally {
      reply.raw.removeListener('close', cancel);
    }
  });
  app.get<{ Params: { id: string } }>(
    '/api/portable-deliveries/:id/download',
    async (req, reply) => {
      const current = service(),
        p = principal(req),
        metadata = current.metadata(p, req.params.id),
        stream = await current.download(p, req.params.id, {
          check: () => {
            checkOwner?.(req);
            return principal(req);
          },
        });
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
        current = runtime();
      const contextSchema = z
        .object({
          folderPath: z.string().max(2000),
          requestId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
        })
        .strict();
      const query = req.query as Record<string, unknown>;
      const early = Object.keys(query).length ? contextSchema.parse(query) : undefined;
      const stage = await portableStaging(current.config, db);
      const controller = new AbortController();
      const cancel = () => {
        if (!reply.raw.writableEnded) controller.abort(Error('PORTABLE_CANCELLED'));
      };
      reply.raw.once('close', cancel);
      const check = () => {
        if (controller.signal.aborted) fail(409, 'PORTABLE_CANCELLED');
        checkOwner?.(req);
        if (principal(req).id !== p.id) fail(403, 'FORBIDDEN');
      };
      let snapshot: PortableInputSnapshot | undefined,
        archivePath: string | undefined,
        fileSeen = false;
      const fields: Record<string, string> = {};
      try {
        for await (const part of req.parts({
          limits: { fileSize: limits.packageBytes, files: 1, fields: 2, parts: 3, fieldSize: 2048 },
        })) {
          if (part.type === 'file') {
            if (part.fieldname !== 'archive' || fileSeen) fail(400, 'INVALID_PORTABLE_UPLOAD');
            fileSeen = true;
            const target =
              early ??
              (fields.requestId
                ? contextSchema.parse({
                    folderPath: fields.folderPath ?? '00-Inbox',
                    requestId: fields.requestId,
                  })
                : undefined);
            if (target) {
              snapshot = portableInputSnapshot(
                current.config,
                db,
                current.notes,
                p,
                target.folderPath,
                stage,
              );
              await extractPortableStream(part.file, snapshot, stage.resize, () => {
                check();
                return principal(req);
              });
              if (part.file.truncated) fail(413, 'PORTABLE_BUDGET_EXCEEDED');
              continue;
            }
            // Legacy file-first callers retain the bounded spool path. Current callers
            // give fixed target context before the file so no duplicate archive is stored.
            archivePath = join(stage.directory, 'archive.tar.gz');
            let bytes = 0;
            await pipeline(
              part.file,
              new Transform({
                transform(chunk, _encoding, callback) {
                  try {
                    check();
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
        if (!fileSeen || (!archivePath && !snapshot)) fail(400, 'INVALID_PORTABLE_UPLOAD');
        const target = contextSchema.parse(
          early ?? { folderPath: fields.folderPath ?? '00-Inbox', requestId: fields.requestId },
        );
        if (
          early &&
          ((fields.requestId && fields.requestId !== early.requestId) ||
            (fields.folderPath !== undefined && fields.folderPath !== early.folderPath))
        )
          fail(400, 'INVALID_PORTABLE_UPLOAD');
        if (snapshot && snapshot.folderPath !== target.folderPath)
          fail(400, 'INVALID_PORTABLE_UPLOAD');
        const result = await jobs.run(
          p.id,
          target.requestId,
          'import-archive',
          { folderPath: target.folderPath },
          async (_signal, checkJob) => {
            const options = {
              check: () => {
                checkJob();
                check();
                checkOwner?.(req);
                return principal(req);
              },
            };
            return snapshot
              ? service().importDirectory(
                  p,
                  {
                    directoryPath: stage.directory,
                    folderPath: target.folderPath,
                    requestId: target.requestId,
                  },
                  { ...options, snapshot },
                )
              : service().importArchive(
                  p,
                  {
                    archivePath: archivePath!,
                    folderPath: target.folderPath,
                    requestId: target.requestId,
                  },
                  options,
                );
          },
          controller.signal,
        );
        await stage.release();
        return reply.code(201).send(result);
      } finally {
        reply.raw.removeListener('close', cancel);
        await stage.release();
      }
    },
  );
  app.post(
    '/api/portable-deliveries/import-directory',
    { bodyLimit: limits.packageBytes + 4 * 1024 * 1024 },
    async (req, reply) => {
      const p = principal(req),
        current = runtime(),
        stage = await portableStaging(current.config, db);
      let snapshot: PortableInputSnapshot | undefined,
        legacySource = false;
      const controller = new AbortController();
      const cancel = () => {
        if (!reply.raw.writableEnded) controller.abort(Error('PORTABLE_CANCELLED'));
      };
      reply.raw.once('close', cancel);
      const check = () => {
        if (controller.signal.aborted) fail(409, 'PORTABLE_CANCELLED');
        checkOwner?.(req);
        const next = principal(req);
        if (next.id !== p.id) fail(403, 'FORBIDDEN');
      };
      try {
        const input = await stagePortableDirectory(
          req,
          stage.directory,
          stage.resize,
          check,
          async (path, fields) => {
            if (!fields.requestId || fields.folderPath === undefined) {
              legacySource = true;
              return undefined;
            }
            if (legacySource) return undefined;
            snapshot ??= portableInputSnapshot(
              current.config,
              db,
              current.notes,
              p,
              fields.folderPath ?? '00-Inbox',
              stage,
            );
            return snapshot.allocate(path, principal(req));
          },
        );
        const result = await jobs.run(
          p.id,
          input.requestId,
          'import-directory',
          { folderPath: input.folderPath },
          async (_signal, checkJob) =>
            service().importDirectory(
              p,
              { ...input, directoryPath: stage.directory },
              {
                ...(snapshot ? { snapshot } : {}),
                check: () => {
                  checkJob();
                  check();
                  return principal(req);
                },
              },
            ),
          controller.signal,
        );
        await stage.release();
        return reply.code(201).send(result);
      } finally {
        reply.raw.removeListener('close', cancel);
        await stage.release();
      }
    },
  );
  app.get('/api/portable-jobs', async (req) => {
    checkOwner?.(req);
    return jobs.list(principal(req).id);
  });
  app.get<{ Params: { id: string } }>('/api/portable-jobs/:id', async (req) => {
    checkOwner?.(req);
    return jobs.read(principal(req).id, req.params.id);
  });
  app.post<{ Params: { id: string } }>('/api/portable-jobs/:id/cancel', async (req) => {
    checkOwner?.(req);
    const p = principal(req),
      job = jobs.read(p.id, req.params.id),
      cancelled = jobs.cancel(p.id, req.params.id);
    service().previews.cancelRequest(p, {
      requestId: job.requestId,
      direction: job.kind === 'export' ? 'export' : 'import',
    });
    return cancelled;
  });
  app.post<{ Params: { id: string } }>('/api/portable-jobs/:id/retry', async (req, reply) => {
    checkOwner?.(req);
    const p = principal(req),
      job = jobs.read(p.id, req.params.id);
    if (job.kind !== 'export')
      fail(409, 'PORTABLE_SOURCE_REQUIRED', '请重新选择原始整包或目录，并使用同一请求标识继续。');
    const input = requestSchema.parse(jobs.input(p.id, job.id));
    const result = await jobs.run(p.id, job.requestId, 'export', input, async (signal, checkJob) =>
      service().create(p, input, {
        signal,
        check: () => {
          checkJob();
          checkOwner?.(req);
          return principal(req);
        },
      }),
    );
    return reply.code(201).send(result);
  });
}
