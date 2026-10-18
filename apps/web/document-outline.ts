import type { Token } from 'markdown-it';

export interface OutlineHeading {
  line: number;
  level: number;
  title: string;
}
export interface OutlineNode extends OutlineHeading {
  children: OutlineNode[];
}

export function outlineFromTokens(tokens: Token[]): OutlineHeading[] {
  return tokens.flatMap((token, index) => {
    const level = Number(token.tag.slice(1));
    if (token.type !== 'heading_open' || !token.map || level < 1 || level > 5) return [];
    const inline = tokens[index + 1];
    const title = inline?.children
      ?.map((child) =>
        ['text', 'code_inline', 'image'].includes(child.type)
          ? child.content
          : ['softbreak', 'hardbreak'].includes(child.type)
            ? ' '
            : '',
      )
      .join('')
      .trim();
    return [{ line: token.map[0] + 1, level, title: title || inline?.content || '未命名章节' }];
  });
}

export function buildOutline(headings: OutlineHeading[]): OutlineNode[] {
  const roots: OutlineNode[] = [];
  const parents: OutlineNode[] = [];
  for (const heading of headings) {
    const node: OutlineNode = { ...heading, children: [] };
    while (parents.length && parents.at(-1)!.level >= node.level) parents.pop();
    (parents.at(-1)?.children || roots).push(node);
    parents.push(node);
  }
  return roots;
}
