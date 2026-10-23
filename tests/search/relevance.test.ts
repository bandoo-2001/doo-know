import { beforeAll, afterAll, it, expect } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture } from '../support/fixture.js';
import { startVectorRuntime } from '../support/vector-runtime.js';
import { agentConfig, agentHeaders } from '../support/agent.js';

let seed: Awaited<ReturnType<typeof createFixture>>;
let f: Awaited<ReturnType<typeof createFixture>>;
let runtime: Awaited<ReturnType<typeof startVectorRuntime>>;
beforeAll(async () => {
  seed = await createFixture();
  runtime = await startVectorRuntime(seed.dataRoot);
  f = await createFixture({
    knowledgeRoot: seed.knowledgeRoot,
    dataRoot: seed.dataRoot,
    agent: agentConfig,
    indexing: { enabled: true, watch: false },
    embeddingSpaceId: runtime.spaceId,
    vectorServiceUrl: runtime.url,
    vectorServiceToken: runtime.token,
  });
  await writeFile(
    join(f.knowledgeRoot, '00-Inbox/development.md'),
    '# DooKnow MCP 与知识库检索设计\n\n文本检索与混合检索采用 RRF 融合。Web 启动、本地混合搜索、Git 写入受控。',
  );
  await writeFile(
    join(f.knowledgeRoot, '00-Inbox/observations.md'),
    '# 维护记录\r\n\r\n' +
      'background\r\n'.repeat(65) +
      '水文观测记录：通过水位、流速与降雨量观测，分析河流径流变化。\r\n',
  );
  await writeFile(
    join(f.knowledgeRoot, '00-Inbox/photos.md'),
    '# 家庭相册维护记录\n\n每次更新相册服务之前，先导出数据库，并保留当前使用的程序版本。如果新版本启动失败，应停止服务，切回先前保留的程序版本。',
  );
});
afterAll(async () => {
  await f?.close();
  await runtime?.close();
  await seed?.close();
});
async function search(query: string, mode: 'text' | 'semantic' | 'hybrid') {
  const reply = await f.app.inject({
    method: 'POST',
    url: '/api/agent/v1/search',
    headers: agentHeaders(),
    payload: { query, mode, freshness: 'strict', limit: 10 },
  });
  expect(reply.statusCode, reply.body).toBe(200);
  return reply.json().data.results as any[];
}

it('does not fill a short keyword search with unrelated development notes', async () => {
  const results = await search('水文', 'hybrid');
  expect(results.some((r) => r.relativePath === '00-Inbox/observations.md')).toBe(true);
  expect(results.some((r) => r.relativePath === '00-Inbox/development.md')).toBe(false);
});
it('rejects unrelated semantic neighbors while keeping a relevant paraphrase', async () => {
  expect(await search('怎样养兰花', 'semantic')).toEqual([]);
  const results = await search('升级以后打不开了，怎样回到之前能用的状态？', 'semantic');
  expect(results.map((r) => r.relativePath)).toContain('00-Inbox/photos.md');
  expect(results.map((r) => r.relativePath)).not.toContain('00-Inbox/development.md');
});
it('returns the literal match line and nearby text without changing the chunk range', async () => {
  const results = await search('水文', 'text');
  const hit = results.find((r) => r.relativePath === '00-Inbox/observations.md').matches[0];
  expect(hit.matchLine).toBe(68);
  expect(hit.url).toMatch(/#L68$/);
  expect(hit.snippet).toContain('水文观测记录');
  expect(hit.startLine).toBeLessThan(hit.matchLine);
});
