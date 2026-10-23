import { expect, it } from 'vitest';
import { collectionWindow } from '../apps/web/collection-window';

it('keeps ten thousand cards bounded to visible rows and overscan', () => {
  const window = collectionWindow({ count: 10000, width: 960, height: 600, scrollTop: 80000 });
  expect(window).toMatchObject({
    columns: 4,
    start: 1184,
    end: 1212,
    top: 79328,
    bottom: 588796,
    totalHeight: 669984,
  });
  expect(window.end - window.start).toBe(28);
});
it('uses one mobile column and renders the final row even after an oversized scroll restoration', () => {
  const mobile = collectionWindow({ count: 10000, width: 360, height: 600, scrollTop: 0 });
  expect(mobile.columns).toBe(1);
  expect(mobile.end).toBe(5);
  const last = collectionWindow({ count: 10000, width: 960, height: 600, scrollTop: 1e8 });
  expect(last.end).toBe(10000);
  expect(last.start).toBeLessThan(last.end);
  expect(last.end - last.start).toBeLessThanOrEqual(36);
});
