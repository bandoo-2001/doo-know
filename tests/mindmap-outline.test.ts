import { expect, it } from 'vitest';
import {
  parseMindmapOutline,
  serializeMindmapOutline,
  type MindmapNode,
} from '../shared/mindmap-outline';

it('preserves duplicate Chinese labels, hierarchy and sibling order as distinct nodes', () => {
  const root = parseMindmapOutline('# 项目\n\n- 同名\n  - 子节点\n- 同名\n');
  expect(root.topic).toBe('项目');
  expect(root.children.map((node) => node.topic)).toEqual(['同名', '同名']);
  expect(root.children[0].children[0].topic).toBe('子节点');
  expect(root.children[0].id).not.toBe(root.children[1].id);
  root.children.reverse();
  expect(serializeMindmapOutline(root)).toBe('# 项目\n\n- 同名\n- 同名\n  - 子节点\n');
});

it('round trips literal Markdown punctuation and entities without turning them into formatting', () => {
  const topic = '中文 *星号* [链接](a) `代码` &amp; <img> # + - ! \\ | _ ~';
  const root: MindmapNode = {
    id: 'r',
    topic,
    children: [{ id: 'child', topic: '同名 & 中文', children: [] }],
  };
  const source = serializeMindmapOutline(root);
  const parsed = parseMindmapOutline(source);
  expect(parsed.topic).toBe(topic);
  expect(parsed.children[0].topic).toBe('同名 & 中文');
});

it('round trips a root without children and accepts CRLF', () => {
  expect(serializeMindmapOutline(parseMindmapOutline('# 单节点\r\n'))).toBe('# 单节点\n');
});

it('round trips 500 text nodes and a bounded deep hierarchy', () => {
  const root: MindmapNode = {
    id: 'r',
    topic: '根',
    children: Array.from({ length: 499 }, (_, i) => ({
      id: String(i),
      topic: '中文节点 ' + i,
      children: [],
    })),
  };
  expect(parseMindmapOutline(serializeMindmapOutline(root)).children).toHaveLength(499);
  const deepRoot: MindmapNode = { id: 'r', topic: '深根', children: [] };
  let deep = deepRoot;
  for (let i = 0; i < 30; i++) {
    const child = { id: 'd' + i, topic: '深层 ' + i, children: [] };
    deep.children = [child];
    deep = child;
  }
  expect(serializeMindmapOutline(parseMindmapOutline(serializeMindmapOutline(deepRoot)))).toBe(
    serializeMindmapOutline(deepRoot),
  );
});

it.each([
  '# 根\n\n- **富文本**\n',
  '# 根\n\n- [链接](https://example.com)\n',
  '# 根\n\n- `代码`\n',
  '# 根\n\n1. 有序\n',
  '# 根\n\n- 父\n   - 错误缩进\n',
  '# 根\n\n- 父\n    - 跳级\n',
  '# 根\n\n- 父\n  多行续写\n',
  '# 根\n\n- 父\n\n说明\n',
  '# 根\n\n# 另一个根\n',
  '# 根\n\n- \n',
  '# 根\n\n- <img src="x">\n',
  '# 根\n\n- [x] 任务\n',
  '# 根\n\n- 父\n\t- 子\n',
])('rejects unsupported structure instead of silently losing it (%j)', (source) => {
  expect(() => parseMindmapOutline(source)).toThrow();
});

it('rejects unrepresentable editor nodes, cycles, duplicate IDs and excessive size/depth', () => {
  const root: MindmapNode = { id: 'r', topic: '根', children: [] };
  expect(() => serializeMindmapOutline({ ...root, topic: '多\n行' })).toThrow();
  expect(() => serializeMindmapOutline({ ...root, topic: ' 失去空格 ' })).toThrow();
  expect(() => serializeMindmapOutline({ ...root, children: [{ ...root }] })).toThrow();
  root.children.push(root);
  expect(() => serializeMindmapOutline(root)).toThrow();
  expect(() => parseMindmapOutline('# 根\n\n' + '- 节点\n'.repeat(500))).toThrow();
  expect(() =>
    parseMindmapOutline(
      '# 根\n\n' + Array.from({ length: 65 }, (_, i) => '  '.repeat(i) + '- 子\n').join(''),
    ),
  ).toThrow();
});

it.each(['# 标题', '> 引用', '- 额外层级', '```js', 'a\u0000b'])(
  'rejects block syntax and control normalization hidden inside a node (%j)',
  (text) => {
    expect(() => parseMindmapOutline('# 根\n\n- ' + text + '\n')).toThrow();
  },
);
it('keeps escaped block punctuation as literal text', () => {
  const parsed = parseMindmapOutline('# 根\n\n- \\# 标题\n- \\> 引用\n- \\- 子项\n');
  expect(parsed.children.map((node) => node.topic)).toEqual(['# 标题', '> 引用', '- 子项']);
});
