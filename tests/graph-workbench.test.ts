import { describe, expect, test, vi } from 'vitest';
import { createGraphWorkbench } from '../apps/web/graph-workbench';
const response = (id = 'a', pending = 0) => ({
  nodes: [{ id, title: id, relativePath: `${id}.md`, directory: '', incoming: 0, outgoing: 0 }],
  edges: [],
  status: { revision: id, state: 'idle' },
  totalNodes: 1,
  totalEdges: 0,
  truncated: false,
  index: { scanned: 1, indexed: 1, skipped: 0, pending, complete: pending === 0 },
});
describe('graph workbench', () => {
  test('serializes filters and drops stale responses and stale errors', async () => {
    const replies: Array<{ resolve: (v: any) => void; reject: (v: any) => void }> = [];
    const request = vi.fn(
      (_url: string) => new Promise<any>((resolve, reject) => replies.push({ resolve, reject })),
    );
    const model = createGraphWorkbench(request);
    const first = model.load();
    model.state.query = {
      folder: '资料/one',
      q: 'foo & bar',
      mode: 'orphans',
      focus: 'b',
      depth: 2,
    };
    const second = model.load();
    expect(
      new URL(request.mock.calls[1]![0] as string, 'http://localhost').searchParams.get('q'),
    ).toBe('foo & bar');
    replies[1]!.resolve(response('b'));
    await second;
    replies[0]!.reject(Error('old'));
    await first;
    expect(model.state.result?.nodes[0]?.id).toBe('b');
    expect(model.state.error).toBe('');
  });
  test('invalidates requests immediately when filters change before a debounced load', async () => {
    let resolve!: (value: any) => void;
    const model = createGraphWorkbench(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const loading = model.load();
    model.state.query.q = 'new filter';
    resolve(response('old'));
    await loading;
    expect(model.state.result).toBeUndefined();
    expect(model.state.loading).toBe(false);
    model.dispose();
  });
  test('retains result on retry failure and reconciles selection after filtering', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(response())
      .mockRejectedValueOnce(Error('offline'))
      .mockResolvedValueOnce(response('b'));
    const model = createGraphWorkbench(request);
    await model.load();
    model.select('a');
    await model.load();
    expect(model.state.result?.nodes[0]?.id).toBe('a');
    expect(model.state.error).toBe('offline');
    await model.load();
    expect(model.state.selectedId).toBe('');
  });
  test('does one bounded explore request and ignores loads after disposal', async () => {
    const request = vi.fn().mockResolvedValue(response('a', 10));
    const model = createGraphWorkbench(request);
    await model.load();
    expect(request).toHaveBeenCalledTimes(1);
    expect(model.state.result?.index.pending).toBe(10);
    model.dispose();
    await model.load();
    expect(request).toHaveBeenCalledTimes(1);
  });
  test('disposal invalidates an in-flight response', async () => {
    let resolve!: (value: any) => void;
    const model = createGraphWorkbench(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const loading = model.load();
    model.dispose();
    resolve(response());
    await loading;
    expect(model.state.result).toBeUndefined();
    expect(model.state.loading).toBe(false);
  });
  test('uses semantic endpoint and comma separated kind filters', async () => {
    const request = vi.fn().mockResolvedValue(response());
    const model = createGraphWorkbench(request);
    model.state.query.nodeKinds = ['concept', 'person'];
    model.state.query.edgeKinds = ['semantic', 'manual'];
    await model.load();
    const url = new URL(request.mock.calls[0]![0], 'http://localhost');
    expect(url.pathname).toBe('/api/graph/explore');
    expect(url.searchParams.get('nodeKinds')).toBe('concept,person');
    expect(url.searchParams.get('edgeKinds')).toBe('semantic,manual');
    model.dispose();
  });
  test('sends CAS version and unique request id for portable commands', async () => {
    const request = vi.fn(async (url: string) =>
      url.includes('/commands')
        ? { version: 8, views: [] }
        : url.includes('/explore')
          ? response()
          : [],
    );
    const model = createGraphWorkbench(request);
    model.state.user.version = 7;
    await model.command({ action: 'alias', entityId: 'concept:a', alias: '名称' });
    const call = request.mock.calls.find(
      (call) => call[0] === '/api/graph/commands',
    ) as unknown as [string, string, any];
    expect(call[1]).toBe('POST');
    expect(call[2]).toMatchObject({ expectedVersion: 7, action: 'alias', entityId: 'concept:a' });
    expect(call[2].requestId).toMatch(/^[a-f0-9-]{36}$/);
    expect(model.state.user.version).toBe(8);
    model.dispose();
  });
  test('polling does not overlap and stops after disposal', async () => {
    vi.useFakeTimers();
    let resolve!: (v: any) => void;
    const request = vi.fn(() => new Promise((done) => (resolve = done)));
    const model = createGraphWorkbench(request);
    model.startPolling();
    await vi.advanceTimersByTimeAsync(3000);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(12000);
    expect(request).toHaveBeenCalledTimes(1);
    model.dispose();
    resolve({ revision: 'new' });
    await vi.advanceTimersByTimeAsync(6000);
    expect(request).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
  test('refreshes portable state after a version conflict so retry can recover', async () => {
    const request = vi.fn(async (url: string) => {
      if (url === '/api/graph/commands') throw Object.assign(Error('conflict'), { status: 409 });
      if (url === '/api/graph/state') return { version: 9, views: [] };
      return response();
    });
    const model = createGraphWorkbench(request);
    await model.command({ action: 'alias', entityId: 'a', alias: 'b' });
    expect(model.state.error).toBe('conflict');
    expect(model.state.user.version).toBe(9);
    model.dispose();
  });
  test('hides suggested relations by default and bounds the published view to 120 edges', async () => {
    const dense = {
      ...response(),
      edges: Array.from({ length: 400 }, (_, i) => ({ id: `edge-${i}`, source: 'a', target: 'a' })),
      totalEdges: 400,
    };
    const request = vi.fn().mockResolvedValue(dense);
    const model = createGraphWorkbench(request);
    await model.load();
    expect(
      new URL(request.mock.calls[0]![0], 'http://localhost').searchParams.get('includeSuggested'),
    ).toBe('false');
    expect(model.state.result?.edges).toHaveLength(120);
    expect(model.state.result?.truncated).toBe(true);
    expect(model.state.result?.totalEdges).toBe(400);
    expect(dense.edges).toHaveLength(400);
    model.select('edge-399');
    await model.load();
    expect(model.state.selectedId).toBe('');
    model.dispose();
  });
  test('pages and searches review items without hiding the tail', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(Array.from({ length: 50 }, (_, i) => ({ id: `r${i}` })))
      .mockResolvedValueOnce([{ id: 'r50' }, { id: 'r51' }]);
    const model = createGraphWorkbench(request);
    await model.review('suggested', '实体 & 关系');
    expect(model.state.reviewHasMore).toBe(true);
    await model.review('suggested', '实体 & 关系', true);
    const url = new URL(request.mock.calls[1]![0], 'http://localhost');
    expect(url.searchParams.get('offset')).toBe('50');
    expect(url.searchParams.get('q')).toBe('实体 & 关系');
    expect(model.state.reviews).toHaveLength(52);
    expect(model.state.reviewHasMore).toBe(false);
    model.dispose();
  });
  test('drops an older review page when status or search changes', async () => {
    const replies: Array<(v: any) => void> = [];
    const request = vi.fn(() => new Promise((done) => replies.push(done)));
    const model = createGraphWorkbench(request);
    const first = model.review('suggested', 'old');
    const second = model.review('accepted', 'new');
    replies[1]!([{ id: 'new' }]);
    await second;
    replies[0]!(Array.from({ length: 50 }, () => ({ id: 'old' })));
    await first;
    expect(model.state.reviews.map((item) => item.id)).toEqual(['new']);
    expect(model.state.reviewHasMore).toBe(false);
    expect(model.state.reviewLoading).toBe(false);
    model.dispose();
  });
  test('retries an unknown command outcome with the original frozen identity and creates once', async () => {
    const bodies: any[] = [];
    const applied = new Map<string, any>();
    let creates = 0;
    const request = vi.fn(async (url: string, _method?: string, body?: any) => {
      if (url === '/api/graph/commands') {
        bodies.push(structuredClone(body));
        if (!applied.has(body.requestId))
          applied.set(body.requestId, { version: ++creates, views: [] });
        if (bodies.length === 1) throw Error('network interrupted after server commit');
        return applied.get(body.requestId);
      }
      return url.includes('/explore') ? response() : [];
    });
    const model = createGraphWorkbench(request);
    await model.command({
      action: 'save-view',
      name: '保留',
      query: { view: 'knowledge', q: '原始' },
    });
    expect(model.state.error).toContain('network interrupted');
    model.state.user.version = 42;
    await model.command({
      action: 'save-view',
      name: '保留',
      query: { q: '原始', view: 'knowledge' },
    });
    expect(bodies[1]).toEqual(bodies[0]);
    expect(creates).toBe(1);
    model.dispose();
  });
  test('commands work on HTTP browsers without crypto.randomUUID', async () => {
    const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
    vi.stubGlobal('crypto', { getRandomValues });
    try {
      const request = vi.fn(async (url: string) =>
        url === '/api/graph/commands'
          ? { version: 1, views: [] }
          : url.includes('/explore')
            ? response()
            : [],
      );
      const model = createGraphWorkbench(request);
      await model.command({ action: 'alias', entityId: 'a', alias: '名称' });
      expect(request.mock.calls.some((call) => call[0] === '/api/graph/commands')).toBe(true);
      expect(model.state.error).toBe('');
      model.dispose();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
