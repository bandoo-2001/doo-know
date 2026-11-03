import MarkdownIt from 'markdown-it';

export type MindmapNode = { id: string; topic: string; children: MindmapNode[] };
export const MINDMAP_LIMITS = {
  nodes: 500,
  depth: 64,
  sourceBytes: 256 * 1024,
  topicCharacters: 2000,
} as const;
const md = new MarkdownIt({ html: true, maxNesting: 512 });
const invalid = (): never => {
  throw Error('脑图仅支持一个根标题和两空格缩进的纯文本无序大纲');
};
function validTopic(topic: unknown): topic is string {
  return (
    typeof topic === 'string' &&
    !!topic.trim() &&
    topic.trim() === topic &&
    topic.length <= MINDMAP_LIMITS.topicCharacters &&
    !/[\u0000-\u001f\u007f]/.test(topic)
  );
}
function plainText(value: string) {
  // markdown-it owns escaping/entities; anything richer than a single text token is unsupported.
  const children = md.parseInline(value, {})[0]?.children;
  if (!children?.length || children.some((token) => token.type !== 'text')) return invalid();
  const topic = children.map((token) => token.content).join('');
  if (!validTopic(topic)) return invalid();
  return topic;
}
function boundSource(source: string) {
  if (new TextEncoder().encode(source).length > MINDMAP_LIMITS.sourceBytes) return invalid();
}

/** Explicit subset: no rich text, continuations, links or second hidden authority. */
export function parseMindmapOutline(source: string): MindmapNode {
  boundSource(source);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(source)) return invalid();
  const blocks = md.parse(source, {});
  const allowed = new Set([
    'heading_open',
    'heading_close',
    'inline',
    'bullet_list_open',
    'bullet_list_close',
    'list_item_open',
    'list_item_close',
    'paragraph_open',
    'paragraph_close',
  ]);
  if (
    blocks.some((token) => !allowed.has(token.type)) ||
    blocks.filter((token) => token.type === 'heading_open').length !== 1 ||
    blocks[0]?.type !== 'heading_open' ||
    blocks[0].tag !== 'h1'
  )
    return invalid();
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  if (!/^# [^\n]+$/.test(lines[0] || '')) return invalid();
  const root: MindmapNode = { id: 'root', topic: plainText(lines[0].slice(2)), children: [] };
  const stack: MindmapNode[] = [root];
  let count = 1;
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim()) continue;
    const match = /^( *)- (\S.*)$/.exec(line);
    if (!match || match[1].length % 2 || /^\[[ xX]\](?: |$)/.test(match[2])) return invalid();
    const depth = match[1].length / 2 + 1;
    if (depth > MINDMAP_LIMITS.depth || depth > stack.length || ++count > MINDMAP_LIMITS.nodes)
      return invalid();
    stack.length = depth;
    const parent = stack[depth - 1];
    const node: MindmapNode = {
      id: parent.id + '-' + parent.children.length,
      topic: plainText(match[2]),
      children: [],
    };
    parent.children.push(node);
    stack.push(node);
  }
  if (blocks.filter((token) => token.type === 'list_item_open').length !== count - 1)
    return invalid();
  return root;
}
function escapeTopic(topic: string) {
  return topic.replace(/[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/g, '\\$&');
}
/** Validate editor data as well as Markdown: rejected features must never be silently discarded. */
export function serializeMindmapOutline(root: MindmapNode): string {
  const ids = new Set<string>(),
    lines: string[] = [];
  const visit = (node: MindmapNode, depth: number) => {
    if (
      depth > MINDMAP_LIMITS.depth ||
      ids.size >= MINDMAP_LIMITS.nodes ||
      !node ||
      typeof node.id !== 'string' ||
      !node.id ||
      ids.has(node.id) ||
      !validTopic(node.topic) ||
      !Array.isArray(node.children)
    )
      return invalid();
    ids.add(node.id);
    lines.push(
      depth === 0
        ? '# ' + escapeTopic(node.topic)
        : '  '.repeat(depth - 1) + '- ' + escapeTopic(node.topic),
    );
    if (depth === 0 && node.children.length) lines.push('');
    for (const child of node.children) visit(child, depth + 1);
  };
  visit(root, 0);
  const result = lines.join('\n') + '\n';
  boundSource(result);
  return result;
}
