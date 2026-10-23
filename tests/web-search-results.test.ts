import { it, expect } from 'vitest';
import { filenameResults, mergeSearchResults } from '../apps/web/search-results';
import type { TreeEntry } from '../shared/contracts';
const entries: TreeEntry[] = [
  { type: 'folder', name: '方法', path: '30-Knowledge/方法' },
  { type: 'note', id: 'one', name: '部署方法.md', path: '30-Knowledge/方法/部署方法.md' },
  { type: 'note', id: 'two', name: 'DEPLOY.md', path: '30-Knowledge/方法2/DEPLOY.md' },
];
it('finds fresh notes and folders by filename without an index and respects directory boundaries', () => {
  expect(filenameResults(entries, '方法', '30-Knowledge/方法').map((item) => item.id)).toEqual([
    'folder:30-Knowledge/方法',
    'one',
  ]);
  expect(filenameResults(entries, 'deploy')[0].id).toBe('two');
});
it('bounds local matches and never creates a selectable note without a stable ID', () => {
  const many = Array.from({ length: 100 }, (_, i) => ({
    type: 'note' as const,
    id: String(i),
    path: `00-Inbox/笔记-${i}.md`,
    name: `笔记-${i}.md`,
  }));
  expect(filenameResults(many, '笔记')).toHaveLength(20);
  expect(
    filenameResults([{ type: 'note', path: '00-Inbox/笔记.md', name: '笔记.md' }], '笔记'),
  ).toHaveLength(0);
  expect(filenameResults(entries, '   ')).toHaveLength(0);
});
it('merges indexed hits with filename results and additional pages without duplicate notes', () => {
  const names = filenameResults(entries, '部署');
  const hit = { ...names[0], snippet: '命中的正文', filenameMatch: false, line: 12 };
  expect(mergeSearchResults([hit], names)).toEqual([hit]);
  expect(
    mergeSearchResults(names, [hit], [{ ...hit, id: 'three' }]).map((item) => item.id),
  ).toEqual(['one', 'three']);
});
it('keeps an exact filename ahead of many matches in parent directory names before limiting', () => {
  const crowded: TreeEntry[] = Array.from({ length: 30 }, (_, i) => ({
    type: 'note',
    id: `other-${i}`,
    name: `其他-${i}.md`,
    path: `00-Inbox/水文/其他-${i}.md`,
  }));
  crowded.push({ type: 'note', id: 'exact', name: '水文.md', path: '40-Resources/水文.md' });
  const found = filenameResults(crowded, '水文');
  expect(found).toHaveLength(20);
  expect(found[0].id).toBe('exact');
});
it('orders exact, prefix and partial names ahead of parent-path matches', () => {
  const entries: TreeEntry[] = [
    { type: 'note', id: 'path', name: '记录.md', path: '00-Inbox/水文/记录.md' },
    { type: 'note', id: 'partial', name: '城市水文.md', path: '00-Inbox/城市水文.md' },
    { type: 'note', id: 'prefix', name: '水文资料.md', path: '00-Inbox/水文资料.md' },
    { type: 'note', id: 'exact', name: '水文.md', path: '00-Inbox/水文.md' },
  ];
  expect(filenameResults(entries, '水文').map((x) => x.id)).toEqual([
    'exact',
    'prefix',
    'partial',
    'path',
  ]);
  expect(filenameResults(entries, '"水文.md"').map((x) => x.id)).toEqual(['exact', 'partial']);
});
it('promotes a filename hit over unrelated indexed content without losing its indexed excerpt', () => {
  const local = filenameResults(entries, '部署');
  const content = {
    id: 'other',
    title: '其他内容',
    relativePath: '00-Inbox/other.md',
    snippet: '其他命中',
    line: 8,
  };
  const indexed = { ...local[0], filenameMatch: false, line: 12, snippet: '命中的正文' };
  const merged = mergeSearchResults([content], local, [indexed]);
  expect(merged.map((x) => x.id)).toEqual(['one', 'other']);
  expect(merged[0]).toMatchObject({ line: 12, snippet: '命中的正文', filenameMatch: false });
});
it('replaces a filename fallback when a later page supplies a precise content hit', () => {
  const local = filenameResults(entries, '部署');
  const hit = { ...local[0], filenameMatch: false, line: 38, snippet: '正文第38行' };
  const merged = mergeSearchResults(local, [hit], local);
  expect(merged).toHaveLength(1);
  expect(merged[0]).toMatchObject({ line: 38, snippet: '正文第38行', filenameMatch: false });
});
