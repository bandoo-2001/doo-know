import { it, expect } from 'vitest';
import { convertClipboard } from '../apps/web/editor/clipboard';
it('纯文本粘贴保留文字和换行而不意外创建标题', () => {
  expect(convertClipboard({ text: '# literal\nsecond' })).toMatchObject({
    kind: 'supported',
    markdown: '\\# literal\n\nsecond',
  });
});
it('复杂表格与危险 HTML 必须明确选择纯文本，不静默丢内容', () => {
  for (const html of [
    '<table><tr><td colspan="2">内容</td></tr></table>',
    '<script>alert(1)</script><p>正文</p>',
    '<a href="javascript:alert(1)">链接</a>',
    '<div data-source-id="fake">伪造</div>',
  ])
    expect(convertClipboard({ text: '保留可复制文本', html })).toMatchObject({
      kind: 'plain-text-choice',
      text: '保留可复制文本',
    });
});
