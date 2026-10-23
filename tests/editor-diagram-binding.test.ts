import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createRichProjection } from '../apps/web/editor/rich-adapter';
import { serializeDiagramBinding } from '../shared/diagram-binding';
import { buildReadingHtml } from '../apps/web/reading-export';

const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><path d="M0 0H1V1Z"/></svg>';
const codeHash = createHash('sha256').update(svg).digest('hex');
const sourceHash = 'a'.repeat(64);
const marker = serializeDiagramBinding({ kind: 'svg', codeHash, sourceHash });
const raw = `![SVG 预览](assets/diagram-${'b'.repeat(64)}.png)\n\n[图形源文件](assets/diagram-${'c'.repeat(64)}.svg)\n\n${marker}\n\n\`\`\`svg\n${svg}\n\`\`\`\n\nBody\n`;

it('keeps binding metadata hidden from document controls while preserving exact source', () => {
  const projection = createRichProjection(raw);
  const internal = projection.json.content?.find((node) => node.type === 'opaqueSource');
  expect(internal?.attrs?.internal).toBe(true);
  const diagram = projection.json.content?.find((node) => node.type === 'codeBlock');
  expect(diagram?.attrs).toMatchObject({
    previewCodeHash: codeHash,
    previewSourceHash: sourceHash,
  });
  expect(projection.serialize(projection.json)).toEqual({ ok: true, markdown: raw });
  const changed = structuredClone(projection.json);
  changed.content!.at(-1)!.content![0].text = 'Changed';
  expect(projection.serialize(changed)).toEqual({
    ok: true,
    markdown: raw.replace('Body', 'Changed'),
  });
});

it('does not expose a preview binding as prose in an independent reading document', async () => {
  const html = await buildReadingHtml({
    title: 'bound',
    markdown: raw,
    resolveImage: async () =>
      new Blob([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], { type: 'image/png' }),
  });
  expect(html).not.toContain('dooknow:diagram-preview');
  expect(html).toContain('data:image/png;base64,');
  expect(html).toContain('language-svg');
});
it('omits an obsolete automatic PNG from reading export and explains why current source is shown', async () => {
  const stale = raw.replace('M0 0H1V1Z', 'M0 0H2V2Z');
  let images = 0;
  const html = await buildReadingHtml({
    title: 'updated',
    markdown: stale,
    resolveImage: async () => {
      images++;
      return new Blob([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], { type: 'image/png' });
    },
  });
  expect(images).toBe(0);
  expect(html).not.toContain('data:image/png');
  expect(html).toContain('预览已过期');
  expect(html).toContain('M0 0H2V2Z');
});
