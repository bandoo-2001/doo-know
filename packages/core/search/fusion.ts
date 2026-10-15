export function rrf(
  text: { chunkId: string; rank: number; score: number }[],
  vectors: { chunkId: string; rank: number; score: number }[],
  k = 60,
) {
  const values = new Map<
    string,
    { chunkId: string; score: number; matchedBy: ('text' | 'semantic')[] }
  >();
  for (const [items, kind] of [
    [text, 'text'],
    [vectors, 'semantic'],
  ] as const)
    for (const item of items) {
      const value = values.get(item.chunkId) || { chunkId: item.chunkId, score: 0, matchedBy: [] };
      value.score += 1 / (k + item.rank);
      if (!value.matchedBy.includes(kind)) value.matchedBy.push(kind);
      values.set(item.chunkId, value);
    }
  return [...values.values()].sort(
    (a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId),
  );
}
