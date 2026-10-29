import { describe, expect, test, vi } from 'vitest';
import { createGraphWorkbench } from '../apps/web/graph-workbench';
const response = (id = 'a', pending = 0) => ({
  nodes: [{ id, title: id, relativePath: `${id}.md`, directory: '', incoming: 0, outgoing: 0 }],
  edges: [],
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
  test('bounds pending continuation and ignores results after disposal', async () => {
    const request = vi.fn().mockResolvedValue(response('a', 10));
    const model = createGraphWorkbench(request);
    await model.load();
    expect(request).toHaveBeenCalledTimes(3);
    expect(model.state.result?.index.pending).toBe(10);
    model.dispose();
    await model.load();
    expect(request).toHaveBeenCalledTimes(3);
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
});
