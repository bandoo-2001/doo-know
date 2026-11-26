import type { FastifyInstance } from 'fastify';
import { featureIds } from '../../../shared/feature-config.js';
import { fail } from '../../../packages/core/knowledge/errors.js';
import type { featureRuntime } from './runtime.js';

export function registerFeatureRoutes(
  app: FastifyInstance,
  features: ReturnType<typeof featureRuntime>,
  assertGitIdle: () => void,
) {
  app.get('/api/platform/features', async () => ({
    git: features.settings('git'),
    mcp: features.settings('mcp'),
  }));
  for (const id of featureIds) {
    app.put(`/api/platform/${id}/enabled`, async (request) => {
      const enabled = (request.body as { enabled?: unknown } | undefined)?.enabled;
      if (typeof enabled !== 'boolean') fail(400, 'INVALID_FEATURE_SWITCH');
      return features.setEnabled(id, enabled, id === 'git' ? assertGitIdle : undefined);
    });
    app.put(`/api/platform/${id}/config`, async (request) => {
      const body = request.body as { configVersion?: number; values?: unknown } | undefined;
      if (!body || !Number.isInteger(body.configVersion)) fail(400, 'INVALID_FEATURE_CONFIG');
      return features.configure(id, body.values, body.configVersion!);
    });
    app.post(`/api/platform/${id}/actions`, async (request) =>
      features.call(id, request.body as any, {
        ownerId: (request as any).ownerId,
        requestId: (request.body as any)?.requestId,
        channel: 'web',
      }),
    );
  }
}
