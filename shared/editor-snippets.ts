export type EditorSnippet = {
  id: string;
  label: string;
  description: string;
  keywords: string[];
  markdown: string;
  selection: { from: number; to: number };
};

function snippet(id: string, label: string, description: string, keywords: string[], markdown: string, selected: string): EditorSnippet {
  const from = markdown.indexOf(selected);
  return { id, label, description, keywords, markdown, selection: { from: Math.max(0, from), to: Math.max(0, from) + selected.length } };
}

export const editorSnippets: readonly EditorSnippet[] = [
  snippet('math', '公式', '独立公式，使用常见的 $$ 语法', ['math', 'formula', 'latex', '公式'], '$$\nx^2 + y^2 = z^2\n$$\n', 'x^2 + y^2 = z^2'),
  snippet('footnote', '脚注', '引用和解释一起插入', ['footnote', '脚注'], '说明[^note]\n\n[^note]: 在这里填写脚注内容\n', '说明'),
  snippet('callout', '提示块', '引用格式的 GitHub 提示块', ['callout', 'alert', 'note', '提示', '警告'], '> [!NOTE]\n> 在这里填写提示内容\n', '在这里填写提示内容'),
  snippet('wikilink', '双向链接', '按笔记名称链接；支持 [[名称|显示文字]]', ['wiki', 'wikilink', '双链', '双向链接'], '[[笔记名称]]', '笔记名称'),
  snippet('link', '链接', '普通 Markdown 链接', ['link', '链接'], '[链接文字](https://example.com)', '链接文字'),
  snippet('code', '代码块', '带语言名称的普通代码围栏', ['code', '代码'], '```text\n在这里填写代码\n```\n', '在这里填写代码'),
  snippet('svg', 'SVG 源码', '可编辑的矢量图源码；可另行生成 PNG 预览', ['svg', '矢量'], '```svg\n<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">\n  <rect x="20" y="20" width="280" height="140" rx="12" fill="#dbeafe"/>\n  <text x="160" y="96" text-anchor="middle" font-size="24">示意图</text>\n</svg>\n```\n', '示意图'),
  snippet('mermaid', 'Mermaid 图', '保留流程图源码；可另行生成 PNG 预览', ['mermaid', 'diagram', '流程图'], '```mermaid\nflowchart LR\n  A[开始] --> B[完成]\n```\n', '开始'),
  snippet('table', '表格', 'GFM 表格，内容可直接编辑', ['table', '表格'], '| 名称 | 内容 |\n| --- | --- |\n| 项目 | 说明 |\n', '名称'),
  snippet('task', '任务列表', '可勾选的 GFM 任务', ['task', 'todo', '任务', '待办'], '- [ ] 待办事项\n', '待办事项'),
  snippet('rule', '分隔线', '普通 Markdown 水平分隔线', ['rule', 'divider', '分隔线'], '---\n', ''),
];

export function filterEditorSnippets(query: string): EditorSnippet[] {
  const search = query.trim().replace(/^\//, '').toLocaleLowerCase();
  return editorSnippets.filter(item => !search || [item.label, ...item.keywords].some(value => value.toLocaleLowerCase().includes(search)));
}

export function createEditorSnippet(id: string, markdownContext = ''): EditorSnippet {
  const item = editorSnippets.find(value => value.id === id);
  if (!item) throw Error('未找到插入模板');
  const result = { ...item, keywords: [...item.keywords], selection: { ...item.selection } };
  if (id === 'footnote') {
    let label = 'note', index = 1;
    while (markdownContext.includes(`[^${label}]`)) label = `note-${++index}`;
    result.markdown = result.markdown.replace(/\[\^note\]/g, `[^${label}]`);
  }
  return result;
}
