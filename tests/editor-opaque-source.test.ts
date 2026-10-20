import { it, expect } from 'vitest';
import { parseSource, validateUnitOperation } from '../apps/web/editor/source-codec';
it('修改相邻正文时保留 Frontmatter、未知块和注释', () => {
  const md = '---\ntitle: 原始\n---\n\n正文\n\n:::custom\n特殊\n\n内容\n:::\n\n<!-- 注释 -->\n';
  const d = parseSource(md);
  const from = md.indexOf('正文');
  expect(
    validateUnitOperation(d, [{ from, to: from + 2, insert: '新正文' }], 'edit'),
  ).toMatchObject({ ok: true, markdown: md.replace('正文', '新正文') });
  expect(d.units.filter((u) => u.opaque)).toHaveLength(3);
});
it('孤立的样式闭合标签和不完整样式容器必须保留，不能被 HTML 解析吞掉', () => {
  for (const raw of [
    '前文 </span> 后文\n',
    '<div style="text-align:center">\n\n没有结束标记\n',
    '<span style="color:#AABBCC">未闭合',
  ])
    expect(
      parseSource(raw).units.some((u) => u.opaque),
      raw,
    ).toBe(true);
});
