import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { sha256Hex } from '../shared/sha256.js';
import { hashDiagramBytes } from '../shared/diagram-document-binding.js';
import { hashDiagramCode } from '../shared/diagram-portability.js';
import { hashDiagramSource } from '../apps/web/diagrams/preview-artifact.js';
import { prepareDiagramUpload } from '../apps/web/diagrams/persist-preview.js';

const nativeCrypto = globalThis.crypto;
const oracle = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
afterEach(() => vi.unstubAllGlobals());
const vectors: (string | Uint8Array)[] = [
  '',
  'abc',
  '中文与 emoji 😀\r\n',
  ...[55, 56, 63, 64, 65].map((n) => 'a'.repeat(n)),
  'a'.repeat(1_000_000),
  new Uint8Array([0, 255, 128, 1, 64]),
];
for (const mode of ['native', 'HTTP without subtle', 'without global crypto'] as const) {
  it(`matches standard SHA-256 across padding boundaries, UTF-8 and binary bytes: ${mode}`, async () => {
    if (mode === 'HTTP without subtle')
      vi.stubGlobal('crypto', { getRandomValues: nativeCrypto.getRandomValues.bind(nativeCrypto) });
    if (mode === 'without global crypto') vi.stubGlobal('crypto', undefined);
    for (const value of vectors) expect(await sha256Hex(value)).toBe(oracle(value));
  });
  it(`snapshots a sliced byte view before asynchronous work: ${mode}`, async () => {
    if (mode === 'HTTP without subtle') vi.stubGlobal('crypto', { subtle: undefined });
    if (mode === 'without global crypto') vi.stubGlobal('crypto', undefined);
    const whole = new Uint8Array([9, 0, 255, 128, 7]);
    const view = whole.subarray(1, 4);
    const expected = oracle(view),
      pending = sha256Hex(view);
    whole.fill(0);
    expect(await pending).toBe(expected);
  });
}
it('uses native Web Crypto when available and does not mask native errors', async () => {
  const digest = vi.fn(async (_algorithm: string, bytes: Uint8Array) =>
    nativeCrypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>),
  );
  vi.stubGlobal('crypto', { subtle: { digest } });
  expect(await sha256Hex('abc')).toBe(oracle('abc'));
  expect(digest).toHaveBeenCalledOnce();
  const failure = new Error('native digest failed');
  digest.mockRejectedValueOnce(failure);
  await expect(sha256Hex('abc')).rejects.toBe(failure);
});
it('keeps binding, code normalization, preview and upload retry identities identical on HTTP', async () => {
  const input = {
    noteId: 'diagram-http',
    kind: 'svg' as const,
    source: '<svg/>\r\n',
    png: new Blob([new Uint8Array([0, 255, 128, 1])], { type: 'image/png' }),
  };
  const expected = await prepareDiagramUpload(input);
  vi.stubGlobal('crypto', { subtle: undefined });
  expect(await hashDiagramBytes(input.source)).toBe(oracle(input.source));
  expect(await hashDiagramCode(input.source)).toBe(oracle('<svg/>'));
  expect(await hashDiagramSource(input.source)).toBe(oracle(input.source));
  expect(await prepareDiagramUpload(input)).toEqual(expected);
});
