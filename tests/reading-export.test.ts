import { expect, it } from 'vitest';
import { buildReadingHtml } from '../apps/web/reading-export';

it('exports a standalone reading document with escaped title, static math and no frontend scripts', async () => {
  const markdown = '# 读书笔记\n\n公式 $x^2$，见说明[^a]。\n\n[^a]: 解释\n\n> [!TIP]\n> 提示\n\n[[其他笔记|相关内容]]\n\n[站内接口](/api/notes/123)\n\n[外部资料](https://example.com/read)\n\n<script>alert(1)</script>\n';
  const html = await buildReadingHtml({ title: '<img src=x onerror=alert(1)>', markdown });
  expect(html).toContain('<!doctype html>');
  expect(html).toContain('<title>&lt;img src=x onerror=alert(1)&gt;</title>');
  expect(html).toContain('<math');
  expect(html).toContain('footnote-ref');
  expect(html).toContain('解释');
  expect(html).toContain('markdown-alert-tip');
  expect(html).toContain('相关内容');
  expect(html).toContain('href="https://example.com/read"');
  expect(html).not.toContain('/api/');
  expect(html).not.toContain('<script');
  expect(html).not.toContain('data-math-source');
  expect(html).not.toContain('href="%E5%85%B6');
});

it('embeds resolved images and retains diagram source and its standard fallback', async () => {
  const png = new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: 'image/png' });
  const html = await buildReadingHtml({ title: '图形', markdown: '![图形](assets/view.png)\n\n```mermaid\nflowchart LR\n A --> B\n```\n', resolveImage: async url => url === 'assets/view.png' ? png : undefined });
  expect(html).toContain('src="data:image/png;base64,iVBORw0KGgo="');
  expect(html).toContain('language-mermaid');
  expect(html).toContain('A --&gt; B');
  expect(html).not.toContain('src="assets/');
  expect(html).not.toContain('data-diagram');
});

it('refuses incomplete exports and executable image payloads instead of retaining external resources', async () => {
  await expect(buildReadingHtml({ title: 'missing', markdown: '![图](https://example.com/private.png)' })).rejects.toThrow('图片');
  await expect(buildReadingHtml({ title: 'html', markdown: '![图](a.png)', resolveImage: async () => new Blob(['<script>alert(1)</script>'], { type: 'text/html' }) })).rejects.toThrow('图片');
  await expect(buildReadingHtml({ title: 'svg', markdown: '![图](a.svg)', resolveImage: async () => new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><script>alert(1)</script></svg>'], { type: 'image/svg+xml' }) })).rejects.toThrow('SVG');
});

it('keeps malformed formulas readable and document properties visible without fetching engines or assets', async () => {
  const html = await buildReadingHtml({ title: '属性', markdown: '---\ntitle: 标题\ncustom: {x: y}\n---\n\n$\\notacommand{x}$\n' });
  expect(html).toContain('reading-properties');
  expect(html).toContain('custom: {x: y}');
  expect(html).toContain('\\notacommand{x}');
  expect(html).not.toContain('<link');
});
