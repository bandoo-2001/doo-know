import Fastify from 'fastify';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import { pluginRuntimeFixture } from './support/plugin-runtime.js';
import { registerKnowledgeReadBarrier } from '../apps/server/knowledge/read-barrier.js';
import { workspaceExclusive } from '../packages/core/workspace/gate.js';

it.each(['/api/notes/slow', '/api/agent/v1/notes/slow'])(
  'holds an HTTP knowledge read lease until %s finishes',
  async (path) => {
    const f = await pluginRuntimeFixture(),
      app = Fastify();
    let enter!: () => void, finish!: () => void;
    const entered = new Promise<void>((r) => {
        enter = r;
      }),
      finished = new Promise<void>((r) => {
        finish = r;
      });
    registerKnowledgeReadBarrier(app, f.db);
    app.get(path, async () => {
      enter();
      await finished;
      return { content: 'consistent' };
    });
    try {
      const response = app.inject(path);
      await entered;
      let committed = false;
      const commit = workspaceExclusive(
        f.db,
        { kind: 'organization.test', waitMs: 2000 },
        async () => {
          committed = true;
        },
      );
      await new Promise<void>((r) => setImmediate(r));
      expect(committed).toBe(false);
      finish();
      expect((await response).json()).toEqual({ content: 'consistent' });
      await commit;
      expect(committed).toBe(true);
      expect(f.db.prepare('SELECT COUNT(*) n FROM workspace_gate').get()).toEqual({ n: 0 });
    } finally {
      finish();
      await app.close();
      await f.close();
    }
  },
);

it('releases a read lease when the connection closed before the read barrier was installed', async () => {
  const f = await pluginRuntimeFixture(),
    app = Fastify();
  let enter!: () => void, resume!: () => void, closed!: () => void;
  let handlerCalled = false;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const resumed = new Promise<void>((resolve) => { resume = resolve; });
  const responseClosed = new Promise<void>((resolve) => { closed = resolve; });
  app.addHook('onRequest', async (_request, reply) => {
    reply.raw.once('close', closed);
    enter();
    // Authentication can finish after a client has already left the page.
    await resumed;
  });
  registerKnowledgeReadBarrier(app, f.db);
  app.get('/api/notes/aborted', async () => {
    handlerCalled = true;
    return { content: 'no longer requested' };
  });
  let request: ReturnType<typeof httpRequest> | undefined;
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as AddressInfo;
    request = httpRequest({ host: '127.0.0.1', port, path: '/api/notes/aborted' });
    request.on('error', () => {});
    request.end();
    await entered;
    request.destroy();
    await responseClosed;
    resume();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.db.prepare('SELECT COUNT(*) n FROM workspace_gate').get()).toEqual({ n: 0 });
    expect(handlerCalled).toBe(false);
    let committed = false;
    await workspaceExclusive(f.db, { kind: 'organization.after-aborted-read', waitMs: 100 }, async () => {
      committed = true;
    });
    expect(committed).toBe(true);
  } finally {
    request?.destroy();
    resume();
    await app.close();
    await f.close();
  }
});
