import type { MarkdownIt } from 'markdown-it';
export function markdownTasks(md: MarkdownIt) {
  md.core.ruler.after('inline', 'task_markers', (state) => {
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (
        t.type !== 'inline' ||
        tokens[i - 1]?.type !== 'paragraph_open' ||
        tokens[i - 2]?.type !== 'list_item_open'
      )
        continue;
      const first = t.children?.[0];
      const marker = first?.type === 'text' ? /^\[([ xX])\][ \t]+/.exec(first.content) : null;
      if (!marker || !t.children || !first) continue;
      first.content = first.content.slice(marker[0].length);
      const mark = new state.Token('task_marker', 'span', 0);
      mark.content = marker[1].toLowerCase() === 'x' ? '已完成' : '未完成';
      t.children.unshift(mark);
    }
  });
  md.renderer.rules.task_marker = (tokens, index) => {
    const checked = tokens[index].content === '已完成';
    return `<span class="task-marker" role="img" aria-label="${checked ? '已完成' : '未完成'}">${checked ? '☑' : '☐'}</span> `;
  };
}
