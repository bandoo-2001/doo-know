import type { TreeEntry } from '../../shared/contracts';
import { CONTENT_MATCH_RANK, filenameMatchRank, searchNeedle } from '../../shared/search-matching';
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
  filenameRank?: number;
};
export function filenameResults(
  entries: TreeEntry[],
  query: string,
  directory = '',
  limit = 20,
): WorkspaceSearchResult[] {
  const needle = searchNeedle(query);
  if (!needle || !Number.isSafeInteger(limit) || limit <= 0) return [];
  // Inspect all entries, retaining only the best bounded candidates per rank.
  // A directory encountered first cannot exhaust the budget before an exact name.
  const buckets: WorkspaceSearchResult[][] = Array.from({ length: 6 }, () => []);
  for (const entry of entries) {
    if (directory && entry.path !== directory && !entry.path.startsWith(directory + '/')) continue;
    if (entry.type === 'note' && !entry.id) continue;
    const rank = filenameMatchRank(entry.path, query, entry.type);
    if (rank === undefined || buckets[rank].length >= limit) continue;
    buckets[rank].push({
      id: entry.type === 'folder' ? 'folder:' + entry.path : entry.id!,
      type: entry.type,
      title: entry.name.replace(/\.md$/i, ''),
      relativePath: entry.path,
      snippet: entry.type === 'folder' ? '文件夹 · 打开查看内容' : '文件名与目录位置匹配',
      line: 1,
      filenameMatch: true,
      filenameRank: rank,
    });
  }
  return buckets.flat().slice(0, limit);
}
export function mergeSearchResults(...groups: WorkspaceSearchResult[][]): WorkspaceSearchResult[] {
  const results = new Map<string, WorkspaceSearchResult>();
  for (const group of groups)
    for (const result of group) {
      const previous = results.get(result.id);
      if (!previous) {
        results.set(result.id, result);
        continue;
      }
      // A later indexed hit refines a filename fallback; another fallback must
      // never overwrite its excerpt, match line or indexed-result status.
      const best = previous.filenameMatch && !result.filenameMatch ? result : previous;
      const rank = Math.min(
        previous.filenameRank ?? CONTENT_MATCH_RANK,
        result.filenameRank ?? CONTENT_MATCH_RANK,
      );
      results.set(result.id, best.filenameRank === rank ? best : { ...best, filenameRank: rank });
    }
  return [...results.values()].sort(
    (a, b) => (a.filenameRank ?? CONTENT_MATCH_RANK) - (b.filenameRank ?? CONTENT_MATCH_RANK),
  );
}
