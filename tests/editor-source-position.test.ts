import { getSchema } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { expect, it } from 'vitest';
import { createRichProjection, richExtensions } from '../apps/web/editor/rich-adapter';
import { sourceOffsetPosition } from '../apps/web/editor/source-position';

const schema = getSchema(richExtensions());
function fixture(markdown: string) {
  const projection = createRichProjection(markdown);
  expect(projection.eligibility.allowed).toBe(true);
  return { projection, doc: schema.nodeFromJSON(projection.json), markdown };
}
function textPosition(doc: ProseMirrorNode, needle: string, occurrence = 0) {
  const positions: number[] = [];
  doc.descendants((node, position) => {
    if (!node.isTextblock) return;
    const text = node.textBetween(0, node.content.size, '\n', '\uFFFC');
    let cursor = 0;
    while ((cursor = text.indexOf(needle, cursor)) >= 0) {
      positions.push(position + 1 + cursor);
      cursor += needle.length;
    }
    return false;
  });
  if (positions[occurrence] === undefined) throw Error('Missing fixture text: ' + needle);
  return positions[occurrence];
}

it('maps formatted source offsets without counting marks or hidden link destinations', () => {
  const { doc, projection, markdown } = fixture(
    '# Start\n\n**bold** [link](https://example.test/hidden) and `code` target.\n',
  );
  for (const text of ['bold', 'link', 'code', 'target']) {
    expect(
      sourceOffsetPosition(doc, markdown, markdown.indexOf(text, 9), projection.sourceRange),
    ).toBe(textPosition(doc, text));
  }
});

it('distinguishes repeated text in different nested list items', () => {
  const { doc, projection, markdown } = fixture(
    '- First\n  - repeated **target**\n  - repeated **target**\n- Last\n',
  );
  const first = markdown.indexOf('target');
  expect(sourceOffsetPosition(doc, markdown, first, projection.sourceRange)).toBe(
    textPosition(doc, 'target', 0),
  );
  expect(
    sourceOffsetPosition(
      doc,
      markdown,
      markdown.indexOf('target', first + 1),
      projection.sourceRange,
    ),
  ).toBe(textPosition(doc, 'target', 1));
});

it('maps a table row start and its later cell to the correct repeated row', () => {
  const { doc, projection, markdown } = fixture(
    '| Item | Value |\n| --- | --- |\n| repeated | **target** |\n| repeated | **target** |\n',
  );
  const row = markdown.lastIndexOf('| repeated');
  expect(sourceOffsetPosition(doc, markdown, row, projection.sourceRange)).toBe(
    textPosition(doc, 'repeated', 1),
  );
  expect(
    sourceOffsetPosition(doc, markdown, markdown.lastIndexOf('target'), projection.sourceRange),
  ).toBe(textPosition(doc, 'target', 1));
});

it('reaches an exact distant code line after fences and repeated code lines', () => {
  const { doc, projection, markdown } = fixture(
    '# Code\n\n```text\n' + 'background\n'.repeat(120) + 'target\nbackground\ntarget\n```\n',
  );
  expect(
    sourceOffsetPosition(doc, markdown, markdown.lastIndexOf('target'), projection.sourceRange),
  ).toBe(textPosition(doc, 'target', 1));
});

it('treats entities and escapes inside code as literal source characters', () => {
  const { doc, projection, markdown } = fixture(
    'Inline `&amp; \\*literal\\* target` text.\n\n```text\n&amp; \\*literal\\* target\n```\n',
  );
  for (let occurrence = 0; occurrence < 2; occurrence++) {
    const from = occurrence ? markdown.lastIndexOf('target') : markdown.indexOf('target');
    expect(sourceOffsetPosition(doc, markdown, from, projection.sourceRange)).toBe(
      textPosition(doc, 'target', occurrence),
    );
  }
});

it('retains source indentation inside a nested code block', () => {
  const { doc, projection, markdown } = fixture('- Item\n\n  ```text\n    target\n  ```\n');
  expect(
    sourceOffsetPosition(doc, markdown, markdown.indexOf('target'), projection.sourceRange),
  ).toBe(textPosition(doc, 'target'));
});

it('keeps line positions inside a long marked paragraph', () => {
  const { doc, projection, markdown } = fixture(
    '# Paragraph\n\n' + '**repeated** background\n'.repeat(80) + '**target** final line\n',
  );
  const lineStart = markdown.lastIndexOf('**target');
  expect(sourceOffsetPosition(doc, markdown, lineStart, projection.sourceRange)).toBe(
    textPosition(doc, 'target'),
  );
});

it('maps a large editable paragraph without overflowing argument limits', () => {
  const { doc, projection, markdown } = fixture('background '.repeat(13000) + '**target**\n');
  expect(
    sourceOffsetPosition(doc, markdown, markdown.indexOf('target'), projection.sourceRange),
  ).toBe(textPosition(doc, 'target'));
});

it('keeps UTF-16 positions through CRLF, entities and escaped punctuation', () => {
  const { doc, projection, markdown } = fixture(
    '# 标题\r\n\r\nA😀 &amp; **目标** and \\*literal\\*.\r\n',
  );
  for (const text of ['目标', 'literal']) {
    expect(
      sourceOffsetPosition(doc, markdown, markdown.indexOf(text), projection.sourceRange),
    ).toBe(textPosition(doc, text));
  }
});

it('returns an atomic source block boundary for hidden frontmatter', () => {
  const { doc, projection, markdown } = fixture('---\ntitle: private\n---\n\n# Visible\n');
  expect(
    sourceOffsetPosition(doc, markdown, markdown.indexOf('private'), projection.sourceRange),
  ).toBe(0);
  expect(
    sourceOffsetPosition(doc, markdown, markdown.indexOf('Visible'), projection.sourceRange),
  ).toBe(textPosition(doc, 'Visible'));
});

it('uses current source identities after a new block moves existing source units', () => {
  const { doc, projection } = fixture('# Original\n\n**target** body\n');
  const next = schema.node('doc', null, [
    schema.node('paragraph', null, schema.text('Inserted')),
    ...Array.from({ length: doc.childCount }, (_, index) => doc.child(index)),
  ]);
  const serialized = projection.serialize(next.toJSON());
  expect(serialized.ok).toBe(true);
  if (!serialized.ok) return;
  expect(
    sourceOffsetPosition(
      next,
      serialized.markdown,
      serialized.markdown.indexOf('target'),
      projection.sourceRange,
    ),
  ).toBe(textPosition(next, 'target'));
  expect(sourceOffsetPosition(next, serialized.markdown, 0, projection.sourceRange)).toBe(
    textPosition(next, 'Inserted'),
  );
});

it('maps source offsets without a projection lookup and clamps EOF to the final textblock', () => {
  const { doc, markdown } = fixture('# First\n\n**target** body\n');
  expect(sourceOffsetPosition(doc, markdown, markdown.indexOf('target'))).toBe(
    textPosition(doc, 'target'),
  );
  expect(sourceOffsetPosition(doc, markdown, markdown.length + 100)).toBe(doc.content.size - 1);
});
