import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../apps/web/api';
afterEach(() => vi.unstubAllGlobals());
it('lets a caller bound a slow request and complete the same response with a larger budget', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_url: string, options: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const aborted = () => {
            clearTimeout(timer);
            reject(options.signal?.reason || new DOMException('Aborted', 'AbortError'));
          };
          const timer = setTimeout(() => {
            options.signal?.removeEventListener('abort', aborted);
            resolve(
              new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }),
            );
          }, 30);
          options.signal?.addEventListener('abort', aborted, { once: true });
          if (options.signal?.aborted) aborted();
        }),
    ),
  );
  await expect(api('/budget', 'GET', undefined, { timeoutMs: 5 })).rejects.toBeDefined();
  await expect(api('/budget', 'GET', undefined, { timeoutMs: 200 })).resolves.toEqual({ ok: true });
});
