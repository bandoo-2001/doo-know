import { expect, it } from 'vitest';
import {
  hashDiagramBytes,
  diagramRenderFingerprint,
  parsePrimaryBinding,
  serializePrimaryBinding,
} from '../shared/diagram-document-binding';

it('hashes exact UTF-8 bytes without newline normalization', async () => {
  expect(await hashDiagramBytes('abc')).toBe(
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  expect(await hashDiagramBytes('中文\r\n')).not.toBe(await hashDiagramBytes('中文\n'));
  expect(await hashDiagramBytes(new TextEncoder().encode('中文'))).toBe(
    await hashDiagramBytes('中文'),
  );
});

it('binds every rendering input, with canonical object ordering and no derived output fields', async () => {
  const input = {
    type: 'flowchart' as const,
    sourceHash: 'a'.repeat(64),
    title: '根标题',
    renderer: 'mermaid@12.2.0',
    config: { theme: 'light', layout: { direction: 'down', padding: 4 } },
  };
  const hash = await diagramRenderFingerprint(input);
  expect(hash).toMatch(/^[a-f0-9]{64}$/);
  expect(
    await diagramRenderFingerprint({
      ...input,
      config: { layout: { padding: 4, direction: 'down' }, theme: 'light' },
    }),
  ).toBe(hash);
  for (const changed of [
    { title: '别的标题' },
    { sourceHash: 'b'.repeat(64) },
    { renderer: 'mermaid@13' },
    { type: 'mindmap' as const },
    { config: { theme: 'dark' } },
  ])
    expect(await diagramRenderFingerprint({ ...input, ...changed })).not.toBe(hash);
  expect(
    await diagramRenderFingerprint({
      ...input,
      previewPath: '_doo-assets/new.png',
      previewHash: 'f'.repeat(64),
    } as typeof input),
  ).toBe(hash);
});

it('preserves unknown binding fields but rejects unsupported or malformed versions', () => {
  const value = {
    version: 1 as const,
    sourceHash: 'a'.repeat(64),
    renderHash: 'b'.repeat(64),
    previewHash: 'c'.repeat(64),
    future: { retained: true },
  };
  const marker = serializePrimaryBinding(value);
  expect(parsePrimaryBinding(marker)).toEqual(value);
  expect(parsePrimaryBinding(marker.replace('"version":1', '"version":2'))).toBeUndefined();
  expect(parsePrimaryBinding(marker.replace('a'.repeat(64), 'bad'))).toBeUndefined();
  expect(parsePrimaryBinding('```\n' + marker + '\n```')).toBeUndefined();
});

it('cannot close an HTML comment through unknown JSON fields', () => {
  const marker = serializePrimaryBinding({
    version: 1,
    sourceHash: 'a'.repeat(64),
    renderHash: 'b'.repeat(64),
    previewHash: 'c'.repeat(64),
    custom: '-->\n<script>bad</script>',
  });
  expect(marker.match(/-->/g)).toHaveLength(1);
  expect(parsePrimaryBinding(marker)?.custom).toBe('-->\n<script>bad</script>');
});
