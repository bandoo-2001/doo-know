import { describe, expect, it } from 'vitest';
import MarkdownIt from 'markdown-it';
import { buildOutline, outlineFromTokens } from '../apps/web/document-outline';

describe('document outline', () => {
  it('builds parent/child relationships for H1–H5 and starts a new branch for peers', () => {
    const items = outlineFromTokens(
      new MarkdownIt().parse(
        '# 总览\n\n## 章节\n\n### 小节\n\n#### 主题\n\n##### 要点\n\n## 下一章\n',
        {},
      ),
    );
    const tree = buildOutline(items);
    expect(tree).toHaveLength(1);
    expect(tree[0].children.map((item) => item.title)).toEqual(['章节', '下一章']);
    expect(tree[0].children[0].children[0].children[0].children[0].title).toBe('要点');
    expect(items.map((item) => item.line)).toEqual([1, 3, 5, 7, 9, 11]);
  });
  it('includes H6, ignores code fences, accepts setext headings and strips inline formatting', () => {
    const items = outlineFromTokens(
      new MarkdownIt().parse(
        '标题\n====\n\n## **重点** 与 [链接](https://example.invalid) `代码`\n\n```md\n## 假标题\n```\n\n###### 六级\n',
        {},
      ),
    );
    expect(items.map((item) => item.title)).toEqual(['标题', '重点 与 链接 代码', '六级']);
  });
  it('excludes YAML headings without changing actual body source lines', () => {
    const markdown='--- \ntitle: metadata\n---\n\n# Body\n\n###### Detail\n';
    const items=outlineFromTokens(new MarkdownIt().parse(markdown,{}),3);
    expect(items).toEqual([{line:5,level:1,title:'Body'},{line:7,level:6,title:'Detail'}]);
  });
  it('handles skipped heading levels and duplicate titles without losing their source lines', () => {
    const items = [
      { level: 3, line: 1, title: '重复' },
      { level: 5, line: 3, title: '重复' },
      { level: 2, line: 5, title: '新的父级' },
    ];
    const tree = buildOutline(items);
    expect(tree.map((item) => item.line)).toEqual([1, 5]);
    expect(tree[0].children[0].line).toBe(3);
    expect(buildOutline([])).toEqual([]);
  });
});
