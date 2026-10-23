import { expect, it, vi } from 'vitest';
import { createCollectionFeed } from '../apps/web/collection-feed';
import { ApiError } from '../apps/web/api';

const item = (id: string) => ({
  id,
  path: `00-Inbox/${id}.md`,
  name: `${id}.md`,
  title: id,
  summary: '摘要',
  summaryState: 'ready' as const,
  updatedAt: '2026-10-20T08:00:00.000Z',
  favorite: false,
});
const page = (ids: string[], cursor: string | null = null, version = 'one') => ({
  items: ids.map(item),
  nextCursor: cursor,
  total: 60,
  version,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it('requests only the selected collection page and coalesces duplicate loads', async () => {
  const more = deferred<ReturnType<typeof page>>();
  const request = vi
    .fn()
    .mockResolvedValueOnce(page(['a', 'b'], 'after-b'))
    .mockReturnValueOnce(more.promise);
  const feed = createCollectionFeed(request);
  await feed.select('recent');
  expect(request.mock.calls[0][0]).toBe('/api/collections?kind=recent&limit=24');
  const first = feed.loadMore(),
    second = feed.loadMore();
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls[1][0]).toBe('/api/collections?kind=recent&limit=24&cursor=after-b');
  more.resolve(page(['b', 'c']));
  await Promise.all([first, second]);
  expect(feed.items.value.map((note) => note.id)).toEqual(['a', 'b', 'c']);
  await feed.loadMore();
  expect(request).toHaveBeenCalledTimes(2);
});

it('keeps late responses in their own collection and restores each scroll position', async () => {
  const recent = deferred<ReturnType<typeof page>>();
  const request = vi
    .fn()
    .mockReturnValueOnce(recent.promise)
    .mockResolvedValueOnce({
      ...page(['favorite']),
      items: [{ ...item('favorite'), favorite: true }],
    });
  const feed = createCollectionFeed(request);
  const pending = feed.select('recent');
  await feed.select('favorites');
  feed.rememberScroll(640);
  recent.resolve(page(['recent']));
  await pending;
  expect(feed.items.value.map((note) => note.id)).toEqual(['favorite']);
  await feed.select('recent');
  feed.rememberScroll(210);
  await feed.select('favorites');
  expect(feed.scrollTop.value).toBe(640);
  expect(request).toHaveBeenCalledTimes(2);
});

it('refreshes the sidebar head after a version change without shifting visible cards', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(page(['old'], 'next'))
    .mockResolvedValueOnce({ total: 61, version: 'two' })
    .mockResolvedValueOnce(page(['new', 'old'], null, 'two'))
    .mockResolvedValueOnce(page(['new', 'old'], null, 'two'));
  const feed = createCollectionFeed(request);
  await feed.select('recent');
  feed.rememberScroll(1000);
  await feed.checkForUpdates();
  expect(feed.items.value.map((note) => note.id)).toEqual(['old']);
  expect(feed.head.value.map((note) => note.id)).toEqual(['new', 'old']);
  expect(feed.updated.value).toBe(true);
  expect(feed.scrollTop.value).toBe(1000);
  await feed.refresh();
  expect(feed.items.value.map((note) => note.id)).toEqual(['new', 'old']);
  expect(feed.updated.value).toBe(false);
  expect(feed.scrollTop.value).toBe(0);
});

it('preserves loaded cards and stops automatic paging when its cursor becomes stale', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(page(['a'], 'next'))
    .mockRejectedValueOnce(new ApiError(409, { code: 'COLLECTION_CHANGED', error: 'changed' }));
  const feed = createCollectionFeed(request);
  await feed.select('recent');
  await feed.loadMore();
  expect(feed.items.value.map((note) => note.id)).toEqual(['a']);
  expect(feed.updated.value).toBe(true);
  await feed.loadMore();
  expect(request).toHaveBeenCalledTimes(2);
});

it('retries the failed page with the same cursor and preserves the preceding cards', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(page(['a'], 'after-a'))
    .mockRejectedValueOnce(new Error('network'))
    .mockResolvedValueOnce(page(['b']));
  const feed = createCollectionFeed(request);
  await feed.select('recent');
  await feed.loadMore();
  expect(feed.error.value).toBeTruthy();
  await feed.retry();
  expect(request.mock.calls[2][0]).toBe(request.mock.calls[1][0]);
  expect(feed.items.value.map((note) => note.id)).toEqual(['a', 'b']);
});

it('keeps a delayed background head from replacing a newer explicit refresh', async () => {
  const oldHead = deferred<ReturnType<typeof page>>();
  const request = vi
    .fn()
    .mockResolvedValueOnce(page(['a']))
    .mockResolvedValueOnce({ total: 61, version: 'two' })
    .mockReturnValueOnce(oldHead.promise)
    .mockResolvedValueOnce(page(['newest'], null, 'three'));
  const feed = createCollectionFeed(request);
  await feed.select('recent');
  const check = feed.checkForUpdates();
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
  await feed.refresh();
  oldHead.resolve(page(['old-head'], null, 'two'));
  await check;
  expect(feed.head.value.map((note) => note.id)).toEqual(['newest']);
  expect(feed.items.value.map((note) => note.id)).toEqual(['newest']);
});

it('applies a successful favorite change over a page that was already in flight', async () => {
  const first = deferred<ReturnType<typeof page>>();
  const request = vi.fn().mockReturnValue(first.promise);
  const feed = createCollectionFeed(request);
  const loading = feed.select('recent');
  feed.updateFavorite('a', true);
  first.resolve(page(['a']));
  await loading;
  expect(feed.items.value[0].favorite).toBe(true);
});

it('reconciles fresher favorite flags across an inactive cached overview', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce({ ...page(['a']), items: [{ ...item('a'), favorite: true }] })
    .mockResolvedValueOnce(page(['a'], null, 'two'));
  const feed = createCollectionFeed(request);
  await feed.select('favorites');
  await feed.select('recent');
  expect(feed.items.value[0].favorite).toBe(false);
  expect(feed.entriesFor('favorites').some((note) => note.id === 'a' && note.favorite)).toBe(false);
});

it('ignores stale background status totals after an explicit refresh completes', async () => {
  const status = deferred<{ total: number; version: string }>();
  const request = vi
    .fn()
    .mockResolvedValueOnce(page(['a']))
    .mockReturnValueOnce(status.promise)
    .mockResolvedValueOnce(page(['newest'], null, 'three'));
  const feed = createCollectionFeed(request);
  await feed.select('recent');
  const checking = feed.checkForUpdates();
  await feed.refresh();
  status.resolve({ total: 999, version: 'two' });
  await checking;
  expect(feed.total.value).toBe(60);
  expect(feed.items.value.map((note) => note.id)).toEqual(['newest']);
});
