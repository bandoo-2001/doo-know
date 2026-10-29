import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createFixture, loginFixtureOwner, type Fixture } from './support/fixture';

describe('full content-aware graph API', () => {
  let f: Fixture;
  let headers: Awaited<ReturnType<typeof loginFixtureOwner>>;
  let source: { id: string; content: string; modifiedAt: string };
  const get = (url: string) => f.app.inject({ url, headers });
  const create = async (name: string, content: string) => {
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/notes',
      headers,
      payload: { folderPath: '00-Inbox', fileName: name, content },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json();
  };
  beforeAll(async () => {
    f = await createFixture();
    headers = await loginFixtureOwner(f);
    await create(
      'Linux.md',
      '# Linux 内核\n\nLinux 为 Docker 提供容器隔离。Docker 和 Linux 可以协作。',
    );
    source = await create(
      'Docker.md',
      '# Docker 容器\n\nDocker 依赖 Linux 内核。Docker 使用 Linux 运行容器。\n\n[[Linux]]',
    );
  });
  afterAll(async () => {
    await f?.close();
  });

  it('automatically analyzes ordinary note content without opening or refreshing the graph', async () => {
    await vi.waitFor(
      async () => {
        const status = await get('/api/graph/status');
        expect(status.statusCode, status.body).toBe(200);
        expect(status.json().completed).toBeGreaterThanOrEqual(2);
        expect(status.json().pending).toBe(0);
      },
      { timeout: 15000, interval: 50 },
    );
    const graph = await get('/api/graph/explore?view=knowledge');
    expect(graph.statusCode, graph.body).toBe(200);
    expect(graph.json().nodes.some((node: { kind: string }) => node.kind !== 'note')).toBe(true);
    expect(graph.json().edges.some((edge: { kind: string }) => edge.kind === 'mentions')).toBe(
      true,
    );
    const notes = await get('/api/graph/explore?view=notes');
    expect(notes.statusCode, notes.body).toBe(200);
    expect(notes.json().nodes.map((node: { id: string }) => node.id)).toContain(source.id);
  });

  it('requires authentication and validates semantic filters and job controls', async () => {
    for (const url of [
      '/api/graph/status',
      '/api/graph/settings',
      '/api/graph/state',
      '/api/graph/review',
      '/api/graph/explore',
    ])
      expect((await f.app.inject({ url })).statusCode).toBe(401);
    for (const query of [
      'view=other',
      'nodeKinds=unknown',
      'includeSuggested=maybe',
      'minConfidence=2',
      'similarityThreshold=1.01',
      'similarityThreshold=-0.1',
      'similarityThreshold=NaN',
      'unknown=value',
      'limit=1001',
    ])
      expect((await get('/api/graph/explore?' + query)).statusCode, query).toBe(400);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/graph/jobs',
          headers,
          payload: { action: 'other' },
        })
      ).statusCode,
    ).toBe(400);
  });

  it('accepts cosine thresholds independently of relation confidence', async () => {
    for (const threshold of [0, 0.65, 1]) {
      const result = await get(
        `/api/graph/explore?view=notes&includeSimilarity=true&similarityThreshold=${threshold}&minConfidence=1`,
      );
      expect(result.statusCode, result.body).toBe(200);
    }
  });

  it('version-checks model configuration and returns only safe public settings', async () => {
    const before = (await get('/api/graph/settings')).json();
    expect(before.provider).toBe('none');
    expect(before.apiKeyConfigured).toBe(false);
    expect(before).not.toHaveProperty('apiKey');
    const { version, apiKeyConfigured: _configured, ...settings } = before;
    const body = { ...settings, expectedVersion: version };
    const saved = await f.app.inject({
      method: 'PUT',
      url: '/api/graph/settings',
      headers,
      payload: body,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().version).toBe(version + 1);
    expect(
      (await f.app.inject({ method: 'PUT', url: '/api/graph/settings', headers, payload: body }))
        .statusCode,
    ).toBe(409);
    const test = await f.app.inject({
      method: 'POST',
      url: '/api/graph/settings/test',
      headers,
      payload: {},
    });
    expect(test.statusCode, test.body).toBe(200);
    expect(test.json().ok).toBe(false);
    const forbiddenHeaders = { ...headers, origin: 'https://another.invalid' };
    expect(
      (
        await f.app.inject({
          method: 'PUT',
          url: '/api/graph/settings',
          headers: forbiddenHeaders,
          payload: body,
        })
      ).statusCode,
    ).toBe(403);
  });

  it('persists saved views with CAS and stable request identity', async () => {
    const before = (await get('/api/graph/state')).json();
    const command = {
      requestId: randomUUID(),
      expectedVersion: before.version,
      action: 'save-view',
      name: '容器知识',
      query: { view: 'knowledge', q: 'Docker', includeSimilarity: true, similarityThreshold: 0.7 },
    };
    const saved = await f.app.inject({
      method: 'POST',
      url: '/api/graph/commands',
      headers,
      payload: command,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().views.some((view: { name: string }) => view.name === '容器知识')).toBe(
      true,
    );
    expect(
      saved.json().views.find((view: { name: string }) => view.name === '容器知识').query,
    ).toMatchObject({ includeSimilarity: true, similarityThreshold: 0.7 });
    const retry = await f.app.inject({
      method: 'POST',
      url: '/api/graph/commands',
      headers,
      payload: command,
    });
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json()).toEqual(saved.json());
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/graph/commands',
          headers,
          payload: { ...command, requestId: randomUUID() },
        })
      ).statusCode,
    ).toBe(409);
  });

  it('pauses background analysis and resumes the pending source without a graph request', async () => {
    const paused = await f.app.inject({
      method: 'POST',
      url: '/api/graph/jobs',
      headers,
      payload: { action: 'pause' },
    });
    expect(paused.statusCode, paused.body).toBe(200);
    await create('暂停期间新增.md', '# 向量检索\n\n向量检索关联知识图谱。知识图谱帮助检索。');
    await vi.waitFor(
      async () => {
        const status = (await get('/api/graph/status')).json();
        expect(status.state).toBe('paused');
        expect(status.pending).toBeGreaterThan(0);
      },
      { timeout: 5000, interval: 50 },
    );
    const resumed = await f.app.inject({
      method: 'POST',
      url: '/api/graph/jobs',
      headers,
      payload: { action: 'resume' },
    });
    expect(resumed.statusCode, resumed.body).toBe(200);
    await vi.waitFor(
      async () => {
        const status = (await get('/api/graph/status')).json();
        expect(status.pending).toBe(0);
        expect(status.completed).toBeGreaterThanOrEqual(3);
      },
      { timeout: 15000, interval: 50 },
    );
  });

  it('rejects invalid questions and reports missing model configuration explicitly', async () => {
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/graph/ask',
          headers,
          payload: { question: '' },
        })
      ).statusCode,
    ).toBe(400);
    const result = await f.app.inject({
      method: 'POST',
      url: '/api/graph/ask',
      headers,
      payload: { question: 'Docker 依赖什么？', nodeId: source.id },
    });
    expect(result.statusCode, result.body).toBe(503);
    expect(result.json().code).toBe('GRAPH_MODEL_NOT_CONFIGURED');
  });
});
