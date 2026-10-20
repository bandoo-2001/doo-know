import CodeBlock from '@tiptap/extension-code-block';
export const DocumentCodeBlock = CodeBlock.extend({
  renderMarkdown(node) {
    const language = node.attrs?.language || '';
    if (!/^[a-zA-Z0-9_+#.-]*$/.test(language)) throw Error('代码语言包含无法安全保存的字符');
    const body = (node.content || []).map((x) => x.text || '').join('');
    let width = 3;
    for (const match of body.matchAll(/`+/g)) width = Math.max(width, match[0].length + 1);
    const fence = '`'.repeat(width);
    return `${fence}${language}\n${body}\n${fence}`;
  },
});
