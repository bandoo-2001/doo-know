import { it, expect } from 'vitest';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture } from '../support/fixture.js';
import { startVectorRuntime } from '../support/vector-runtime.js';
import { agentConfig, agentHeaders } from '../support/agent.js';
it('serves text, real semantic and hybrid search with ACL filtering and explicit degradation', async () => {
  const seed = await createFixture(),
    runtime = await startVectorRuntime(seed.dataRoot);
  const config = {
    ...agentConfig,
    policies: [{ ...agentConfig.policies[0], allowedPrefixes: ['00-Inbox/allowed'] }],
  };
  const f = await createFixture({
    dataRoot: seed.dataRoot,
    agent: config,
    indexing: { enabled: true, watch: false },
    embeddingSpaceId: runtime.spaceId,
    vectorServiceUrl: runtime.url,
    vectorServiceToken: runtime.token,
  });
  try {
    for (const name of ['allowed', 'allowed-other'])
      await mkdir(join(f.knowledgeRoot, '00-Inbox', name));
    await writeFile(
      join(f.knowledgeRoot, '00-Inbox/allowed/knowledge.md'),
      '# 知识管理\n\n用 Markdown 整理长期知识与经验，笔记之间建立链接。',
    );
    await writeFile(
      join(f.knowledgeRoot, '00-Inbox/allowed-other/private.md'),
      '# 私人知识\n\n越权哨兵知识整理。',
    );
    await f.app.inject({
      method: 'POST',
      url: '/api/agent/v1/index/refresh',
      headers: agentHeaders(),
      payload: { scope: '00-Inbox/allowed', requestId: 'search-index' },
    });
    for (const mode of ['text', 'semantic', 'hybrid']) {
      const r = await f.app.inject({
        method: 'POST',
        url: '/api/agent/v1/search',
        headers: agentHeaders(),
        payload: {
          query: mode === 'text' ? '知识' : '如何把经验组织成笔记',
          mode,
          freshness: 'strict',
          limit: 10,
        },
      });
      expect(r.statusCode).toBe(200);
      expect(r.json().data.results.length).toBeGreaterThan(0);
      expect(
        r.json().data.results.every((x: any) => x.relativePath.startsWith('00-Inbox/allowed/')),
      ).toBe(true);
      expect(r.body).not.toContain('越权哨兵');
    }
    await runtime.close();
    const fallback = await f.app.inject({
      method: 'POST',
      url: '/api/agent/v1/search',
      headers: agentHeaders(),
      payload: { query: '知识', mode: 'hybrid' },
    });
    expect(fallback.statusCode).toBe(200);
    expect(fallback.json().data.degraded).toBe(true);
    expect(fallback.json().data.results.length).toBeGreaterThan(0);
    const strictOffline = await f.app.inject({
      method: 'POST',
      url: '/api/agent/v1/search',
      headers: agentHeaders(),
      payload: { query: '知识', mode: 'hybrid', freshness: 'strict' },
    });
    expect(strictOffline.statusCode).toBe(503);
    const textOffline = await f.app.inject({
      method: 'POST',
      url: '/api/agent/v1/search',
      headers: agentHeaders(),
      payload: { query: '知识', mode: 'text', freshness: 'strict' },
    });
    expect(textOffline.statusCode).toBe(200);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/agent/v1/search',
          headers: agentHeaders(),
          payload: { query: '知识', mode: 'semantic' },
        })
      ).statusCode,
    ).toBe(503);
  } finally {
    await f.close();
    await runtime.close();
    await seed.close();
  }
});
