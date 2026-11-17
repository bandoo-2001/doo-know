/** The optional fields keep old datasets and partially loaded list catalogs usable. */
export type ToDooListBranch = {
  id: string;
  parentId?: string | null;
  orderKey?: string;
  deletedAt?: string | null;
  archivedAt?: string | null;
};

export type ToDooListRow<T extends ToDooListBranch> = {
  list: T;
  depth: number;
  ancestorIds: string[];
  hasChildren: boolean;
};

/** Parent-first rows shared by navigation and parent-list selection. */
export function toDooListRows<T extends ToDooListBranch>(
  lists: readonly T[],
  options: { collapsedIds?: ReadonlySet<string>; excludeId?: string } = {},
): ToDooListRow<T>[] {
  const byParent = new Map<string, T[]>();
  for (const list of lists) {
    if (!list.parentId) continue;
    const children = byParent.get(list.parentId) || [];
    children.push(list);
    byParent.set(list.parentId, children);
  }
  const excluded = new Set<string>();
  if (options.excludeId) {
    const queue = [options.excludeId];
    for (const id of queue) {
      if (excluded.has(id)) continue;
      excluded.add(id);
      for (const child of byParent.get(id) || []) queue.push(child.id);
    }
  }
  const active = [...new Map(lists.map((list) => [list.id, list])).values()]
    .filter((list) => !list.deletedAt && !list.archivedAt && !excluded.has(list.id))
    .sort((a, b) => (a.orderKey || 'a0').localeCompare(b.orderKey || 'a0'));
  const activeIds = new Set(active.map((list) => list.id));
  const children = new Map<string, T[]>();
  const roots: T[] = [];
  for (const list of active) {
    if (!list.parentId || list.parentId === list.id || !activeIds.has(list.parentId)) {
      roots.push(list);
      continue;
    }
    const siblings = children.get(list.parentId) || [];
    siblings.push(list);
    children.set(list.parentId, siblings);
  }
  const rows: ToDooListRow<T>[] = [];
  const visited = new Set<string>();
  function append(root: T) {
    const queue = [{ list: root, ancestorIds: [] as string[] }];
    while (queue.length) {
      const next = queue.pop()!;
      if (visited.has(next.list.id)) continue;
      visited.add(next.list.id);
      const branch = (children.get(next.list.id) || []).filter((list) => !visited.has(list.id));
      rows.push({ ...next, depth: next.ancestorIds.length, hasChildren: !!branch.length });
      for (const list of [...branch].reverse())
        queue.push({ list, ancestorIds: [...next.ancestorIds, next.list.id] });
    }
  }
  roots.forEach(append);
  // Invalid historical cycles must not hide the user's lists or recurse forever.
  active.forEach(append);
  return options.collapsedIds?.size
    ? rows.filter((row) => !row.ancestorIds.some((id) => options.collapsedIds!.has(id)))
    : rows;
}
