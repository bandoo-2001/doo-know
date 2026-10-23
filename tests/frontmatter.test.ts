import { expect, it } from 'vitest';
import { readDocumentProperties, updateDocumentProperties } from '../shared/frontmatter';
import { parseSource } from '../apps/web/editor/source-codec';
import { createRichProjection } from '../apps/web/editor/rich-adapter';
import { buildReadingHtml } from '../apps/web/reading-export';

it.each(['--- \n', '---\t\r\n', '\uFEFF--- \r\n'])('protects the same YAML delimiters in forms, document editing and export: %j', async opening => {
  const eol = opening.endsWith('\r\n') ? '\r\n' : '\n';
  const metadata = `${opening}title: old${eol}custom: keep${eol}--- \t${eol}`;
  const raw = `${metadata}${eol}Body${eol}`;
  expect(readDocumentProperties(raw).present).toBe(true);
  expect(parseSource(raw).units[0]).toMatchObject({kind: 'frontmatter', opaque: true});
  const projection = createRichProjection(raw);
  expect(projection.json.content?.[0]?.type).toBe('opaqueSource');
  const changed = structuredClone(projection.json);
  const body = changed.content?.find(node => node.type === 'paragraph');
  expect(body?.content?.[0]?.text).toBe('Body');
  body!.content![0].text = 'Changed';
  expect(projection.serialize(changed)).toEqual({ok: true, markdown: `${metadata}${eol}Changed${eol}`});
  const html = await buildReadingHtml({title: 'metadata', markdown: raw});
  expect(html).toContain('reading-properties');
  expect(html).not.toContain('<hr>');
  expect(html).not.toContain('<h2>title:');
});

it('changes one property without rewriting comments, unknown values, CRLF or the body', () => {
  const source = '\uFEFF---\r\n# 属性说明\r\ntitle: "旧标题" # 保留行注释\r\ncustom: { a: 1, b: [two, three] }\r\ntags: [旧, 保留]\r\n---\r\n\r\n# 正文\r\n\r\n```yaml\r\nx: 1\r\n```\r\n';
  expect(readDocumentProperties(source)).toMatchObject({ present: true, properties: [
    { key: 'title', value: '旧标题', editable: true },
    { key: 'custom', editable: false },
    { key: 'tags', value: ['旧', '保留'], editable: true },
  ] });
  const result = updateDocumentProperties(source, { title: '新标题: "引用"' });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.markdown).toBe(source.replace('"旧标题"', '"新标题: \\"引用\\""'));
  expect(readDocumentProperties(result.markdown).properties[0].value).toBe('新标题: "引用"');
});

it('adds properties and preserves the exact existing body and closing delimiter', () => {
  const source = '---\ntitle: 原标题\n...\n\n正文\n';
  const changed = updateDocumentProperties(source, { tags: ['项目', 'a:b'], published: false });
  expect(changed.ok).toBe(true);
  if (!changed.ok) return;
  expect(changed.markdown).toContain('title: 原标题\n');
  expect(changed.markdown.endsWith('...\n\n正文\n')).toBe(true);
  expect(readDocumentProperties(changed.markdown).properties).toEqual([
    { key: 'title', value: '原标题', editable: true },
    { key: 'tags', value: ['项目', 'a:b'], editable: true },
    { key: 'published', value: false, editable: true },
  ]);
});

it('creates standard YAML before a note while preserving a BOM and CRLF', () => {
  const result = updateDocumentProperties('\uFEFF# 标题\r\n正文\r\n', { title: '标题', count: 3 });
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.markdown.startsWith('\uFEFF---\r\n')).toBe(true);
    expect(result.markdown.endsWith('---\r\n\r\n# 标题\r\n正文\r\n')).toBe(true);
    expect(result.markdown.replace(/\r\n/g, '')).not.toContain('\n');
  }
});

it('keeps a no-op byte exact and refuses malformed or nonmapping YAML', () => {
  const source = '---\ntitle: \'same\' # comment\nunknown: &value {x: y}\ncopy: *value\n---\nbody';
  expect(updateDocumentProperties(source, { title: 'same' })).toEqual({ ok: true, markdown: source });
  for (const markdown of ['---\ntitle: [broken\n---\nbody', '---\n- one\n- two\n---\nbody', '---\ntitle: unterminated']) {
    expect(updateDocumentProperties(markdown, { title: 'new' }).ok).toBe(false);
  }
});

it('refuses to overwrite structured values, anchors or aliases through a simple field', () => {
  for (const source of ['---\ncustom: {x: y}\n---\nbody', '---\nname: &original old\ncopy: *original\n---\nbody']) {
    const key = source.includes('custom') ? 'custom' : 'name';
    expect(updateDocumentProperties(source, { [key]: 'replacement' }).ok).toBe(false);
  }
});

it('changes a block list without consuming the next property or its comments', () => {
  const source = '---\ntags:\n  - old\n  - keep\n# 次项说明\nstatus: draft # 保留\n---\nbody\n';
  const result = updateDocumentProperties(source, { tags: ['new', 'two'] });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.markdown).toContain('# 次项说明\nstatus: draft # 保留\n');
  expect(readDocumentProperties(result.markdown).properties[0].value).toEqual(['new', 'two']);
});
