import { beforeAll, afterAll, it, expect } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture } from '../support/fixture.js';
import { agentConfig, agentHeaders } from '../support/agent.js';

let f: Awaited<ReturnType<typeof createFixture>>;
const directory = '00-Inbox/allowed';
beforeAll(async () => {
  f = await createFixture({
    indexing: { enabled: true, watch: false },
    agent: {
      ...agentConfig,
      policies: [{ ...agentConfig.policies[0], allowedPrefixes: [directory] }],
    },
  });
  await mkdir(join(f.knowledgeRoot, directory));
  await mkdir(join(f.knowledgeRoot, '00-Inbox/allowed-other'));
  for (const [path, content] of [
    [`${directory}/水文观测记录.md`, '# 设备维护台账\n\n今天检查传感器。'],
    [`${directory}/DEPLOY.md`, '# 服务运行记录\n\n今天检查进程状态。'],
    [`${directory}/早餐食谱.md`, '# 做饭\n\n早餐是煎蛋和牛奶。'],
    [`${directory}/data[1]+.md`, '# 数值记录\n\n检查仪表。'],
    [`${directory}/ÉTUDE.md`, '# 外文资料\n\n仪表读数。'],
    [`${directory}/backup.md`, '# 数据库备份\n\n每天导出数据库，并核对备份。'],
    [`${directory}/database-only.md`, '# 数据库调优\n\n只记录索引配置。'],
    ['00-Inbox/allowed-other/DEPLOY.md', '# PRIVATE_SENTINEL\n不得返回。'],
  ])
    await writeFile(join(f.knowledgeRoot, path), content);
});
afterAll(async () => {
  await f?.close();
});
async function search(query: string, limit = 10) {
  const reply = await f.app.inject({
    method: 'POST',
    url: '/api/agent/v1/search',
    headers: agentHeaders({ allowedPrefixes: [directory] }),
    payload: { query, mode: 'text', freshness: 'strict', limit },
  });
  expect(reply.statusCode, reply.body).toBe(200);
  expect(reply.body).not.toContain('PRIVATE_SENTINEL');
  return reply.json().data.results as { relativePath: string }[];
}
it.each([
  ['水文', '水文观测记录.md'],
  ['水文观测记录', '水文观测记录.md'],
  ['水文观测记录.md', '水文观测记录.md'],
  ['测记录', '水文观测记录.md'],
  ['测记录.md', '水文观测记录.md'],
  ['DEPLOY.md', 'DEPLOY.md'],
  ['deploy', 'DEPLOY.md'],
  ['EPLOY', 'DEPLOY.md'],
  [`${directory}/水文观测记录.md`, '水文观测记录.md'],
  ['"水文观测记录.md"', '水文观测记录.md'],
  ['data[1]+.md', 'data[1]+.md'],
  ['étude.md', 'ÉTUDE.md'],
])('finds %s without unrelated extension or partial-word matches', async (query, name) => {
  expect((await search(query)).map((r) => r.relativePath)).toEqual([`${directory}/${name}`]);
});
it('requires the meaningful terms of a multi-keyword text query together', async () => {
  expect((await search('数据库 备份')).map((r) => r.relativePath)).toEqual([
    `${directory}/backup.md`,
  ]);
});
it('ranks the named file ahead of a document that merely references its name', async () => {
  await writeFile(
    join(f.knowledgeRoot, `${directory}/references.md`),
    '# 资料入口\n\nDEPLOY.md 中保存了部署步骤。',
  );
  expect((await search('DEPLOY.md')).map((r) => r.relativePath)).toEqual([
    `${directory}/DEPLOY.md`,
    `${directory}/references.md`,
  ]);
});
it('applies literal matching before the recall limit, not after irrelevant candidates consume it', async () => {
  expect((await search('"水文观测记录.md"', 1)).map((r) => r.relativePath)).toEqual([
    `${directory}/水文观测记录.md`,
  ]);
});
it('keeps an exact named file ahead of directory matches even when it was indexed later', async () => {
  await mkdir(join(f.knowledgeRoot, `${directory}/潮汐`));
  for (let i = 0; i < 60; i++)
    await writeFile(
      join(f.knowledgeRoot, `${directory}/潮汐/记录-${i}.md`),
      '# 其他记录\n仅目录包含查询词。',
    );
  await search('潮汐', 1);
  await writeFile(join(f.knowledgeRoot, `${directory}/潮汐.md`), '# 现场资料\n今天的读数。');
  expect((await search('潮汐', 1)).map((r) => r.relativePath)).toEqual([`${directory}/潮汐.md`]);
});
