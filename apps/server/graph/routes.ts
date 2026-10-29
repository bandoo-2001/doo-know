import type { FastifyInstance } from 'fastify';
import type { GraphQuery } from '../../../shared/graph-contracts.js';
import type { createGraphService } from '../../../packages/core/graph/service.js';
import { webPrincipal } from '../../../packages/core/knowledge/core.js';
import { fail } from '../../../packages/core/knowledge/errors.js';

export function registerGraphRoutes(app: FastifyInstance, getGraph: () => ReturnType<typeof createGraphService>) {
  app.get('/api/graph', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request) => {
    const raw = request.query as Record<string, unknown>;
    const keys = ['folder', 'q', 'focus', 'mode', 'depth', 'limit'];
    if (Object.keys(raw).some((key) => !keys.includes(key)))
      fail(400, 'INVALID_INPUT', '包含不支持的图谱筛选参数');
    const input: Record<string, unknown> = {};
    for (const key of keys) {
      const value = raw[key];
      if (value === undefined) continue;
      if (typeof value !== 'string') fail(400, 'INVALID_INPUT', '图谱筛选参数格式不正确');
      if (key === 'depth' || key === 'limit') {
        if (!/^\d+$/.test(value)) fail(400, 'INVALID_INPUT', '图谱范围必须是有效整数');
        input[key] = Number(value);
      } else input[key] = value;
    }
    const ownerId = (request as unknown as { ownerId: string }).ownerId;
    return getGraph().query({ ...webPrincipal, id: ownerId, ownerId }, input as GraphQuery);
  });
}
