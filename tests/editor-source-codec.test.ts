import { describe, it, expect } from 'vitest';
import cases from './fixtures/editor-compatibility/cases.json';
import {
  parseSource,
  serializeEdits,
  validateUnitOperation,
} from '../apps/web/editor/source-codec';
describe('Markdown 原文保全', () => {
  for (const c of cases)
    it(`${c.name}: 打开和无编辑往返逐字符不变`, () => {
      const doc = parseSource(c.markdown);
      expect(doc.markdown).toBe(c.markdown);
      expect(doc.units.map((u) => u.raw).join('')).toBe(c.markdown);
      expect(serializeEdits(doc, [])).toMatchObject({
        ok: true,
        markdown: c.markdown,
        revision: 0,
      });
      if (c.classification === 'source-only') expect(doc.eligibility.allowed).toBe(false);
      else if (c.classification === 'opaque') expect(doc.units.some((u) => u.opaque)).toBe(true);
    });
  it('局部修改不改写 CRLF、围栏、表格、注释与尾部空白', () => {
    const md =
      '# 标题\r\n\r\n需要修改\r\n\r\n~~~~js\r\nlet x = 1;\r\n~~~~\r\n\r\n<!-- 原始注释 -->\r\n\r\n| A | B |\r\n| --- | --- |\r\n| C | D |\r\n  ';
    const from = md.indexOf('需要修改');
    expect(
      serializeEdits(parseSource(md), [{ from, to: from + 4, insert: '新的正文😀' }]),
    ).toMatchObject({ ok: true, markdown: md.replace('需要修改', '新的正文😀'), revision: 1 });
  });
  it('拒绝越界、重叠和把 emoji 代理对截开的补丁', () => {
    const base = parseSource('😀abc');
    for (const edits of [
      [{ from: 1, to: 1, insert: 'x' }],
      [{ from: -1, to: 0, insert: '' }],
      [
        { from: 2, to: 4, insert: 'a' },
        { from: 3, to: 4, insert: 'b' },
      ],
    ])
      expect(serializeEdits(base, edits).ok).toBe(false);
  });
  it('普通编辑不能隐式删除原文保留块', () => {
    const md = '普通正文\n\n<!-- 保留 -->\n\n另一段\n';
    const doc = parseSource(md);
    expect(
      validateUnitOperation(doc, [{ from: 0, to: md.length, insert: '删掉所有' }], 'edit').ok,
    ).toBe(false);
    expect(
      validateUnitOperation(doc, [{ from: 0, to: md.length, insert: '删掉所有' }], 'deleteOpaque')
        .ok,
    ).toBe(true);
  });
  it('整篇分析引用定义，引用块或列表内定义也必须保留链接关系', () => {
    for (const definition of ['> [foo]: https://example.invalid', '- [foo]: https://example.invalid', '> - [foo]: https://example.invalid']) {
      const markdown = `[foo]\n\n${definition}\n`;
      const doc = parseSource(markdown);
      expect(doc.eligibility, definition).toMatchObject({ allowed: false, reason: 'syntax' });
      expect(serializeEdits(doc, [])).toMatchObject({ ok: true, markdown });
    }
    expect(parseSource('```md\n[foo]: https://example.invalid\n```\n').eligibility.allowed).toBe(true);
  });
});
