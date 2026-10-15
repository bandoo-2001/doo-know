import type { FastifyInstance } from 'fastify';
import type { pluginHost } from './host.js';
import { fail } from '../../../packages/core/knowledge/errors.js';
export function registerPluginRoutes(app: FastifyInstance, host: ReturnType<typeof pluginHost>) {
  app.get('/api/platform/plugins', async () => ({ catalog: host.catalog(), installed: host.list(), contributions: host.contributions() }));
  for (const action of ['install', 'enable', 'disable', 'uninstall', 'upgrade'] as const)
    app.post<{ Params: { id: string } }>(`/api/platform/plugins/:id/${action}`, async req => {
      const id = req.params.id;
      return action === 'upgrade' ? host.install(id) : action === 'uninstall' ? (await host.uninstall(id), { uninstalled: true, dataRetained: true }) : host[action](id);
    });
  app.put<{ Params: { id: string } }>('/api/platform/plugins/:id/config', async req => {
    const b = req.body as any;
    if (!Number.isInteger(b?.configVersion)) fail(400, 'INVALID_PLUGIN_CONFIG');
    return host.configure(req.params.id, b.values, b.configVersion);
  });
  app.post<{ Params: { id: string } }>('/api/plugins/:id/call', async req =>
    host.call(req.params.id, req.body as any, { ownerId: (req as any).ownerId, channel: 'web', requestId: (req.body as any)?.requestId }));
  app.get<{ Params: { id: string; version: string; hash: string; '*': string } }>('/plugins/:id/:version/:hash/*', async (req, reply) => {
    const path = req.params['*'], asset = host.asset(req.params.id, req.params.version, path);
    if (asset.bundleHash !== req.params.hash) fail(404, 'PLUGIN_ASSET_NOT_FOUND');
    return reply.header('Cache-Control', 'public,max-age=31536000,immutable')
      .type(path.endsWith('.css') ? 'text/css' : path.endsWith('.js') || path.endsWith('.mjs') ? 'text/javascript' : 'application/octet-stream').send(asset.bytes);
  });
}
