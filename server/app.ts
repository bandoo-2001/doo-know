import Fastify from 'fastify';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import csrf from '@fastify/csrf-protection';
import multipart from '@fastify/multipart';
import staticPlugin from '@fastify/static';
import { fromNodeHeaders } from 'better-auth/node';
import type { AppConfig } from '../shared/contracts.js';
import type { HostConfig } from '../shared/platform-contracts.js';
import { platformRuntime, lazyService } from './platform/runtime.js';
import { openDatabase } from './db.js';
import { createAuth } from './auth.js';
import { noteService, saveInput } from './notes.js';
import { HttpError, text } from './errors.js';
import { shareService } from './shares.js';
import { renderMarkdown } from './render.js';
import { recoveryService } from './recovery.js';
import { assetService } from './assets.js';
import { registerAgentRoutes } from './agent/routes.js';
import { registerWebKnowledgeRoutes } from './knowledge/web-routes.js';
import { webPrincipal } from './knowledge/core.js';
import { KnowledgeError } from './knowledge/errors.js';
export async function createApp(config: HostConfig) {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  const db = openDatabase(config.dataRoot);
  const auth = await createAuth(config, db);
  const platform = platformRuntime(config, db);
  await platform.activate();
  const businessConfig = new Proxy(config as AppConfig, { get: (target, key) =>
    key === 'knowledgeRoot' ? platform.settings.configured()?.knowledgeRoot : (target as any)[key] });
  await app.register(cookie, { secret: config.secret });
  await app.register(csrf, {
    cookieOpts: {
      signed: true,
      httpOnly: true,
      sameSite: 'strict',
      secure: config.origin.startsWith('https:'),
      path: '/',
    },
    getToken: (req) => req.headers['x-csrf-token'] as string,
  });
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 0 } });
  app.addHook('onRequest', async (req, reply) => {
    reply
      .header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer');
    if (
      !req.url.startsWith('/api/') ||
      req.url.startsWith('/api/auth/') ||
      req.url.startsWith('/api/public/')
    )
      return;
    if (req.url.startsWith('/api/agent/v1/')) return;
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!session) return reply.code(401).send({ error: '请登录后访问' });
    (req as any).ownerId = session.user.id;
    if (
      (db.prepare('SELECT active FROM maintenance WHERE id=1').get() as { active: number }).active
    )
      return reply.code(503).send({ error: '维护中，请稍后重试' });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.headers.origin !== config.origin)
        return reply.code(403).send({ error: '请求来源不被允许' });
      await new Promise<void>((resolve, reject) => {
        app.csrfProtection(req, reply, () => resolve());
        if (reply.sent) resolve();
      });
    }
    if (!req.url.startsWith('/api/platform/') && !req.url.startsWith('/api/security/'))
      platform.get();
  });
  const authPaths = new Set([
    '/api/auth/sign-in/username',
    '/api/auth/sign-out',
    '/api/auth/get-session',
    '/api/auth/change-password',
  ]);
  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    handler: async (req, reply) => {
      const path = req.url.split('?')[0];
      if (!authPaths.has(path)) return reply.code(404).send({ error: '接口不存在' });
      if (req.method === 'POST' && req.headers.origin !== config.origin)
        return reply.code(403).send({ error: '请求来源不被允许' });
      if (path.endsWith('change-password') && req.body && typeof req.body === 'object')
        Object.assign(req.body, { revokeOtherSessions: true });
      const response = await auth.handler(
        new Request(new URL(req.url, config.origin), {
          method: req.method,
          headers: fromNodeHeaders(req.headers),
          ...(req.body ? { body: JSON.stringify(req.body) } : {}),
        }),
      );
      reply.code(response.status);
      response.headers.forEach((v, k) => {
        if (k !== 'set-cookie') reply.header(k, v);
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) reply.header('set-cookie', cookies);
      return reply.send(await response.text());
    },
  });
  app.get('/api/security/csrf', async (_req, reply) => ({ token: reply.generateCsrf() }));
  app.get('/healthz', async () => ({ status: 'alive' }));
  app.get('/readyz', async (_req, reply) => {
    const ready = platform.status().components.knowledge;
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready' });
  });
  app.get('/api/platform/status', async () => platform.status());
  app.post('/api/platform/setup/validate', async (req) =>
    platform.settings.validate((req as any).ownerId, (req.body as any)?.knowledgeRoot));
  app.post('/api/platform/setup/complete', async (req) => {
    const receipt = platform.settings.complete((req as any).ownerId, req.body);
    void platform.activate();
    return receipt;
  });
  const notes = lazyService(() => platform.get().notes);
  const knowledge = await registerAgentRoutes(app, businessConfig, db, notes, () => platform.get().knowledge);
  app.get('/api/tree', async () => notes.tree());
  app.get('/api/notes', async (req) => {
    notes.scan();
    const folder = (req.query as { folder?: string }).folder;
    return Promise.all(
      (
        db.prepare('SELECT id,path FROM notes WHERE active=1').all() as {
          id: string;
          path: string;
        }[]
      )
        .filter((n) => !folder || n.path.startsWith(folder + '/'))
        .map((n) => knowledge.info(webPrincipal, n.id)),
    );
  });
  app.get<{ Params: { id: string } }>('/api/notes/:id', async (req) =>
    notes.getNote(req.params.id),
  );
  app.post('/api/notes', async (req, reply) => {
    const b = req.body as Record<string, unknown>;
    return reply
      .code(201)
      .send(
        notes.createNote(
          text(b?.folderPath, '目录', 1000),
          text(b?.fileName, '文件名', 180),
          text(b?.content, '正文'),
          typeof b?.requestId === 'string' ? b.requestId : undefined,
        ),
      );
  });
  app.put<{ Params: { id: string } }>('/api/notes/:id', async (req) => {
    const b = saveInput(req.body);
    return notes.saveNote(
      req.params.id,
      b.content,
      b.expectedModifiedAt,
      typeof (req.body as any)?.requestId === 'string' ? (req.body as any).requestId : undefined,
    );
  });
  app.post('/api/folders', async (req, reply) => {
    const b = req.body as Record<string, unknown>;
    return reply
      .code(201)
      .send(notes.createFolder(text(b?.parent, '目录', 1000), text(b?.name, '名称', 180)));
  });
  const assets = lazyService(() => platform.get().assets);
  app.get('/api/search', async (req) => {
    const q = text((req.query as { q?: unknown }).q || '', '搜索词', 512);
    if (!q.trim()) return [];
    const result = await knowledge.search.search(webPrincipal, {
      query: '\"' + q + '\"',
      mode: 'text',
    });
    return result.results.map((r) => ({
      id: r.noteId,
      title: r.title,
      relativePath: r.relativePath,
      snippet: r.matches[0]?.snippet || '',
      updatedAt: new Date().toISOString(),
    }));
  });
  app.get<{ Params: { id: string } }>('/api/notes/:id/assets', async (req) =>
    assets.list(req.params.id),
  );
  app.post<{ Params: { id: string } }>('/api/notes/:id/assets', async (req, reply) => {
    notes.exists(req.params.id);
    const part = await req.file();
    if (!part) throw new HttpError(400, '请选择附件');
    const bytes = await part.toBuffer();
    return reply.code(201).send(assets.upload(req.params.id, part.filename, part.mimetype, bytes));
  });
  const sendAsset = (reply: import('fastify').FastifyReply, a: { bytes: Buffer; mime: string }) =>
    reply
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Content-Disposition', 'inline')
      .type(a.mime)
      .send(a.bytes);
  app.get<{ Params: { id: string } }>('/api/assets/:id', async (req, reply) =>
    sendAsset(reply, assets.byId(req.params.id)),
  );
  const recovery = lazyService(() => platform.get().recovery);
  app.get<{ Params: { id: string } }>('/api/notes/:id/revisions', async (req) => {
    const rows = recovery.history(req.params.id, (req.query as any).cursor);
    return { items: rows.slice(0, 50), ...(rows.length > 50 ? { nextCursor: rows[49].id } : {}) };
  });
  app.post<{ Params: { id: string; revisionId: string } }>(
    '/api/notes/:id/revisions/:revisionId/restore',
    async (req) => {
      const b = req.body as { expectedModifiedAt?: unknown };
      const input = saveInput({ content: '', expectedModifiedAt: b?.expectedModifiedAt });
      const revision = db
        .prepare('SELECT file FROM revisions WHERE id=? AND note_id=?')
        .get(req.params.revisionId, req.params.id) as { file: string } | undefined;
      if (revision) {
        const info = await knowledge.info(webPrincipal, req.params.id);
        if (
          info.editorMode !== 'full' ||
          statSync(join(config.dataRoot, 'history', revision.file)).size > 1024 * 1024
        )
          return knowledge.files.restore(
            webPrincipal,
            req.params.id,
            req.params.revisionId,
            input.expectedModifiedAt,
            typeof (b as any).requestId === 'string' ? (b as any).requestId : randomUUID(),
          );
      }
      return recovery.restoreRevision(
        req.params.id,
        req.params.revisionId,
        input.expectedModifiedAt,
        typeof (b as any).requestId === 'string' ? (b as any).requestId : undefined,
      );
    },
  );
  app.delete<{ Params: { id: string } }>('/api/notes/:id', async (req) => {
    const b = req.body as any;
    const input = saveInput({ content: '', expectedModifiedAt: b?.expectedModifiedAt });
    return recovery.deleteNote(
      req.params.id,
      input.expectedModifiedAt,
      text(b?.requestId, '请求标识', 128),
    );
  });
  app.get('/api/trash', async () => recovery.trash());
  app.post<{ Params: { id: string } }>('/api/notes/:id/restore', async (req) => {
    const b = req.body as { fileName?: unknown; requestId?: unknown } | undefined;
    const restored = recovery.restore(
      req.params.id,
      b?.fileName === undefined ? undefined : text(b.fileName, '文件名', 180),
      typeof b?.requestId === 'string' ? b.requestId : undefined,
    );
    if (!('metadataOnly' in restored)) return restored;
    const fallback = {
      ...restored.receipt,
      receipt: restored.receipt,
      editorMode: 'metadata',
      readState: 'unknown',
      currentReadError: restored.currentReadError || 'CURRENT_READ_UNAVAILABLE',
    };
    if (restored.currentReadError) return fallback;
    try {
      return { ...(await knowledge.info(webPrincipal, req.params.id)), receipt: restored.receipt };
    } catch {
      return fallback;
    }
  });
  const shares = lazyService(() => platform.get().shares);
  await registerWebKnowledgeRoutes(
    app,
    businessConfig,
    db,
    knowledge,
    shares,
    async (req) => !!(await auth.api.getSession({ headers: fromNodeHeaders(req.headers) })),
  );
  app.get<{ Params: { id: string } }>('/api/notes/:id/share', async (req) =>
    shares.status(req.params.id),
  );
  app.post<{ Params: { id: string } }>('/api/notes/:id/share', async (req) =>
    shares.create(req.params.id),
  );
  app.post<{ Params: { id: string } }>('/api/notes/:id/share/reset', async (req) =>
    shares.create(req.params.id, true),
  );
  app.delete<{ Params: { id: string } }>('/api/notes/:id/share', async (req) =>
    shares.revoke(req.params.id),
  );
  app.get<{ Params: { token: string } }>('/api/public/shares/:token', async (req, reply) => {
    const n = shares.document(req.params.token);
    reply.header('X-Robots-Tag', 'noindex, nofollow');
    return {
      title: n.title,
      updatedAt: n.updatedAt,
      ...renderMarkdown(n.content, (url) =>
        assets.mapUrl(n, url, `/api/public/shares/${req.params.token}/assets/`),
      ),
    };
  });
  app.get<{ Params: { token: string; assetId: string } }>(
    '/api/public/shares/:token/assets/:assetId',
    async (req, reply) => {
      const note = shares.lookup(req.params.token);
      const asset = await assets.publicAsset(note.id, req.params.assetId);
      if (shares.lookup(req.params.token).id !== note.id)
        throw new HttpError(404, '分享不存在或已取消');
      return sendAsset(reply, asset);
    },
  );
  app.get<{ Params: { token: string }; Querystring: { source?: string } }>(
    '/api/public/shares/:token/asset',
    async (req, reply) => {
      const note = shares.lookup(req.params.token);
      const asset = await assets.publicSource(note.id, text(req.query.source, '附件引用', 8192));
      if (shares.lookup(req.params.token).id !== note.id)
        throw new HttpError(404, '分享不存在或已取消');
      return sendAsset(reply, asset);
    },
  );
  if (config.staticRoot) {
    app.get('/', async (_req, reply) => reply.sendFile('index.html'));
    app.get('/s/:token', async (_req, reply) =>
      reply.header('X-Robots-Tag', 'noindex, nofollow').sendFile('index.html'),
    );
    await app.register(staticPlugin, { root: config.staticRoot, index: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || (!req.url.startsWith('/s/') && req.url !== '/'))
        return reply.code(404).send({ error: '页面不存在' });
      reply.header('X-Robots-Tag', 'noindex, nofollow');
      return reply.sendFile('index.html');
    });
  }
  app.setErrorHandler((err, req, reply) => {
    if (req.url.startsWith('/api/public/') && !platform.status().components.knowledge)
      return reply.code(404).send({ error: '分享不存在或已不可用' });
    const error = err as Error & { statusCode?: number };
    const status =
      error.statusCode &&
      error.statusCode >= 400 &&
      (error.statusCode < 500 || error instanceof KnowledgeError)
        ? error.statusCode
        : 500;
    reply.code(status).send({
      error: status === 500 ? '操作失败，内容未标记为保存' : error.message,
      ...(error instanceof HttpError ? error.details : {}),
      ...(error instanceof KnowledgeError ? { code: error.code, retryable: error.retryable } : {}),
    });
  });
  app.addHook('onClose', async () => {
    await platform.close();
    db.close();
  });
  return app;
}
