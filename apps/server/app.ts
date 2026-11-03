import { portableResourceLimits } from '../../shared/portable-resource-limits.js';
import { mediaMime } from '../../shared/media.js';
import type { AssetDescriptor } from '../../packages/core/assets.js';
import { registerDiagramDocumentRoutes } from './knowledge/diagram-routes.js';
import { registerDiagramHistoryRoutes } from './knowledge/diagram-history-routes.js';
import { registerPortableDeliveryRoutes } from './knowledge/portable-delivery-routes.js';
import { MAX_WHITEBOARD_BYTES } from '../../shared/whiteboard.js';
import Fastify from 'fastify';
import { statSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import csrf from '@fastify/csrf-protection';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import staticPlugin from '@fastify/static';
import { fromNodeHeaders } from 'better-auth/node';
import type { AppConfig } from '../../shared/contracts.js';
import type { HostConfig } from '../../shared/platform-contracts.js';
import { publicDiagramProjectionService } from '../../packages/core/public-diagram-projection.js';
import { resolveWhiteboardResource } from '../../packages/core/knowledge/diagram-resource-resolver.js';
import { releaseInfo } from './platform/release.js';
import { searchRuntimeManager } from './platform/search-runtime.js';
import { platformRuntime, lazyService } from './platform/runtime.js';
import { pluginHost } from './plugins/host.js';
import { mcpTransports } from './plugins/mcp-transport.js';
import { oauthGrantStore } from './platform/oauth-grants.js';
import { invalidateRemoteAuth } from '../../packages/core/auth/remote-auth.js';
import { pluginServices } from './plugins/services.js';
import { registerPluginRoutes } from './plugins/routes.js';
import { registerMcpTransferRoutes } from './plugins/mcp-transfer-routes.js';
import { registerMcpManagementRoutes, revokeMcpClient } from './platform/mcp-management.js';
import { registerMcpPermissionRoutes } from './platform/mcp-permissions.js';
import { registerMcpClientPermissionRoutes } from './platform/mcp-client-permissions.js';
import { registerMcpApiKeyRoutes, listMcpApiClients } from './platform/mcp-api-keys.js';
import { registerKnowledgeReadBarrier } from './knowledge/read-barrier.js';
import { registerOAuthRoutes, forwardAuthResponse } from './platform/oauth-routes.js';
import { serializeOAuth, revokeOAuthClient } from './platform/oauth.js';
import { openDatabase } from '../../packages/core/db.js';
import { createAuth } from './auth.js';
import { saveInput } from '../../packages/core/notes.js';
import { HttpError, text } from '../../packages/core/errors.js';

import { renderMarkdown, localReference } from '../../packages/core/render.js';


import { diagramArtifactService, DIAGRAM_SOURCE_MIMES } from '../../packages/core/knowledge/diagram-artifacts.js';
import { backlinkService } from '../../packages/core/knowledge/backlinks.js';
import { registerGraphRoutes } from './graph/routes.js';
import { registerSemanticGraphRoutes } from './graph/semantic-routes.js';
import { registerAgentRoutes } from './agent/routes.js';
import { registerWebKnowledgeRoutes } from './knowledge/web-routes.js';
import { webPrincipal } from '../../packages/core/knowledge/core.js';
import { KnowledgeError } from '../../packages/core/knowledge/errors.js';
import { registerStorageRoutes } from './platform/storage.js';
import { registerManagementRoutes } from './platform/management.js';
import { archiveFolder, recoverFolders } from '../../packages/core/folders.js';
import { workspaceExclusive } from '../../packages/core/workspace/gate.js';
import { registerTransferRoutes } from './platform/transfers.js';
import { gitRemoteService } from './git/service.js';
import { registerGitRemoteRoutes } from './git/routes.js';
import type { GitExec } from './git/transport.js';
import { pluginInstallJobs, registerPluginInstallRoutes } from './plugins/install-jobs.js';
import { registerBlogRoutes } from './blog/routes.js';
import { registerToDooRoutes } from './to-doo/routes.js';
import { registerToDooInteropRoutes } from './to-doo/interop-routes.js';
import { registerToDooPushRoutes } from './to-doo/push-routes.js';
import { ZodError } from 'zod';
import { createOutcomeNoteService } from './to-doo/outcome-note.js';
import { createToDooAssets } from '../../packages/core/to-doo/assets.js';
import { registerToDooAssetRoutes } from './to-doo/asset-routes.js';
export async function createApp(config: HostConfig, dependencies: { gitExec?: (db: ReturnType<typeof openDatabase>) => GitExec } = {}) {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  const db = openDatabase(config.dataRoot, 'server');
  const auth = await createAuth(config, db);
  const platform = platformRuntime(config, db);
  const searchRuntime = searchRuntimeManager(config, db, platform);
  app.addHook('onReady', async () => {
    void searchRuntime.start();
  });
  const plugins = pluginHost(config, db, (id, capabilities, context) =>
    pluginServices(platform, db, id, capabilities, context, undefined, {
      list: async () => {
        const ids = new Set(listMcpApiClients(db, context.ownerId).map(client => client.clientId));
        return oauthGrantStore(db).list(context.ownerId).filter(grant => !ids.has(grant.clientId));
      },
      revoke: (clientId) => Promise.resolve(revokeMcpClient(auth, db, context.ownerId, clientId)),
      connection: () => transports.connection(),
    }),
    () => platform.settings.configured()?.knowledgeRoot,
  );
  const transports = mcpTransports(app, plugins, auth, config, db, platform);
  await plugins.start();
  await platform.activate();
  await transports.start();
  const gitRemote = gitRemoteService(config, db, platform, plugins, { exec: dependencies.gitExec?.(db) });
  const pluginInstallations = pluginInstallJobs(db, plugins, gitRemote.assertPluginIdle);
  const businessConfig = new Proxy(config as AppConfig, {
    get: (target, key) =>
      key === 'knowledgeRoot'
        ? platform.settings.configured()?.knowledgeRoot
        : (target as any)[key],
  });
  app.setErrorHandler((err, req, reply) => {
    // Direct file-stream errors can retain the file's entity headers.
    reply.removeHeader('Content-Type').removeHeader('Content-Length');
    reply.header('Cache-Control', 'no-store');
    if (req.url.startsWith('/api/public/') && !platform.status().components.knowledge)
      return reply.code(404).send({ error: '分享不存在或已不可用' });
    const error = err as Error & { statusCode?: number };
    const status = error instanceof ZodError ? 400 :
      error.statusCode &&
      error.statusCode >= 400 &&
      (error.statusCode < 500 || error instanceof KnowledgeError)
        ? error.statusCode
        : 500;
    reply.code(status).send({
      error: error instanceof ZodError ? '请求内容不符合要求，请核对字段与范围' : status === 500 ? '操作失败，内容未标记为保存' : error.message,
      ...(error instanceof HttpError ? error.details : {}),
      ...(error instanceof KnowledgeError ? { code: error.code, retryable: error.retryable } : {}),
    });
  });
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
  await app.register(rateLimit, { global: false });
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => done(null, body),
  );
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
    (req as any).ownerSessionToken = session.session.token;
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
    if (
      !req.url.startsWith('/api/platform/') &&
      !req.url.startsWith('/api/security/') &&
      !req.url.startsWith('/api/maintenance/') &&
      !req.url.startsWith('/api/manage/')
    )
      platform.get();
  });
  const authPaths = new Set([
    '/api/auth/sign-in/username',
    '/api/auth/sign-out',
    '/api/auth/get-session',
    '/api/auth/change-password',
    '/api/auth/oauth2/authorize',
    '/api/auth/oauth2/register',
    '/api/auth/oauth2/token',
    '/api/auth/oauth2/revoke',
    '/api/auth/oauth2/introspect',
    '/api/auth/jwks',
    '/api/auth/.well-known/oauth-authorization-server',
  ]);
  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    handler: async (req, reply) => {
      const path = req.url.split('?')[0];
      if ((db.prepare('SELECT active FROM maintenance WHERE id=1').get() as any).active)
        return reply.code(503).send({ error: '维护中，请稍后重试', code: 'MAINTENANCE_ACTIVE' });
      if (!authPaths.has(path)) return reply.code(404).send({ error: '接口不存在' });
      if (
        req.method === 'POST' &&
        !path.startsWith('/api/auth/oauth2/') &&
        req.headers.origin !== config.origin
      )
        return reply.code(403).send({ error: '请求来源不被允许' });
      if (path.endsWith('change-password') && req.body && typeof req.body === 'object')
        Object.assign(req.body, { revokeOtherSessions: true });
      const changingOwner = path.endsWith('change-password')
        ? await auth.api.getSession({ headers: fromNodeHeaders(req.headers) })
        : undefined;
      const handle = () =>
        auth.handler(
          new Request(new URL(req.url, config.origin), {
            method: req.method,
            headers: fromNodeHeaders(req.headers),
            ...(req.body
              ? { body: typeof req.body === 'string' ? req.body : JSON.stringify(req.body) }
              : {}),
          }),
        );
      const response =
        path === '/api/auth/oauth2/token' ? await serializeOAuth(db, handle) : await handle();
      if (response.ok && changingOwner?.user) {
        db.transaction(() => invalidateRemoteAuth(db)).immediate();
        await revokeOAuthClient(auth, db, changingOwner.user.id);
      }
      return forwardAuthResponse(response, reply);
    },
  });
  registerKnowledgeReadBarrier(app, db, async () => {
    await workspaceExclusive(db, { kind: 'folder.recover', recovery: true }, async () =>
      recoverFolders(platform.get().config, db),
    );
  });
  app.get('/api/security/csrf', async (_req, reply) => ({ token: reply.generateCsrf() }));
  app.get('/api/collections/status', async (req) =>
    platform.get().collections.status((req as any).ownerId, (req.query as any).kind));
  app.get('/api/collections', async (req) =>
    platform.get().collections.page((req as any).ownerId, req.query as any));
  registerGraphRoutes(app, () => platform.get().graph);
  registerSemanticGraphRoutes(app, () => platform.get().knowledgeGraph, () => platform.get().graphModel);
  registerBlogRoutes(app, businessConfig, () => platform.get().blog);
  registerToDooRoutes(app, () => platform.get().toDoo, () => {
    const runtime = platform.get();
    return createOutcomeNoteService(runtime.config, db, runtime.notes, runtime.toDoo);
  });
  registerToDooInteropRoutes(app, () => platform.get().toDooInterop);
  registerToDooPushRoutes(app, () => platform.get().toDooNotifications, () => platform.get().toDoo, { db });
  registerToDooAssetRoutes(app, () => {
    const runtime = platform.get();
    return createToDooAssets(runtime.toDoo, { knowledgeRoot: runtime.config.knowledgeRoot, db });
  });
  registerOAuthRoutes(app, auth, config, db);
  app.get('/healthz', async () => ({
    status: 'alive',
    version: releaseInfo(config.applicationRoot).version,
    phase: platform.status().phase,
    maintenance: !!(db.prepare('SELECT active FROM maintenance WHERE id=1').get() as any).active,
  }));
  app.get('/readyz', async (_req, reply) => {
    const ready = platform.status().components.knowledge;
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready' });
  });
  app.get('/api/platform/status', async () => platform.status());
  registerManagementRoutes(app, config, db, auth, platform);
  registerTransferRoutes(app, config, db, platform);
  registerStorageRoutes(app, config, () => platform.settings.configured()?.knowledgeRoot);
  app.get('/api/platform/search-runtime', async () => searchRuntime.status());
  app.post('/api/platform/search-runtime/prepare', async (req) =>
    searchRuntime.prepare((req as any).ownerId, (req.body as any)?.requestId),
  );
  app.post<{ Params: { id: string } }>(
    '/api/platform/search-runtime/tasks/:id/cancel',
    async (req) => searchRuntime.cancel((req as any).ownerId, req.params.id),
  );
  registerPluginRoutes(app, plugins, gitRemote.assertPluginIdle);
  registerMcpTransferRoutes(app, config, db);
  registerGitRemoteRoutes(app, gitRemote);
  registerPluginInstallRoutes(app, pluginInstallations);
  registerMcpManagementRoutes(app, config, db, plugins, transports, auth);
  registerMcpPermissionRoutes(app, db, platform);
  registerMcpClientPermissionRoutes(app, auth, config, db);
  registerMcpApiKeyRoutes(app, db);
  app.post('/api/platform/setup/directories', async (req) =>
    platform.settings.directories(req.body),
  );
  app.post('/api/platform/setup/create', async (req) =>
    platform.settings.createDirectory((req as any).ownerId, req.body),
  );
  app.post('/api/platform/setup/validate', async (req) =>
    platform.settings.validate((req as any).ownerId, (req.body as any)?.knowledgeRoot),
  );
  app.post('/api/platform/setup/complete', async (req) => {
    const receipt = platform.settings.complete((req as any).ownerId, req.body);
    void platform.activate();
    return receipt;
  });
  app.post('/api/platform/setup/finish', async () => platform.settings.finish());
  const notes = lazyService(() => platform.get().notes);
  const knowledge = await registerAgentRoutes(
    app,
    businessConfig,
    db,
    notes,
    () => platform.get().knowledge,
  );
  app.get('/api/tree', async (req) => notes.tree((req as any).ownerId));
  app.put<{ Params: { id: string } }>('/api/notes/:id/favorite', async (req) =>
    notes.setFavorite(
      (req as any).ownerId,
      req.params.id,
      (req.body as { favorite?: unknown })?.favorite,
    ),
  );
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
  const backlinks = backlinkService(businessConfig, db, notes, webPrincipal);
  app.get<{ Params: { id: string }; Querystring: { cursor?: string } }>('/api/notes/:id/backlinks', async (req) =>
    backlinks.page(req.params.id, req.query.cursor),
  );
  app.post('/api/notes', {bodyLimit: 10 * 1024 * 1024}, async (req, reply) => {
    const b = req.body as Record<string, unknown>;
    return reply
      .code(201)
      .send(
        notes.createNote(
          text(b?.folderPath, '目录', 1000),
          text(b?.fileName, '文件名', 180),
          text(b?.content, '正文', MAX_WHITEBOARD_BYTES),
          typeof b?.requestId === 'string' ? b.requestId : undefined,
        ),
      );
  });
  app.put<{ Params: { id: string } }>('/api/notes/:id', {bodyLimit: 10 * 1024 * 1024}, async (req) => {
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
  app.delete('/api/folders', async (req) => {
    const b = req.body as Record<string, unknown>;
    return workspaceExclusive(db, { kind: 'folder.archive' }, async () =>
      archiveFolder(platform.get().config, db, text(b?.path, '目录', 1000), text(b?.requestId, '请求标识', 128), () => notes.scan()),
    );
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
  const checkOwnerSession=(req:import('fastify').FastifyRequest)=>{
    const row=db.prepare('SELECT userId,expiresAt FROM session WHERE token=?').get((req as any).ownerSessionToken) as {userId:string;expiresAt:number|string}|undefined;
    const expiry=row&&(Number.isFinite(Number(row.expiresAt))?Number(row.expiresAt):Date.parse(String(row.expiresAt)));
    if(!row||row.userId!==(req as any).ownerId||!expiry||expiry<=Date.now())throw new HttpError(401,'登录已失效');
    if((db.prepare('SELECT active FROM maintenance WHERE id=1').get() as {active:number}).active)throw new HttpError(503,'维护中，请稍后重试');
  };
  app.post<{Params:{id:string}}>('/api/notes/:id/assets',{bodyLimit:portableResourceLimits.mediaBytes+16384},async(req,reply)=>{
    notes.exists(req.params.id);
    const part=await req.file({limits:{fileSize:portableResourceLimits.mediaBytes+1,files:1,fields:0}});
    if(!part)throw new HttpError(400,'请选择附件');
    async function* source(){for await(const chunk of part!.file)yield chunk;if(part!.file.truncated)throw new HttpError(413,'附件超过配置配额');}
    const result=await assets.uploadStream(req.params.id,part.filename,part.mimetype,source(),req.headers['x-dooknow-upload-id'],{check:()=>checkOwnerSession(req)});
    return reply.code(201).send(result);
  });
  await registerDiagramDocumentRoutes(app,db,()=>platform.get());
  await registerDiagramHistoryRoutes(app,db,()=>platform.get());
  registerPortableDeliveryRoutes(app,db,()=>platform.get(),checkOwnerSession);
  const diagramArtifacts = diagramArtifactService(db, notes, assets, webPrincipal);
  app.post<{ Params: { id: string } }>('/api/notes/:id/diagram-artifacts', { bodyLimit: 32 * 1024 * 1024 }, async (req, reply) =>
    reply.code(201).send(diagramArtifacts.prepare(req.params.id, req.body)),
  );
  const sendAsset = (
    reply: import('fastify').FastifyReply,
    a: { bytes: Buffer; sourceBytes?: Buffer; mime: string; path: string } | (AssetDescriptor & {check?:()=>void}),
    download?: string,
    range?:string,
    check?:()=>void,
  ) => {
    if('absolutePath' in a) {
      let start=0,end=a.sizeBytes-1;
      reply.header('Accept-Ranges','bytes');
      if(range) {
        const m=/^bytes=(\d*)-(\d*)$/.exec(range);
        if(!m||(!m[1]&&!m[2])) {reply.header('Content-Range',`bytes */${a.sizeBytes}`);throw new HttpError(416,'附件范围无效');}
        if(!m[1]){const n=Number(m[2]);if(!Number.isSafeInteger(n)){reply.header('Content-Range',`bytes */${a.sizeBytes}`);throw new HttpError(416,'附件范围无效');}start=Math.max(0,a.sizeBytes-n);if(!n)start=a.sizeBytes;}else{start=Number(m[1]);if(m[2])end=Math.min(end,Number(m[2]));}
        if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||start>=a.sizeBytes){reply.header('Content-Range',`bytes */${a.sizeBytes}`);throw new HttpError(416,'附件范围无效');}
        reply.code(206).header('Content-Range',`bytes ${start}-${end}/${a.sizeBytes}`);
      }
      const stream=assets.open(a,{start,end,check:()=>{check?.();a.check?.();}});reply.raw.once('close',()=>stream.destroy());
      return reply.header('Content-Length',end-start+1).header('Content-Security-Policy',"default-src 'none'; sandbox").header('Content-Disposition',download==='1'?`attachment; filename="${basename(a.path).replace(/[^A-Za-z0-9._-]/g,'_')}"`:'inline').type(a.mime).send(stream);
    }
    const attachment = download === '1' || Object.values(DIAGRAM_SOURCE_MIMES).some(mime => mime === a.mime);
    return reply
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header(
        'Content-Disposition',
        attachment
          ? `attachment; filename="${basename(a.path).replace(/[^A-Za-z0-9._-]/g, '_')}"`
          : 'inline',
      )
      .type(attachment ? 'application/octet-stream' : a.mime)
      .send(download === '1' ? a.sourceBytes ?? a.bytes : a.bytes);
  };
  app.get<{ Params: { id: string }; Querystring: { download?: string } }>(
    '/api/assets/:id',
    async (req,reply)=>{const descriptor=assets.inspectById(req.params.id);return sendAsset(reply,mediaMime(descriptor.path)?descriptor:assets.byId(req.params.id),req.query.download,req.headers.range,()=>checkOwnerSession(req));},
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
  const publicProjection = publicDiagramProjectionService(
    businessConfig,
    db,
    notes,
    assets,
    shares,
  );
  function resolveBoard(parentPath: string, reference: string) {
    const resource = resolveWhiteboardResource(
      businessConfig,
      db,
      notes,
      webPrincipal,
      parentPath,
      reference,
    );
    // Retain owner-route identity/path metadata while the payload is a semantic resource.
    return { ...resource, id: resource.noteId, relativePath: notes.row(resource.noteId).path };
  }
  app.get<{ Params: { id: string }; Querystring: { source: string } }>(
    '/api/notes/:id/whiteboards/resolve',
    async (req) => resolveBoard(notes.row(req.params.id).path, req.query.source),
  );
  app.get<{ Params: { token: string; id: string } }>(
    '/api/public/shares/:token/whiteboards/:id',
    async (req) => {
      return publicProjection.resource(req.params.token, req.params.id);
    },
  );
  app.get<{ Params: { token: string } }>('/api/public/shares/:token/diagram', async (req) =>
    publicProjection.resource(req.params.token),
  );
  await registerWebKnowledgeRoutes(
    app,
    businessConfig,
    db,
    knowledge,
    shares,
    async (req) => !!(await auth.api.getSession({ headers: fromNodeHeaders(req.headers) })),
    publicProjection,
  );
  app.get<{ Params: { id: string } }>('/api/notes/:id/share', async (req) =>
    shares.status(req.params.id),
  );
  app.post<{ Params: { id: string } }>('/api/notes/:id/share', async (req) =>
    shares.create(req.params.id, false, req.body),
  );
  app.post<{ Params: { id: string } }>('/api/notes/:id/share/reset', async (req) =>
    shares.create(req.params.id, true, req.body),
  );
  app.delete<{ Params: { id: string } }>('/api/notes/:id/share', async (req) =>
    shares.revoke(req.params.id),
  );
  app.get<{ Params: { token: string } }>('/api/public/shares/:token', async (req, reply) => {
    const projected = publicProjection.project(req.params.token),
      n = projected.note;
    reply.header('X-Robots-Tag', 'noindex, nofollow');
    return {
      title: n.title,
      updatedAt: n.updatedAt,
      ...shares.access(req.params.token),
      ...(projected.resource ? { documentType: projected.resource.documentType } : {}),
      ...renderMarkdown(projected.content, (url) =>
        projected.assets.has(localReference(n.relativePath, url) ?? '')
          ? assets.mapUrl(
              { ...n, content: projected.content },
              url,
              `/api/public/shares/${req.params.token}/assets/`,
            )
          : undefined,
      ),
    };
  });
  app.get<{ Params: { token: string; assetId: string }; Querystring: { download?: string } }>(
    '/api/public/shares/:token/assets/:assetId',
    async (req, reply) => {
      const note = shares.lookup(req.params.token);
      const asset = await publicProjection.asset(req.params.token, { id: req.params.assetId });
      if (shares.lookup(req.params.token).id !== note.id)
        throw new HttpError(404, '分享不存在或已取消');
      return sendAsset(reply,asset,req.query.download,req.headers.range);
    },
  );
  app.get<{ Params: { token: string }; Querystring: { source?: string; download?: string } }>(
    '/api/public/shares/:token/asset',
    async (req, reply) => {
      const note = shares.lookup(req.params.token);
      const asset = await publicProjection.asset(req.params.token, {
        source: text(req.query.source, '附件引用', 8192),
      });
      if (shares.lookup(req.params.token).id !== note.id)
        throw new HttpError(404, '分享不存在或已取消');
      return sendAsset(reply,asset,req.query.download,req.headers.range);
    },
  );
  if (config.staticRoot) {
    app.get('/', async (_req, reply) => reply.sendFile('index.html'));
    for (const path of ['/login', '/oauth/consent'])
      app.get(path, async (_req, reply) => reply.sendFile('index.html'));
    app.get('/s/:token', async (_req, reply) =>
      reply.header('X-Robots-Tag', 'noindex, nofollow').sendFile('index.html'),
    );
    const staticRoot = config.staticRoot;
    await app.register(staticPlugin, {
      root: staticRoot,
      index: false,
      setHeaders(reply, filePath) {
        // Bundle fingerprints change with their content. Unversioned entries
        // keep revalidating so upgrades remain visible.
        const file = relative(staticRoot, filePath).split(sep).join('/');
        if (/^assets\/[^/]+-[A-Za-z0-9_-]{8}\.(?:js|css)$/.test(file))
          reply.header('Cache-Control', 'public, max-age=31536000, immutable');
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || (!req.url.startsWith('/s/') && req.url !== '/'))
        return reply.code(404).send({ error: '页面不存在' });
      reply.header('X-Robots-Tag', 'noindex, nofollow');
      return reply.sendFile('index.html');
    });
  }
  app.addHook('onClose', async () => {
    await gitRemote.close();
    await pluginInstallations.close();
    await searchRuntime.close();
    await transports.close();
    await platform.close();
    await plugins.close();
    db.close();
  });
  return app;
}
