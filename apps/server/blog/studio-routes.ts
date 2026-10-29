import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import type { BlogService } from '../../../packages/core/blog/service.js';
import { webPrincipal } from '../../../packages/core/knowledge/core.js';
import type {
  BlogSaveDesignInput,
  BlogPublishDesignInput,
  BlogRestoreDesignInput,
} from '../../../shared/blog-design.js';

export function registerBlogStudioRoutes(app: FastifyInstance, getBlog: () => BlogService) {
  const principal = (req: FastifyRequest): Principal => ({
    ...webPrincipal,
    id: (req as any).ownerId || 'web-owner',
    scopes: [...webPrincipal.scopes, 'blog:publish'],
  });
  app.get('/api/blog/design', (req) => getBlog().designState(principal(req)));
  app.patch('/api/blog/design', (req) =>
    getBlog().saveDesign(principal(req), req.body as BlogSaveDesignInput),
  );
  app.post('/api/blog/design/publish', (req) =>
    getBlog().publishDesign(principal(req), req.body as BlogPublishDesignInput),
  );
  app.post('/api/blog/design/restore', (req) =>
    getBlog().restoreDesign(principal(req), req.body as BlogRestoreDesignInput),
  );
  app.post('/api/blog/design/media', { bodyLimit: 8 * 1024 ** 2 }, (req) =>
    getBlog().uploadDesignMedia(
      principal(req),
      req.body as { name: string; mime: string; base64: string; requestId: string },
    ),
  );
  app.get<{ Params: { hash: string } }>('/api/blog/design/media/:hash', (req, reply) => {
    const media = getBlog().designMedia(principal(req), req.params.hash);
    return reply
      .header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .type(media.mime)
      .send(media.bytes);
  });
  app.get<{ Params: { id: string; versionId: string; hash: string } }>(
    '/api/blog/posts/:id/versions/:versionId/assets/:hash',
    (req, reply) => {
      const media = getBlog().managedResource(
        principal(req),
        req.params.id,
        req.params.hash,
        req.params.versionId,
      );
      reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
      if (media.mime === 'image/svg+xml')
        reply.header(
          'Content-Security-Policy',
          "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        );
      if (media.mime === 'application/pdf')
        reply.header('Content-Disposition', 'attachment; filename="document.pdf"');
      return reply.type(media.mime).send(media.bytes);
    },
  );
  app.get<{ Params: { id: string } }>('/api/blog/posts/:id/review', (req) =>
    getBlog().publicationReview(principal(req), req.params.id),
  );
}
