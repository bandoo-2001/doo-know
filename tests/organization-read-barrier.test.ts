import Fastify from 'fastify';
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
