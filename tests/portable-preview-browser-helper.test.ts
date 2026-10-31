import { expect, it, vi, afterEach } from 'vitest';
vi.mock('../apps/web/api', () => ({ api: vi.fn() }));
vi.mock('../apps/web/diagrams/primary-api', () => ({
  renderPrimaryPng: vi.fn(async () => new Blob(['png'])),
}));
import { api } from '../apps/web/api';
import { renderPrimaryPng } from '../apps/web/diagrams/primary-api';
import { withPortablePreviews } from '../apps/web/diagrams/portable-previews';
import { createHash } from 'node:crypto';
afterEach(() => vi.clearAllMocks());
it('renders only a fetched fixed portable source and retries the same caller operation after actual preparation', async () => {
  const source = '{"type":"excalidraw","elements":[]}',
    sourceHash = createHash('sha256').update(source).digest('hex'),
    need = {
      previewId: 'fixed-id',
      sourceHash,
      type: 'whiteboard',
      title: 'Fixed',
      renderer: 'excalidraw@0.18.1+dooknow@1',
      config: {},
    };
  vi.mocked(api).mockImplementation(async (url) =>
    url.endsWith('/prepare') ? need : { ...need, source },
  );
  const operation = vi
    .fn()
    .mockRejectedValueOnce({
      data: { code: 'DIAGRAM_PREVIEW_REQUIRED', details: { portablePreviews: [need] } },
    })
    .mockResolvedValueOnce({ kind: 'archive' });
  expect(await withPortablePreviews(operation)).toEqual({ kind: 'archive' });
  expect(operation).toHaveBeenCalledTimes(2);
  expect(renderPrimaryPng).toHaveBeenCalledWith('whiteboard', {
    source,
    title: 'Fixed',
    markdown: '',
  });
  expect(api).toHaveBeenLastCalledWith('/api/portable-previews/fixed-id/prepare', 'POST', {
    sourceHash,
    pngBase64: btoa('png'),
    requestId: 'portable-preview-fixed-id',
  });
});
it('rejects a mismatched fetched source before rendering or retrying the caller', async () => {
  vi.mocked(api).mockResolvedValue({
    source: 'wrong',
    sourceHash: '0'.repeat(64),
    previewId: 'fixed-id',
  });
  const operation = vi.fn().mockRejectedValue({
    data: {
      code: 'DIAGRAM_PREVIEW_REQUIRED',
      details: { portablePreviews: [{ previewId: 'fixed-id' }] },
    },
  });
  await expect(withPortablePreviews(operation)).rejects.toThrow('摘要');
  expect(renderPrimaryPng).not.toHaveBeenCalled();
  expect(operation).toHaveBeenCalledTimes(1);
});
