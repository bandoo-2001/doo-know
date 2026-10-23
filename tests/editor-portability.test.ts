import { it, expect } from 'vitest';
import { Parser, HtmlRenderer } from 'commonmark';
import MarkdownIt from 'markdown-it';
import { renderPortableFigure } from '../shared/portable-figure';

it('keeps a diagram and its source readable without application routes or scripts', () => {
  const source = renderPortableFigure({
    alt: '系统 [结构]', previewPath: './assets/系统 #1.png',
    source: { type: 'file', path: './assets/系统 #1.excalidraw' },
  });
  const html = new HtmlRenderer().render(new Parser().parse(source));
  expect(html).toContain('<img');
  expect(html).toContain('.png');
  expect(html).toContain('.excalidraw');
  expect(html).toContain('%23');
  expect(html).not.toContain('/api/');
  expect(html).not.toContain('<script');
});

it('preserves diagram source containing fences and XML as ordinary Markdown', () => {
  const code = '<svg xmlns="http://www.w3.org/2000/svg"><text>``` &amp; 中文</text></svg>';
  const source = renderPortableFigure({ alt: '图', previewPath: '../assets/view.png',
    source: { type: 'fence', language: 'svg', code } });
  const tree = new Parser().parse(source);
  const blocks: string[] = [];
  const walker = tree.walker(); let event;
  while ((event = walker.next())) if (event.entering && event.node.type === 'code_block') blocks.push(event.node.literal!);
  expect(blocks).toEqual([code + '\n']);
  expect(new HtmlRenderer().render(tree)).not.toContain('<svg');
});

it.each(['/api/assets/abc', 'https://host/image.png', '//host/a.png', 'data:image/png,x', 'a\\b.png', ''])
('rejects a nonportable preview path: %s', previewPath => {
  expect(() => renderPortableFigure({ alt: '图', previewPath,
    source: { type: 'file', path: 'source.svg' } })).toThrow();
});

it('defines CommonMark content separately from GFM table and task extensions', () => {
  const text = '# 标题\n\n- [x] 完成\n\n| 名称 | 状态 |\n| --- | --- |\n| 项目 | 完成 |\n';
  const common = new HtmlRenderer().render(new Parser().parse(text));
  const gfm = new MarkdownIt().render(text);
  expect(common).toContain('<h1>标题</h1>');
  expect(common).not.toContain('<table>');
  expect(gfm).toContain('<table>');
});
