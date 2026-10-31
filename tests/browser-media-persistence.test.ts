import { expect, it, vi, afterEach } from 'vitest';
vi.mock('../apps/web/api', () => ({
  api: vi.fn(async () => ({ markdownPath: 'assets/persisted.wav' })),
}));
import { api } from '../apps/web/api';
import { persistBrowserMedia } from '../apps/web/diagrams/persist-browser-media';
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it('persists browser-owned blob once and rewrites only effective Markdown/HTML resources', async () => {
  const fetch = vi.fn(async () => new Response(new Blob(['wav'], { type: 'audio/wav' })));
  vi.stubGlobal('fetch', fetch);
  const src =
    '<audio src="blob:https://local/id"></audio>\n\n[media](blob:https://local/id)\n\n`[example](blob:https://local/id)`';
  const next = await persistBrowserMedia('note', src);
  expect(fetch).toHaveBeenCalledOnce();
  expect(api).toHaveBeenCalledOnce();
  expect(next).toContain('<audio src="assets/persisted.wav">');
  expect(next).toContain('[media](assets/persisted.wav)');
  expect(next).toContain('`[example](blob:https://local/id)`');
});
it('reports expired or untyped blob bytes before saving a false local link', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw Error('expired');
    }),
  );
  await expect(persistBrowserMedia('note', '[media](blob:https://local/id)')).rejects.toThrow(
    '已失效',
  );
  expect(api).not.toHaveBeenCalled();
});
