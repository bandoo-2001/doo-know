import { it, expect } from 'vitest';
import MarkdownIt from 'markdown-it';
import { markdownTasks } from '../shared/markdown-tasks';
it('任务状态为非交互标记，代码中的语法保持原样', () => {
  const md = new MarkdownIt({ html: false }).use(markdownTasks);
  const html = md.render('- [ ] 任务\n- [x] 完成\n\n```\n- [x] literal\n```');
  expect(html).toContain('未完成');
  expect(html).toContain('已完成');
  expect(html).toContain('- [x] literal');
  expect(html).not.toContain('<input');
  expect(html).not.toContain('onclick');
});
it('分享渲染保留 Markdown 表格列对齐并限制允许样式', async () => {
  const { renderMarkdown } = await import('../packages/core/render');
  const result = renderMarkdown('| A | B |\n| :--- | ---: |\n| X | Y |\n');
  expect(result.html).toContain('text-align:right');
});
