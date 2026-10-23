import { it, expect } from 'vitest';
import MarkdownIt from 'markdown-it';
import { previewSource } from '../apps/web/preview-source';

it('keeps source lines after inline syntax that consumes or normalizes newlines', () => {
  const md = new MarkdownIt({ html: false }).use(previewSource);
  expect(md.render('# 标题\n\nfirst `one\ntwo` 水文\n')).toContain(
    '<span data-source-line="4"> 水文</span>',
  );
  expect(md.render('# 标题\n\n[link](\nhttps://example.com) 水文\n')).toContain(
    '<span data-source-line="4"> 水文</span>',
  );
});

it('retains escaped code content while mapping individual fence and indented code lines', () => {
  const md = new MarkdownIt({ html: false }).use(previewSource);
  const fence = md.render('```html\n<script>\n水文\n```\n');
  expect(fence).toContain('<span data-source-line="2">&lt;script&gt;</span>');
  expect(fence).toContain('<span data-source-line="3">水文</span>');
  expect(fence).not.toContain('<script>');
  expect(md.render('    first\n    水文\n')).toContain('<span data-source-line="2">水文</span>');
});
