import type { ResourceRef, ResourceSet } from '../../shared/permissions';
import type { PermissionResourceOption } from './mcp-permissions';

export interface KnowledgeResourceNode {
  key: string;
  value: string;
  title: string;
  label: string;
  id: string;
  kind: string;
  path?: string;
  included: boolean;
  unavailable?: boolean;
  checkable: boolean;
  selectable: boolean;
  children: KnowledgeResourceNode[];
}

export const knowledgeResourceKey = (ref: ResourceRef) => JSON.stringify([ref.kind, ref.id]);
// Older inventories used the full path as their label.
const pathOf = (ref: PermissionResourceOption) => ref.path ?? ref.label;
const below = (path: string, parent: string) => !!parent && path.startsWith(parent + '/');

function availableResources(resources: PermissionResourceOption[], ceiling?: ResourceSet) {
  const knowledge = resources.filter((ref) => ref.kind === 'directory' || ref.kind === 'note');
  if (!ceiling || ceiling.mode === 'all') return knowledge;
  const byKey = new Map(knowledge.map((ref) => [knowledgeResourceKey(ref), ref]));
  const keys = new Set(ceiling.resources.map(knowledgeResourceKey));
  const directories = ceiling.resources
    .filter((ref) => ref.kind === 'directory')
    .map((ref) => byKey.get(knowledgeResourceKey(ref)))
    .filter((ref): ref is PermissionResourceOption => !!ref)
    .map(pathOf);
  return knowledge.filter(
    (ref) =>
      keys.has(knowledgeResourceKey(ref)) || directories.some((path) => below(pathOf(ref), path)),
  );
}

export function buildKnowledgeResourceTree(
  resources: PermissionResourceOption[],
  selected: ResourceRef[],
  ceiling?: ResourceSet,
): KnowledgeResourceNode[] {
  const available = availableResources(resources, ceiling);
  const allowedKeys = new Set(available.map(knowledgeResourceKey));
  const selectedKeys = new Set(selected.map(knowledgeResourceKey));
  const directoryPaths = new Map(
    resources.filter((ref) => ref.kind === 'directory').map((ref) => [pathOf(ref), ref]),
  );
  const includedPaths = available
    .filter((ref) => ref.kind === 'directory' && selectedKeys.has(knowledgeResourceKey(ref)))
    .map(pathOf);
  const nodes = new Map<string, KnowledgeResourceNode>();

  function add(path: string, resource?: PermissionResourceOption) {
    if (nodes.has(path)) return;
    const resourceKey = resource ? knowledgeResourceKey(resource) : '';
    const allowed = allowedKeys.has(resourceKey);
    const key = allowed ? resourceKey : 'context:' + path;
    const included =
      allowed && !selectedKeys.has(key) && includedPaths.some((parent) => below(path, parent));
    nodes.set(path, {
      key,
      value: key,
      title: path.split('/').at(-1) || resource?.label || path,
      label: path,
      path,
      id: resource?.id || '',
      kind: resource?.kind || 'directory',
      included,
      checkable: allowed && !included,
      selectable: allowed && !included,
      children: [],
    });
  }

  for (const resource of available) {
    const path = pathOf(resource);
    add(path, resource);
    let parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    while (parent) {
      add(parent, directoryPaths.get(parent));
      parent = parent.includes('/') ? parent.slice(0, parent.lastIndexOf('/')) : '';
    }
  }

  const roots: KnowledgeResourceNode[] = [];
  for (const [path, node] of nodes) {
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    if (parent && nodes.has(parent)) nodes.get(parent)!.children.push(node);
    else roots.push(node);
  }
  function sort(branch: KnowledgeResourceNode[]) {
    branch.sort(
      (a, b) =>
        Number(b.kind === 'directory') - Number(a.kind === 'directory') ||
        a.title.localeCompare(b.title, 'zh-CN'),
    );
    for (const node of branch) sort(node.children);
  }
  sort(roots);

  // Saved identities can disappear or belong to a replaced library. Preserve
  // them as removable entries instead of binding them to a matching old path.
  const seen = new Set(allowedKeys);
  for (const ref of selected) {
    const key = knowledgeResourceKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    const label = `${ref.kind === 'directory' ? '目录' : ref.kind === 'note' ? '笔记' : ref.kind} · ${ref.id}（当前不可用或未加载）`;
    roots.push({
      key,
      value: key,
      title: label,
      label,
      id: ref.id,
      kind: ref.kind,
      included: false,
      unavailable: true,
      checkable: true,
      selectable: true,
      children: [],
    });
  }
  return roots;
}

export function knowledgeResourceSelection(
  values: unknown,
  resources: PermissionResourceOption[],
  previous: ResourceRef[],
  ceiling?: ResourceSet,
): ResourceRef[] {
  if (!Array.isArray(values)) return [];
  const allowed = new Map(
    [...availableResources(resources, ceiling), ...previous].map((ref) => [
      knowledgeResourceKey(ref),
      { kind: ref.kind, id: ref.id },
    ]),
  );
  const selected = new Map<string, ResourceRef>();
  for (const item of values) {
    if (item && typeof item === 'object' && item.halfChecked) continue;
    const key = typeof item === 'string' ? item : item?.value;
    const ref = allowed.get(key);
    if (ref) selected.set(key, ref);
  }
  return [...selected.values()];
}
