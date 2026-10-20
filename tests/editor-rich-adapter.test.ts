import { it, expect } from 'vitest';
import cases from './fixtures/editor-compatibility/cases.json';
import { createRichProjection } from '../apps/web/editor/rich-adapter';
for (const c of cases)
  it(`${c.name}: 文档投影无编辑时保留原始字节序列`, () => {
    const p = createRichProjection(c.markdown);
    if (!p.eligibility.allowed) {
      expect(p.original).toBe(c.markdown);
      return;
    }
    expect(p.serialize(p.json)).toMatchObject({ ok: true, markdown: c.markdown });
  });
it('只编辑正文时保留周围原文及不支持的内容', () => {
  const md = '# 原始\r\n\r\n修改这里\r\n\r\n<!-- 注释原样 -->\r\n\r\n* 保留符号\r\n';
  const p = createRichProjection(md);
  const json = structuredClone(p.json);
  json.content![1].content![0].text = '新正文';
  const r = p.serialize(json);
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.markdown.startsWith('# 原始\r\n\r\n新正文')).toBe(true);
    expect(r.markdown).toContain('<!-- 注释原样 -->\r\n\r\n* 保留符号\r\n');
  }
});
it('保留块不能被普通删除或伪造 ID 隐式替换', () => {
  const p = createRichProjection('正文\n\n<!-- keep -->\n');
  const json = structuredClone(p.json);
  json.content!.pop();
  expect(p.serialize(json).ok).toBe(false);
});
it('危险链接不能从编辑器模型写入 Markdown', () => {
  const p = createRichProjection('正文');
  const json = structuredClone(p.json);
  json.content![0].content![0].marks = [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }];
  expect(p.serialize(json).ok).toBe(false);
});
it('新增空段落和换行是可保存的编辑，不阻止回车继续输入', () => {
  const p = createRichProjection('已有正文');
  const json = structuredClone(p.json);
  json.content!.push({ type: 'paragraph' });
  const result = p.serialize(json);
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.markdown).toContain('已有正文\n');
});
it('修改表格单元格和颜色时保持可表示的 Markdown 语义', () => {
  for (const source of [
    '| A | B |\n| :--- | ---: |\n| X | Y |\n',
    '普通 <span style="color:#AABBCC">彩色</span> 文字\n',
  ]) {
    const p = createRichProjection(source),
      json = structuredClone(p.json);
    function edit(n: any): boolean {
      if (n.type === 'text') {
        n.text += '新';
        return true;
      }
      for (const c of n.content || []) if (edit(c)) return true;
      return false;
    }
    edit(json);
    expect(p.serialize(json).ok).toBe(true);
  }
});
it('不懂 Markdown 的用户可直接输入保留符号、网址和换行', () => {
  for (const text of [
    '**不是粗体**',
    '# 不是标题',
    'a < b && c > d',
    'https://example.invalid/path',
    '[文字](不是链接)',
    'a | b',
    '正文\n下一行',
  ]) {
    const p = createRichProjection('原文');
    const json = structuredClone(p.json);
    json.content![0].content = [{ type: 'text', text }];
    expect(p.serialize(json).ok, text).toBe(true);
  }
});
it('明确确认删除保留块只删除指定内容，后续编辑仍可继续', () => {
  const p = createRichProjection('正文\n\n<!-- 保留块 -->\n\n尾段\n');
  const j = structuredClone(p.json),
    id = j.content![1].attrs!.sourceId;
  j.content!.splice(1, 1);
  expect(p.serialize(j, { deleteOpaqueId: id }).ok).toBe(true);
  p.confirmOpaqueDeletion(id);
  expect(p.serialize(j).ok).toBe(true);
});
it('段落末尾 Shift+Enter 的换行能保存且重建后保留', () => {
  const p = createRichProjection('正文');
  const j = structuredClone(p.json);
  j.content![0].content!.push({ type: 'hardBreak' });
  const result = p.serialize(j);
  expect(result.ok).toBe(true);
  if (result.ok) {
    const p2 = createRichProjection(result.markdown);
    expect(p2.json.content![0].content?.at(-1)?.type).toBe('hardBreak');
    expect(p2.serialize(p2.json)).toMatchObject({ ok: true, markdown: result.markdown });
  }
});
it('代码块内部包含 Markdown 围栏时仍可编辑而不截断内容', () => {
  const p = createRichProjection('````md\n# 示例\n```js\nx()\n```\n````\n');
  const j = structuredClone(p.json);
  j.content![0].content![0].text += '\n新增';
  expect(p.serialize(j).ok).toBe(true);
});
it('代码围栏的未知元信息保留为原文，不能在编辑中丢弃', () => {
  const p = createRichProjection('```ts title="原文件.ts"\nconst x=1;\n```\n');
  expect(p.json.content![0].type).toBe('opaqueSource');
});
it('多段粘贴逐个解析样式单元，保留居中和文字颜色', async () => {
  const { parseRichContent } = await import('../apps/web/editor/rich-adapter');
  const nodes = parseRichContent(
    '## 标题\n\n<div style="text-align:center">\n\n<span style="color:#aabbcc">彩色</span>\n\n</div>',
  );
  expect(nodes[1].attrs?.textAlign).toBe('center');
  expect(nodes[1].content?.[0].marks?.[0].attrs?.color).toBe('#aabbcc');
});
it('未支持的维基链接、提示块和标题属性保留原文', () => {
  for (const source of ['[[维基链接]]\n', '> [!NOTE]\n> 保留提示\n', '# 标题 {#custom-id}\n']) {
    const p = createRichProjection(source);
    expect(
      p.json.content!.some((n) => n.type === 'opaqueSource'),
      source,
    ).toBe(true);
    expect(p.serialize(p.json)).toMatchObject({ ok: true, markdown: source });
  }
});
it('解析器对可见内容有不同解释时不冒险编辑，例如格式化的图片替代文字', () => {
  const p = createRichProjection('![*替代文字*](assets/image.png)\n');
  expect(p.json.content![0].type).toBe('opaqueSource');
});
it('段首和空段的软换行不会被保全检查误拒绝或在重建时消失', () => {
  for (const original of ['正文', '']) {
    const p = createRichProjection(original),
      j = structuredClone(p.json);
    j.content![0].content ||= [];
    j.content![0].content.unshift({ type: 'hardBreak' });
    const r = p.serialize(j);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const p2 = createRichProjection(r.markdown);
      expect(p2.json.content![0].content?.[0].type).toBe('hardBreak');
    }
  }
});
it('初始投影必须符合编辑器内容模型，不能依靠加载修复而丢弃内嵌节点', async () => {
  const { getSchema } = await import('@tiptap/core');
  const { richExtensions } = await import('../apps/web/editor/rich-adapter');
  const md = '正文 ![内嵌图片](assets/x.png) 后文';
  const p = createRichProjection(md);
  expect(() => getSchema(richExtensions()).nodeFromJSON(p.json).check()).not.toThrow();
  expect(p.serialize(p.json)).toMatchObject({ ok: true, markdown: md });
});
it('前文修改后保留块的源码范围跟随当前正文，撤回原文后恢复初始范围', () => {
  const markdown = '开头\n\n<!-- 保留原文 -->\n\n结尾\n';
  const p = createRichProjection(markdown);
  const j = structuredClone(p.json), id = j.content![1].attrs!.sourceId;
  j.content![0].content![0].text = '开头增加许多文字';
  const result = p.serialize(j);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(p.sourceRange(id)?.from).toBe(result.markdown.indexOf('<!-- 保留原文 -->'));
    const range = p.sourceRange(id)!;
    expect(result.markdown.slice(range.from, range.to)).toBe(range.raw);
  }
  expect(p.serialize(p.json)).toMatchObject({ ok: true, markdown });
  expect(p.sourceRange(id)?.from).toBe(markdown.indexOf('<!-- 保留原文 -->'));
});
