import { toDooListSelectTree, type ToDooSelectableList } from './to-doo-list-select-tree';

const listKey = (id: string) => '$dooknow-list:' + id;
const inboxKey = '$dooknow-scope:inbox';
export type ToDooListMultiNode = {
  key: string;
  value: string;
  title: string;
  label: string;
  searchText: string;
  list?: ToDooSelectableList;
  children?: ToDooListMultiNode[];
  disabled?: boolean;
};

/** TreeSelect's strict checkbox mode uses labeled values; callers retain plain domain IDs. */
export function prepareToDooListMultiSelection(
  lists: readonly ToDooSelectableList[],
  selected: readonly string[],
  includeInbox = false,
) {
  const controlToDomain = new Map<string, string>();
  const byDomain = new Map<string, ToDooListMultiNode>();
  function convert(node: ReturnType<typeof toDooListSelectTree>[number]): ToDooListMultiNode {
    const key = listKey(node.value);
    const result: ToDooListMultiNode = {
      ...node,
      key,
      value: key,
      children: node.children.map(convert),
    };
    controlToDomain.set(key, node.value);
    byDomain.set(node.value, result);
    return result;
  }
  const tree: ToDooListMultiNode[] = toDooListSelectTree(lists).map(convert);
  if (includeInbox) {
    const inbox = {
      key: inboxKey,
      value: inboxKey,
      title: '收集箱',
      label: '收集箱',
      searchText: '收集箱',
    };
    tree.unshift(inbox);
    controlToDomain.set(inboxKey, 'inbox');
    // 'inbox' is the existing range API's unassigned sentinel, not a list identity.
    byDomain.set('inbox', inbox);
  }
  const values = [...new Set(selected)].map((id) => {
    let node = byDomain.get(id);
    if (!node) {
      const list = lists.find((list) => list.id === id);
      const key = listKey(id);
      node = {
        key,
        value: key,
        title: list?.name || '当前清单（尚未载入）',
        label: list?.name || '当前清单（尚未载入）',
        searchText: list?.name || '',
        list,
        disabled: true,
      };
      tree.push(node);
      controlToDomain.set(key, id);
      byDomain.set(id, node);
    }
    return { value: node.value, label: node.label };
  });
  return { tree, values, controlToDomain, byDomain };
}

/** An invalid control payload must not silently clear part of an existing filter. */
export function readToDooListMultiChange(
  value: unknown,
  controlToDomain: ReadonlyMap<string, string>,
) {
  if (!Array.isArray(value)) return null;
  const result: string[] = [];
  for (const item of value) {
    if (item && typeof item === 'object' && item.halfChecked === true) continue;
    const key = typeof item === 'string' ? item : item?.value;
    if (typeof key !== 'string' || !controlToDomain.has(key)) return null;
    const id = controlToDomain.get(key)!;
    if (!result.includes(id)) result.push(id);
  }
  return result;
}
