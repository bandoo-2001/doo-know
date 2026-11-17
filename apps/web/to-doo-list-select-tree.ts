import { TO_DOO_LIST_MAX_DEPTH } from '../../shared/to-doo-contracts';
import { toDooListRows, type ToDooListBranch } from './to-doo-list-tree';

export type ToDooSelectableList = ToDooListBranch & {
  name: string;
  kind?: string;
  color?: string;
  icon?: string | null;
};
export type ToDooListSelectNode = {
  key: string;
  value: string;
  title: string;
  label: string;
  searchText: string;
  depth: number;
  list: ToDooSelectableList;
  children: ToDooListSelectNode[];
  canCreateChild: boolean;
};

export function toDooListSubtreeDepth(lists: readonly ToDooSelectableList[], excludeId?: string) {
  if (!excludeId) return 1;
  // Archived descendants still count toward the server's hierarchy limit.
  const rows = toDooListRows(lists.map((list) => ({ ...list, archivedAt: null })));
  return Math.max(
    1,
    ...rows
      .filter((row) => row.ancestorIds.includes(excludeId))
      .map((row) => row.depth - row.ancestorIds.indexOf(excludeId) + 1),
  );
}

export function toDooListSelectTree(
  lists: readonly ToDooSelectableList[],
  options: { parentMode?: boolean; excludeId?: string } = {},
) {
  const subtreeDepth = options.parentMode ? toDooListSubtreeDepth(lists, options.excludeId) : 0;
  const names = new Map(lists.map((list) => [list.id, list.name]));
  const rows = toDooListRows(lists, { excludeId: options.excludeId }).filter(
    (row) => !options.parentMode || row.depth + 1 + subtreeDepth <= TO_DOO_LIST_MAX_DEPTH,
  );
  const nodes = new Map<string, ToDooListSelectNode>();
  const roots: ToDooListSelectNode[] = [];
  for (const row of rows) {
    const node: ToDooListSelectNode = {
      key: row.list.id,
      value: row.list.id,
      title: row.list.name,
      label: row.list.name,
      searchText: [...row.ancestorIds.map((id) => names.get(id)), row.list.name]
        .filter(Boolean)
        .join(' / '),
      depth: row.depth,
      list: row.list,
      children: [],
      canCreateChild: row.depth + 2 + subtreeDepth <= TO_DOO_LIST_MAX_DEPTH,
    };
    nodes.set(node.key, node);
    const parent = row.list.parentId && nodes.get(row.list.parentId);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

export function matchesToDooListSearch(query: string, text: string) {
  const normalize = (value: string) =>
    value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
  const source = normalize(text);
  return normalize(query)
    .split(' ')
    .every((term) => {
      if (source.includes(term)) return true;
      let matched = 0;
      for (const character of source) if (character === term[matched]) matched++;
      return matched === term.length;
    });
}
