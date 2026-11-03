import type { ToDooEntityMap } from '../../shared/to-doo-contracts';
import type { ToDooItem, ToDooWorkbench } from './to-doo-workbench';

type Task = ToDooEntityMap['task'];
type Section = ToDooEntityMap['section'];
export type TaskSectionPlacement = { beforeId?: string; afterId?: string };
export type TaskItemGroup = {
  id: string;
  name: string;
  section?: Section;
  items: ToDooItem[];
  showHeader: boolean;
};

export function taskSectionIds(tasks: readonly Task[]) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const resolved = new Map<string, string | null>();
  for (const task of tasks) {
    const path: string[] = [];
    const seen = new Set<string>();
    let current: Task | undefined = task;
    let sectionId: string | null = null;
    while (current) {
      if (resolved.has(current.id)) {
        sectionId = resolved.get(current.id)!;
        break;
      }
      if (seen.has(current.id)) break;
      seen.add(current.id);
      path.push(current.id);
      if (current.sectionId) {
        sectionId = current.sectionId;
        break;
      }
      const parentId: string | null = current.parentTaskId;
      current = parentId ? byId.get(parentId) : undefined;
    }
    for (const id of path) resolved.set(id, sectionId);
  }
  return resolved;
}

export function taskSectionId(task: Task, tasks: readonly Task[]) {
  return (
    taskSectionIds(tasks.some((value) => value.id === task.id) ? tasks : [...tasks, task]).get(
      task.id,
    ) ?? null
  );
}

export function groupTaskItems(
  items: ToDooItem[],
  tasks: readonly Task[],
  sections: readonly Section[],
  listId?: string,
): TaskItemGroup[] {
  if (!listId) return [{ id: 'all', name: '待办任务', items, showHeader: false }];
  const groups = sections
    .filter((section) => !section.deletedAt && section.listId === listId)
    .sort((a, b) => a.orderKey.localeCompare(b.orderKey) || a.id.localeCompare(b.id))
    .map((section) => ({
      id: section.id,
      name: section.name,
      section,
      items: [] as ToDooItem[],
      showHeader: true,
    }));
  const byId = new Map<string | null, TaskItemGroup>(groups.map((group) => [group.id, group]));
  const unassigned: TaskItemGroup = {
    id: 'unassigned:' + listId,
    name: '未分组',
    items: [],
    showHeader: !!groups.length,
  };
  const effective = taskSectionIds(tasks);
  for (const item of items)
    (byId.get(effective.get(item.task.id) ?? null) ?? unassigned).items.push(item);
  return [...groups, ...(unassigned.items.length || !groups.length ? [unassigned] : [])];
}

export function boardTaskCards(items: ToDooItem[]) {
  const byKey = new Map(items.map((item) => [item.key, item]));
  const parents = new Map<string, string>();
  for (const item of items) {
    if (!item.task.parentTaskId) continue;
    let candidates = items.filter((parent) => parent.task.id === item.task.parentTaskId);
    if (item.occurrence?.parentOccurrenceId)
      candidates = candidates.filter(
        (parent) => parent.occurrence?.id === item.occurrence!.parentOccurrenceId,
      );
    else if (candidates.length > 1)
      candidates = candidates.filter(
        (parent) =>
          parent.occurrence?.scheduledDate &&
          parent.occurrence.scheduledDate === item.occurrence?.scheduledDate,
      );
    if (candidates.length === 1 && candidates[0].key !== item.key)
      parents.set(item.key, candidates[0].key);
  }
  const rootKey = (key: string) => {
    const seen = new Set([key]);
    while (parents.has(key)) {
      const next = parents.get(key)!;
      if (seen.has(next)) return [...seen].sort()[0];
      seen.add(next);
      key = next;
    }
    return key;
  };
  const cards = new Map<string, { item: ToDooItem; children: ToDooItem[] }>();
  for (const item of items) {
    const key = rootKey(item.key);
    if (!cards.has(key)) cards.set(key, { item: byKey.get(key)!, children: [] });
    if (item.key !== key) cards.get(key)!.children.push(item);
  }
  return [...cards.values()];
}

async function readSections(model: Pick<ToDooWorkbench, 'request'>, listId: string) {
  const sections: Section[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined, version: string | undefined;
  do {
    const query = new URLSearchParams({ kind: 'section', listIds: listId, limit: '500' });
    if (cursor) query.set('cursor', cursor);
    const page = await model.request('/api/to-doo/state?' + query.toString());
    version ??= page.version;
    if (version !== page.version) throw Error('分组有更新，请刷新后重试');
    sections.push(
      ...page.sections.filter(
        (section: Section) => !section.deletedAt && section.listId === listId,
      ),
    );
    cursor = page.page?.nextCursor || undefined;
    if (cursor && (seen.has(cursor) || seen.size >= 20))
      throw Error('分组较多，请先完成载入后重试');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return sections.sort((a, b) => a.orderKey.localeCompare(b.orderKey) || a.id.localeCompare(b.id));
}

function orderedSections(
  model: Pick<ToDooWorkbench, 'execute'>,
  sections: Array<Section | { id: string; name: string; listId: string }>,
) {
  return model.execute(
    {
      action: 'import_entities',
      payload: {
        entities: sections.map((section, index) => ({
          kind: 'section' as const,
          entity: { ...section, orderKey: 's' + String(index).padStart(8, '0') },
          ...('revision' in section ? { expectedRevision: section.revision } : {}),
        })),
      },
    },
    '分组已保存',
  );
}

export async function saveTaskSection(
  model: Pick<ToDooWorkbench, 'request' | 'execute'>,
  entity: { id?: string; name: string; listId: string },
  placement: TaskSectionPlacement = {},
) {
  const sections = await readSections(model, entity.listId);
  const relative = placement.beforeId ?? placement.afterId;
  let index = relative ? sections.findIndex((section) => section.id === relative) : sections.length;
  if (index < 0) throw Error('相邻分组有更新，请刷新后重试');
  if (placement.afterId) index++;
  const values: Parameters<typeof orderedSections>[1] = [...sections];
  values.splice(index, 0, {
    id: entity.id || crypto.randomUUID(),
    name: entity.name,
    listId: entity.listId,
  });
  return orderedSections(model, values);
}

export async function moveTaskSection(
  model: Pick<ToDooWorkbench, 'request' | 'execute'>,
  section: Section,
  delta: number,
) {
  const sections = await readSections(model, section.listId);
  const index = sections.findIndex((value) => value.id === section.id),
    target = index + delta;
  if (index < 0) throw Error('分组有更新，请刷新后重试');
  if (target < 0 || target >= sections.length) return;
  const [moved] = sections.splice(index, 1);
  sections.splice(target, 0, moved);
  return orderedSections(model, sections);
}
