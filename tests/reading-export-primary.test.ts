import { afterEach, expect, it } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { pluginRuntimeFixture } from './support/plugin-runtime';
import { primaryDiagramService } from '../packages/core/knowledge/primary-diagrams';
import { diagramCreationService } from '../packages/core/knowledge/diagram-creation';
import { diagramRendererVersions, renderPreparedDiagramDocument } from '../shared/diagram-primary';
import { emptyWhiteboard } from '../shared/whiteboard';
import { buildReadingHtml } from '../apps/web/reading-export';
const close: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const end of close.splice(0).reverse()) await end();
});
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=',
  'base64',
);
async function fixture(type: 'whiteboard' | 'mindmap' | 'flowchart' = 'whiteboard') {
  const f = await pluginRuntimeFixture();
  close.push(f.close);
  const runtime = f.platform.get(),
    service = primaryDiagramService(f.config, f.db, runtime.notes, runtime.assets, f.principal),
    intent = diagramCreationService(f.config, f.db, f.principal).reserve({
      path: '00-Inbox/reading.md',
      type,
      requestId: randomUUID(),
    }),
    source =
      type === 'whiteboard'
        ? JSON.stringify({
            ...emptyWhiteboard(),
            elements: [{ id: 'secret', type: 'text', text: 'PRIVATE_NATIVE_SECRET', opacity: 0 }],
          })
        : type === 'mindmap'
          ? '- PRIVATE_NATIVE_SECRET\n'
          : 'flowchart TD\n A[PRIVATE_NATIVE_SECRET] --> B\n';
  const prepared = service.prepare({
      target: { kind: 'creation', intentId: intent.id },
      type,
      title: '公开阅读标题',
      source,
      sourceHash: createHash('sha256').update(source).digest('hex'),
      renderer: diagramRendererVersions[type],
      config: {},
      pngBase64: png.toString('base64'),
      requestId: randomUUID(),
    }),
    markdown = renderPreparedDiagramDocument({
      prepared,
      title: prepared.title,
      source,
      description: '允许公开的说明。\n',
    });
  service.commit({ preparedId: prepared.id, markdown, requestId: randomUUID() });
  return {
    ...f,
    service,
    markdown,
    resource: service.resolve(intent.noteId),
    input: {
      title: prepared.title,
      markdown,
      resolveImage: async () => new Blob([png], { type: 'image/png' }),
    },
  };
}
it.each(['whiteboard', 'mindmap', 'flowchart'] as const)(
  'exports %s primary as only bound PNG and author prose, without native code/hidden summary',
  async (type) => {
    const f = await fixture(type),
      html = await buildReadingHtml({ ...f.input, diagramResource: f.resource } as any);
    expect(html).toContain('允许公开的说明');
    expect(html).toContain('data:image/png;base64,');
    expect(html).not.toContain('PRIVATE_NATIVE_SECRET');
    expect(html).not.toContain('dooknow:');
    expect(html).not.toContain('language-mermaid');
    expect(html).not.toContain('图形源文件');
  },
);
it('requires a current primary resource and rejects stale/changed preview bytes', async () => {
  const f = await fixture();
  await expect(buildReadingHtml(f.input)).rejects.toThrow('预览');
  await expect(
    buildReadingHtml({
      ...f.input,
      diagramResource: { ...f.resource, preview: { ...f.resource.preview, state: 'stale' } },
    } as any),
  ).rejects.toThrow('预览');
  await expect(
    buildReadingHtml({
      ...f.input,
      diagramResource: f.resource,
      resolveImage: async () => new Blob(['changed'], { type: 'image/png' }),
    } as any),
  ).rejects.toThrow('预览');
});
it('refuses malformed declared sources instead of exporting native fallback text', async () => {
  const f = await fixture('mindmap');
  await expect(
    buildReadingHtml({
      ...f.input,
      markdown: f.markdown.replace('<!-- dooknow:primary:end -->', ''),
      diagramResource: f.resource,
    } as any),
  ).rejects.toThrow('图形');
});
