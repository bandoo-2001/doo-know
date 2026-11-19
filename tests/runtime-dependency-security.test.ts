import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import sanitizeHtml from 'sanitize-html';

it('handles discarded iframe fallback without overflowing the call stack or bypassing the nesting limit', () => {
  // GHSA-c9rx-x947-fp3h: 2.18.0 restarted sanitization on each discarded
  // iframe, overflowing on a small input and resetting the nesting counter.
  let result = '';
  expect(() => {
    result = sanitizeHtml('<iframe>'.repeat(2500));
  }).not.toThrow();
  expect(result).not.toContain('<iframe');
  const nested = sanitizeHtml(('<iframe>' + '<b>'.repeat(3)).repeat(50) + 'x', {
    allowedTags: ['b'],
    nestingLimit: 3,
  });
  let depth = 0,
    maximum = 0;
  for (const tag of nested.match(/<\/?b>/g) || []) {
    depth += tag === '<b>' ? 1 : -1;
    maximum = Math.max(maximum, depth);
  }
  expect(maximum).toBeLessThanOrEqual(3);
});

it.each(['runtime serializer', 'AJV schema resolver'])(
  'keeps encoded dangerous URI schemes inert in the %s dependency branch',
  (branch) => {
    const root = createRequire(import.meta.url);
    const require =
      branch === 'AJV schema resolver' ? createRequire(root.resolve('ajv/package.json')) : root;
    const uri = require('fast-uri');
    // GHSA-w74x-v6f9-j3xg: decoding a percent-encoded scheme must not turn
    // an inert string into an executable javascript URL.
    expect(uri.normalize('%6Aavascript:alert(1)')).not.toMatch(/^javascript:/i);
    expect(uri.parse('%6Aavascript:alert(1)').scheme).not.toBe('javascript');
    expect(uri.normalize('https://example.test/a')).toBe('https://example.test/a');
  },
);
