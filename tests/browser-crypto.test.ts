import { expect, it } from 'vitest';
import { installBrowserUUID } from '../apps/web/browser-crypto';

it('generates distinct UUID v4 request IDs when HTTP does not expose randomUUID', () => {
  const browser: Pick<Crypto, 'getRandomValues'> & Partial<Pick<Crypto, 'randomUUID'>> = {
    getRandomValues: crypto.getRandomValues.bind(crypto),
  };
  installBrowserUUID(browser);
  const ids = Array.from({ length: 256 }, () => browser.randomUUID!());
  expect(new Set(ids).size).toBe(256);
  for (const id of ids)
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

it('preserves the native UUID function in secure contexts', () => {
  const native = crypto.randomUUID;
  const browser = { getRandomValues: crypto.getRandomValues.bind(crypto), randomUUID: native };
  installBrowserUUID(browser);
  expect(browser.randomUUID).toBe(native);
});
