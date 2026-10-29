import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixture, loginFixtureOwner, type Fixture } from './support/fixture';

describe('authenticated knowledge graph API', () => {
  let f: Fixture;
  let headers: Awaited<ReturnType<typeof loginFixtureOwner>>;
  let first: { id: string; relativePath: string }, second: { id: string; relativePath: string };
  beforeAll(async () => {
    f = await createFixture();
    headers = await loginFixtureOwner(f);
    const create = async (fileName: string, content: string) => {
      const result = await f.app.inject({ method: 'POST', url: '/api/notes', headers, payload: { folderPath: '00-Inbox', fileName, content } });
      expect(result.statusCode, result.body).toBe(201);
      return result.json();
    };
    second = await create('graph-target.md', '# Graph target');
    first = await create('graph-source.md', '# Graph source\n\n[[graph-target]]');
  });
  afterAll(async () => { await f?.close(); });

  it('returns actual directed note relationships without an external search runtime', async () => {
    const response = await f.app.inject({ url: '/api/graph', headers });
    expect(response.statusCode, response.body).toBe(200);
    const result = response.json();
    expect(result.nodes.map((node: { id: string }) => node.id)).toEqual(expect.arrayContaining([first.id, second.id]));
    expect(result.edges).toEqual([expect.objectContaining({ source: first.id, target: second.id })]);
    expect(result.index.complete).toBe(true);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('keeps graph data private and has no public share endpoint', async () => {
    expect((await f.app.inject({ url: '/api/graph' })).statusCode).toBe(401);
    const share = await f.app.inject({ method: 'POST', url: `/api/notes/${second.id}/share`, headers, payload: {} });
    expect(share.statusCode).toBe(200);
    expect((await f.app.inject({ url: '/api/graph?share=' + share.json().token })).statusCode).toBe(401);
    expect((await f.app.inject({ url: '/api/public/shares/' + share.json().token + '/graph' })).statusCode).toBe(404);
  });

  it('matches title and path keywords without depending on their letter case', async () => {
    const response = await f.app.inject({ url: '/api/graph?q=GRAPH', headers });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().nodes.map((node: { id: string }) => node.id)).toEqual(expect.arrayContaining([first.id, second.id]));
  });

  it('validates query bounds instead of silently accepting malformed or unbounded requests', async () => {
    for (const query of ['unknown=value', 'limit=0', 'limit=1001', 'limit=nope', 'limit=2&limit=3', 'depth=3', 'depth=1.5', 'mode=unknown', 'folder=..%2Fprivate', 'q=' + 'x'.repeat(257)]) {
      const response = await f.app.inject({ url: '/api/graph?' + query, headers });
      expect(response.statusCode, query + ': ' + response.body).toBe(400);
    }
  });

  it('supports focused neighborhoods and reports unavailable focus explicitly', async () => {
    const response = await f.app.inject({ url: `/api/graph?focus=${first.id}&depth=2&limit=10`, headers });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().nodes.map((node: { id: string }) => node.id)).toEqual(expect.arrayContaining([first.id, second.id]));
    expect((await f.app.inject({ url: '/api/graph?focus=not-a-note', headers })).statusCode).toBe(404);
  });
});
