export interface RecordPage<T> {
  items: T[];
  nextCursor?: string | null;
}
/** Refresh a contiguous current cursor chain through the last row the owner opened. */
export function createPageWindow<T extends { id: string }>(
  fetchPage: (cursor?: string) => Promise<RecordPage<T>>,
) {
  let items: T[] = [],
    nextCursor: string | undefined;
  return {
    async read(more = false, reset = false): Promise<RecordPage<T>> {
      if (more && !nextCursor) return { items, nextCursor };
      const previous = reset ? [] : items;
      const oldTail = !more ? previous.at(-1)?.id : undefined;
      const pages: RecordPage<T>[] = [];
      const visited = new Set<string | undefined>();
      let cursor = more ? nextCursor : undefined;
      for (let count = 0; count < 100; count++) {
        if (visited.has(cursor))
          throw Error('列表游标重复，请稍后重新刷新。已展开的记录保持不变。');
        visited.add(cursor);
        const page = await fetchPage(cursor);
        pages.push(page);
        if (more || !oldTail || page.items.some((item) => item.id === oldTail)) break;
        if (!page.nextCursor) throw Error('部分旧记录暂时无法重新确认，请点击刷新重新读取列表。');
        cursor = page.nextCursor;
      }
      if (oldTail && !pages.some((page) => page.items.some((item) => item.id === oldTail))) {
        throw Error('新记录较多，本次刷新尚未覆盖已展开的旧记录。请点击刷新重新读取列表。');
      }
      const incoming = pages.flatMap((page) => page.items);
      const latest = new Map([...previous, ...incoming].map((item) => [item.id, item]));
      const ordered = more ? [...previous, ...incoming] : [...incoming, ...previous];
      const seen = new Set<string>();
      items = ordered
        .filter((item) => {
          if (seen.has(item.id)) return false;
          seen.add(item.id);
          return true;
        })
        .map((item) => latest.get(item.id)!);
      nextCursor = pages.at(-1)?.nextCursor || undefined;
      return { items, nextCursor };
    },
  };
}
