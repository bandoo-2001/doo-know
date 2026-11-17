import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { checkedToDooQueryUrl, toDooIdQueryBatches, toDooQueryCursorReserve } from '../apps/web/to-doo-query-batches';

const makeUrl = (ids: string[]) => '/api/to-doo/state?kind=task&ids=' + encodeURIComponent(ids.join(',')) + '&limit=200';
const origin = 'https://tasks.example.test';
function verify(values: string[], maxCount = 200, reserve = 0) {
  const batches = toDooIdQueryBatches(values, id => id, makeUrl, { maxCount, origin, reserve });
  expect(batches.flatMap(batch => batch.values)).toEqual(values);
  for (const batch of batches) {
    expect(batch.values.length).toBeLessThanOrEqual(maxCount);
    const url = new URL(batch.url, origin), csv = url.searchParams.get('ids')!;
    expect(csv).toBe(batch.values.join(','));
    expect(csv.length).toBeLessThanOrEqual(8192);
    expect(encodeURIComponent(csv).length).toBeLessThanOrEqual(8192);
    expect(url.href.length + reserve).toBeLessThanOrEqual(8192);
  }
  return batches;
}

it('keeps 200 ordinary UUIDs in one request', () => {
  expect(verify(Array.from({ length: 200 }, () => randomUUID()))).toHaveLength(1);
});
it('splits legal 128-character identifiers without truncating or reordering them', () => {
  const ids = Array.from({ length: 200 }, (_, i) => String(i).padStart(4, '0') + 'a'.repeat(124));
  expect(verify(ids).length).toBeGreaterThan(1);
});
it('budgets URI expansion and the complete origin even for encoded input', () => {
  // The current business ID schema rejects these characters. The generic URL
  // budget must still be correct rather than assuming one character is one byte.
  const values = Array.from({ length: 80 }, (_, i) => '资料:' + i + '界'.repeat(100));
  expect(verify(values).length).toBeGreaterThan(1);
});
it('reserves room for a continuation cursor while preserving ordinary batches', () => {
  expect(verify(Array.from({ length: 50 }, () => randomUUID()), 50, toDooQueryCursorReserve)).toHaveLength(1);
  const values = Array.from({ length: 100 }, (_, i) => String(i).padStart(4, '0') + 'z'.repeat(124));
  const batches = verify(values, 50, toDooQueryCursorReserve);
  for (const batch of batches)
    expect(() => checkedToDooQueryUrl(batch.url + '&cursor=' + 'a'.repeat(2048), { origin })).not.toThrow();
});
it('does not send an empty all-entities query or accept an oversized single value', () => {
  expect(toDooIdQueryBatches([], id => id, makeUrl, { maxCount: 200 })).toEqual([]);
  expect(() => verify(['x'.repeat(9000)])).toThrow();
  expect(() => verify([''])).toThrow();
  expect(() => verify(['a,b'])).toThrow();
});
it('rejects a builder that drops or double-encodes identifiers', () => {
  expect(() => toDooIdQueryBatches(['a', 'b'], id => id,
    ids => '/api/to-doo/state?ids=' + encodeURIComponent(encodeURIComponent(ids.join(','))),
    { maxCount: 200 })).toThrow('标识不完整');
});
