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
