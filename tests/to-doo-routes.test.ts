import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createFixture, loginFixtureOwner, type Fixture } from './support/fixture';

let f: Fixture;
let headers: Awaited<ReturnType<typeof loginFixtureOwner>>;
beforeAll(async () => {
  f = await createFixture();
  headers = await loginFixtureOwner(f);
});
afterAll(async () => f?.close());

it('provides an authenticated To Doo state independently of public note access', async () => {
  const response = await f.app.inject({ url: '/api/to-doo/state', headers });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toHaveProperty('settings');
  expect((await f.app.inject({ url: '/api/to-doo/state' })).statusCode).toBe(401);
});

it('provides current navigation preferences without loading a full workbench snapshot', async () => {
  const state = (await f.app.inject({ url: '/api/to-doo/state', headers })).json();
  const response = await f.app.inject({ url: '/api/to-doo/settings', headers });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toEqual(state.settings);
  expect(response.json()).not.toHaveProperty('statistics');
  expect((await f.app.inject({ url: '/api/to-doo/settings' })).statusCode).toBe(401);
});

it('rejects cross-origin and CSRF-free task mutations', async () => {
  const payload = {
    requestId: randomUUID(),
    action: 'create_task',
    payload: { title: 'Private task' },
  };
  const noCsrf = await f.app.inject({
    method: 'POST',
    url: '/api/to-doo/commands',
    headers: { cookie: headers.cookie, origin: headers.origin },
    payload,
  });
  expect(noCsrf.statusCode).toBe(403);
  const crossOrigin = await f.app.inject({
    method: 'POST',
    url: '/api/to-doo/commands',
    headers: { ...headers, origin: 'https://untrusted.example' },
    payload,
  });
  expect(crossOrigin.statusCode).toBe(403);
});

it('rejects invalid dates, collection names, malformed filters and trusted-only full export flags', async () => {
  for (const query of [
    'from=2026-02-31',
    'kinds=not-a-collection',
    'filter=%7Bbroken',
    'all=true',
  ]) {
    const response = await f.app.inject({ url: '/api/to-doo/state?' + query, headers });
    expect(response.statusCode, query + ': ' + response.body).toBe(400);
  }
});

it('does not expose a public application or raw portable task path', async () => {
  expect((await f.app.inject({ url: '/api/to-doo/state' })).statusCode).toBe(401);
  const file = join(f.knowledgeRoot, '_doo-data/apps/to-doo/tasks/http-boundary-fixture.json');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ privateContent: 'TASK_CONTENT_MUST_REMAIN_PRIVATE' }));
  try {
    const response = await f.app.inject({
      url: '/_doo-data/apps/to-doo/tasks/http-boundary-fixture.json',
    });
    expect(response.body).not.toContain('TASK_CONTENT_MUST_REMAIN_PRIVATE');
  } finally {
    await unlink(file);
  }
});

it('persists focus projects and exposes private validated history through the owner API', async () => {
  const topicId = 'http-focus-' + randomUUID();
  const saved = await f.app.inject({
    method: 'POST',
    url: '/api/to-doo/commands',
    headers,
    payload: {
      requestId: randomUUID(),
      action: 'save_entity',
      payload: { kind: 'focusTopic', entity: { id: topicId, name: 'HTTP 专注项目' } },
    },
  });
  expect(saved.statusCode, saved.body).toBe(200);
  const session = await f.app.inject({
    method: 'POST',
    url: '/api/to-doo/commands',
    headers,
    payload: {
      requestId: randomUUID(),
      action: 'save_entity',
      payload: {
        kind: 'focusSession',
        entity: {
          topicId,
          mode: 'stopwatch',
          status: 'finished',
          segments: [{ start: '2026-10-30T08:00:00Z', end: '2026-10-30T08:25:00Z' }],
        },
      },
    },
  });
  expect(session.statusCode, session.body).toBe(200);
  const response = await f.app.inject({
    url: '/api/to-doo/focus/history?topicId=' + topicId + '&limit=1&from=2026-10-30&to=2026-10-30',
    headers,
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toMatchObject({
    items: [{ topicId, topicName: 'HTTP 专注项目' }],
    overview: { filtered: { completed: 1, minutes: 25 } },
    page: { total: 1 },
  });
  const sessionId = session.json().ids[0];
  const trend = await f.app.inject({
    url:
      '/api/to-doo/focus/history?topicId=' +
      topicId +
      '&limit=1&trendPeriod=year&trendDate=2026-10-30',
    headers,
  });
  expect(trend.statusCode, trend.body).toBe(200);
  expect(trend.json().trend).toMatchObject({
    period: 'year',
    from: '2026-01-01',
    to: '2026-12-31',
    totalMinutes: 25,
  });
  expect(trend.json().trend.points[9]).toEqual({ date: '2026-10-01', minutes: 25 });
  const selected = await f.app.inject({
    url: '/api/to-doo/focus/history?ids=' + sessionId,
    headers,
  });
  expect(selected.statusCode, selected.body).toBe(200);
  expect(selected.json().items.map((item: any) => item.id)).toEqual([sessionId]);
  for (const selector of ['', 'missing-focus-session']) {
    const empty = await f.app.inject({ url: '/api/to-doo/focus/history?ids=' + selector, headers });
    expect(empty.statusCode, empty.body).toBe(200);
    expect(empty.json().items).toEqual([]);
    expect(empty.json().page.total).toBe(0);
  }
  expect((await f.app.inject({ url: '/api/to-doo/focus/history' })).statusCode).toBe(401);
  for (const query of [
    'limit=101',
    'trendPeriod=day',
    'trendPeriod=month&trendDate=2026-02-31',
    'trendDate=2026-10-30',
    'from=2026-10-31&to=2026-10-30',
    'all=true',
    'cursor=invalid',
    'topicId=' + topicId + '&unassigned=true',
    'ids=' + Array.from({ length: 51 }, (_, i) => 'id-' + i).join(','),
  ]) {
    const invalid = await f.app.inject({ url: '/api/to-doo/focus/history?' + query, headers });
    expect(invalid.statusCode, query + ': ' + invalid.body).toBe(400);
  }
});
