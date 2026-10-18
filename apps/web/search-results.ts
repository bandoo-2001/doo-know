import type { TreeEntry } from '../../shared/contracts';
export type WorkspaceSearchResult = {
  id: string;
  type?: 'note' | 'folder';
  title: string;
  relativePath: string;
  snippet: string;
  line?: number;
  headingPath?: string[];
  matches?: unknown[];
  filenameMatch?: boolean;
};
export function filenameResults(
  entries: TreeEntry[],
  query: string,
  directory = '',
  limit = 20,
): WorkspaceSearchResult[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const results: WorkspaceSearchResult[] = [];
  for (const entry of entries) {
    if (results.length >= limit) break;
    if (directory && entry.path !== directory && !entry.path.startsWith(directory + '/')) continue;
    if (!entry.path.toLowerCase().includes(needle)) continue;
    if (entry.type === 'note' && !entry.id) continue;
    results.push({
      id: entry.type === 'folder' ? 'folder:' + entry.path : entry.id!,
      type: entry.type,
      title: entry.name.replace(/\.md$/i, ''),
      relativePath: entry.path,
      snippet: entry.type === 'folder' ? '文件夹 · 打开查看内容' : '文件名与目录位置匹配',
      line: 1,
      filenameMatch: true,
    });
  }
  return results;
}
export function mergeSearchResults(...groups: WorkspaceSearchResult[][]): WorkspaceSearchResult[] {
  const ids = new Set<string>(),
    output: WorkspaceSearchResult[] = [];
  for (const group of groups)
    for (const result of group) {
      if (ids.has(result.id)) continue;
      ids.add(result.id);
      output.push(result);
    }
  return output;
}
