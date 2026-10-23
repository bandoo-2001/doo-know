import { expect, it } from 'vitest';
import { createRichProjection } from '../apps/web/editor/rich-adapter';
import { parseSource } from '../apps/web/editor/source-codec';

it.each(['Use `$HOME` and `$PATH` variables.\n', 'Write `[[page]]` literally.\n', 'Escaped \\$x\\$ and \\[[page]] stay literal.\n'])('keeps ordinary code examples and escaped notation editable: %s', source => {
  expect(parseSource(source).units.some(unit => unit.opaque)).toBe(false);
  const projection = createRichProjection(source);
  expect(projection.json.content?.[0]?.type).toBe('paragraph');
  expect(projection.serialize(projection.json)).toEqual({ok: true, markdown: source});
});

it('shows formulas, callouts and wikilinks while retaining their exact original source', () => {
  const source = '普通正文\r\n\r\n公式 $x^2$\r\n\r\n> [!NOTE]\r\n> 提示内容\r\n\r\n[[资料/笔记|说明]]\r\n';
  const projection = createRichProjection(source);
  const preserved = projection.json.content!.filter(n => n.type === 'opaqueSource');
  expect(preserved).toHaveLength(3);
  expect(preserved[0].attrs?.previewHtml).toContain('data-math-source=');
  expect(preserved[1].attrs?.previewHtml).toContain('markdown-alert-note');
  expect(preserved[2].attrs?.previewHtml).toContain('href="%E8%B5%84%E6%96%99/%E7%AC%94%E8%AE%B0.md"');
  expect(projection.serialize(projection.json)).toEqual({ ok: true, markdown: source });
  const changed = structuredClone(projection.json);
  changed.content![0].content![0].text = '已修改正文';
  const result = projection.serialize(changed);
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.markdown).toBe(source.replace('普通正文', '已修改正文'));
});

it('resolves references against full-note footnote definitions without interpreting fenced fake definitions', () => {
  const source = '引用[^detail]\n\n```md\n[^fake]: 不能用\n```\n\n[^detail]: 完整解释\n\n    第二段解释。\n\n末尾正文\n';
  const projection = createRichProjection(source);
  const reference = projection.json.content!.find(n => n.attrs?.previewHtml?.includes('footnote-ref'));
  expect(reference?.attrs?.previewHtml).toContain('完整解释');
  expect(reference?.attrs?.previewHtml).toContain('第二段解释');
  expect(reference?.attrs?.previewHtml).not.toContain('不能用');
  expect(projection.serialize(projection.json)).toEqual({ ok: true, markdown: source });
});

it('keeps user HTML inert in enhanced previews and unknown preserved blocks opaque', () => {
  const projection = createRichProjection('公式 $x$ <img src=x onerror=alert(1)>\n\n<!-- private -->\n');
  expect(projection.json.content![0].attrs?.previewHtml).not.toContain('<img');
  expect(projection.json.content![0].attrs?.previewHtml).toContain('&lt;img');
  expect(projection.json.content![1].attrs?.previewHtml).toBeFalsy();
});
