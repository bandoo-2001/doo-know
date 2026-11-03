import { expect, it } from 'vitest';
import { boundDiagramSources } from '../shared/diagram-portability.js';

it('finds no native diagram groups promptly beside several MiB of ordinary images and prose', () => {
  const documents = [
    '# References\n\n![image](assets/example.png)\n\n' + '正文一行\n\n'.repeat(180000),
    '# Large\n\n![image](_doo-assets/example.png)\n\n' + 'unchanged line\n'.repeat(160000),
  ];
  const started = performance.now();
  for (const content of documents) expect(boundDiagramSources(content)).toEqual([]);
  // This scan repeats during every native-link revalidation of a move.
  expect(performance.now() - started).toBeLessThan(250);
});

it.each(['```', '~~~'])('retains bound native source discovery with %s fences', async (fence) => {
  const { serializeDiagramBinding } = await import('../shared/diagram-binding.js');
  const { renderPortableFigure } = await import('../shared/portable-figure.js');
  const hash = 'a'.repeat(64);
  const sourcePath = `assets/diagram-${hash}.excalidraw`;
  const previewPath = `assets/diagram-${hash}.png`;
  const binding = { kind: 'excalidraw' as const, sourceHash: hash, codeHash: 'b'.repeat(64) };
  const content = renderPortableFigure({
    alt: 'EXCALIDRAW 预览', previewPath,
    source: { type: 'file', path: sourcePath },
  }) + '\n' + serializeDiagramBinding(binding) + '\n\n' + fence + 'excalidraw\n' + sourcePath + '\n' + fence + '\n';
  const groups = boundDiagramSources(content);
  expect(groups).toHaveLength(1);
  expect(groups[0]).toMatchObject({
    kind: 'excalidraw', sourcePath, previewPath, binding,
    code: sourcePath + '\n',
  });
});
