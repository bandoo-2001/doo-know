// Shared by indexed search and the browser's index-independent filename lookup.
// Rank 4 is reserved for content hits; parent-path-only matches follow them.
export const CONTENT_MATCH_RANK = 4;
export function searchNeedle(query: string) {
  const text = query.trim();
  return (
    text.length >= 2 && text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1) : text
  ).toLowerCase();
}
export function filenameMatchRank(path: string, query: string, kind: 'note' | 'folder' = 'note') {
  const needle = searchNeedle(query),
    value = path.toLowerCase();
  if (!needle || !value.includes(needle)) return undefined;
  if (value === needle) return 0;
  const name = value.slice(value.lastIndexOf('/') + 1);
  const stem = kind === 'note' ? name.replace(/\.md$/i, '') : name;
  if (name === needle || stem === needle) return 1;
  if (name.startsWith(needle)) return 2;
  if (name.includes(needle)) return 3;
  return 5;
}
