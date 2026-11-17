import type { ToDooFilter, ToDooSnapshot } from '../../shared/to-doo-contracts';
import { toDooIdQueryBatches } from './to-doo-query-batches';

/** The picker pages executions; definition lookups never own its cursor. */
export async function hydrateCalendarTaskPickerPage(
  page: ToDooSnapshot,
  request: (url: string) => Promise<unknown>,
  filter: ToDooFilter,
  current: () => boolean,
) {
  if (!current()) return;
  const tasks = new Map(page.tasks.map(task => [task.id, task]));
  const missing = [...new Set(page.occurrences.map(row => row.taskId))]
    .filter(id => !tasks.has(id));
  for (const batch of toDooIdQueryBatches(missing, id => id, ids =>
    '/api/to-doo/state?' + new URLSearchParams({
      kind: 'task', ids: ids.join(','), filter: JSON.stringify(filter), limit: '200',
    }), { maxCount: 200 })) {
    const data = await request(batch.url) as ToDooSnapshot;
    if (!current()) return;
    if (data.datasetId !== page.datasetId) throw Error('资料库已变化，请重新打开安排任务');
    const requested = new Set(batch.values);
    data.tasks.forEach(task => { if (requested.has(task.id)) tasks.set(task.id, task); });
  }
  const lists = new Map(page.lists.map(list => [list.id, list]));
  const missingLists = [...new Set([...tasks.values()].map(task => task.listId)
    .filter((id): id is string => !!id))].filter(id => !lists.has(id));
  for (const batch of toDooIdQueryBatches(missingLists, id => id, ids =>
    '/api/to-doo/state?' + new URLSearchParams({ kind: 'list', ids: ids.join(','), limit: '200' }),
  { maxCount: 200 })) {
    const data = await request(batch.url) as ToDooSnapshot;
    if (!current()) return;
    if (data.datasetId !== page.datasetId) throw Error('资料库已变化，请重新打开安排任务');
    const requested = new Set(batch.values);
    data.lists.forEach(list => { if (requested.has(list.id)) lists.set(list.id, list); });
  }
  if (!current()) return;
  return { ...page, tasks: [...tasks.values()], lists: [...lists.values()] };
}
