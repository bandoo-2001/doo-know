import { it, expect } from 'vitest';
import MarkdownIt from 'markdown-it';
import { knowledgeMarkdown, hasKnowledgeSyntax } from '../shared/knowledge-markdown';
const md = () => new MarkdownIt({html:false}).use(knowledgeMarkdown);
it('preserves readable source while marking math for a lazy renderer', () => {
  const html = md().render('公式 $x^2$\n\n$$\na+b\n$$\n');
  expect(html).toContain('data-math-source=');
  expect(html).toContain('x^2');
  expect(html).toContain('a+b');
  expect(md().render('`$x$`')).not.toContain('data-math-source');
});
it('renders footnotes and GitHub callouts without enabling arbitrary HTML', () => {
  const html = md().render('引用[^a]\n\n[^a]: 解释\n\n> [!NOTE]\n> 提示内容\n\n<script>alert(1)</script>');
  expect(html).toContain('footnote-ref');
  expect(html).toContain('解释');
  expect(html).toContain('markdown-alert-note');
  expect(html).not.toContain('<script>');
});
it('turns wikilinks into ordinary relative Markdown destinations and rejects schemes', () => {
  const html = md().render('[[资料/我的笔记|说明]] [[https://evil/x]]');
  expect(html).toContain('资料/我的笔记.md'.split('/').map(encodeURIComponent).join('/'));
  expect(html).toContain('说明');
  expect(html).not.toContain('href="https://evil');
  expect(hasKnowledgeSyntax('说明[^a]')).toBe(true);
  expect(hasKnowledgeSyntax('普通段落')).toBe(false);
});
