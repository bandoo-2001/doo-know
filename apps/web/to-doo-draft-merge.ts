import type { ToDooEntityMap } from '../../shared/to-doo-contracts';
import type { ToDooTaskDraft } from './to-doo-workbench';

export type ToDooDraftConflict = {
  id: string;
  draftKey: string;
  kind: 'task' | 'occurrence' | 'timeBlock';
  entityId: string;
  field: string;
  label: string;
  local: unknown;
  remote: unknown;
};

const copy = <T>(value: T): T =>
  value === undefined ? value : JSON.parse(JSON.stringify(value));
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => JSON.stringify(key) + ':' + canonical(entry)).join(',') + '}';
  return JSON.stringify(value) ?? 'undefined';
}
export const sameToDooDraftValue = (left: unknown, right: unknown) =>
  canonical(left) === canonical(right);

const metadata = new Set(['id', 'revision', 'createdAt', 'updatedAt', 'scheduleRevision']);
const labels: Record<string, string> = {
  title: '标题', description: '任务说明', criteria: '完成标准', priority: '优先级',
  importance: '重要程度', noteRefs: '关联资料', attachments: '附件', source: '资料引用',
  tagIds: '标签', listId: '所属清单', parentTaskId: '父任务', sectionId: '任务分组',
  recurrence: '重复规则', due: '截止时间', status: '执行状态', blockedReason: '受阻原因',
  start: '计划时间', durationMinutes: '计划时长', allDay: '全天安排',
  dateEndExclusive: '跨日结束日期', deletedAt: '删除状态', reminders: '提醒',
};

/** Three-way comparison never treats a remote plan array as a replacement for local input. */
export function mergeToDooTaskDraft(
  draftKey: string,
  local: ToDooTaskDraft,
  baseline: ToDooTaskDraft,
  remote: ToDooTaskDraft,
) {
  const conflicts: ToDooDraftConflict[] = [];
  function conflict(kind: ToDooDraftConflict['kind'], entityId: string, field: string,
    mine: unknown, theirs: unknown) {
    conflicts.push({ id: [draftKey, kind, entityId, field].join('\0'), draftKey, kind,
      entityId, field, label: kind === 'timeBlock' ? '时间安排 · ' + (labels[field] || '删除或修改')
        : labels[field] || '其他字段', local: copy(mine), remote: copy(theirs) });
  }
  function merge<T extends { id: string }>(kind: ToDooDraftConflict['kind'], mine: T,
    base: T | undefined, theirs: T): T {
    const result = copy(theirs) as Record<string, unknown>;
    const keys = new Set([...Object.keys(mine), ...Object.keys(base || {}), ...Object.keys(theirs)]);
    for (const field of keys) {
      if (metadata.has(field)) continue;
      const left = (mine as Record<string, unknown>)[field],
        before = (base as Record<string, unknown> | undefined)?.[field],
        right = (theirs as Record<string, unknown>)[field];
      const localChanged = !sameToDooDraftValue(left, before);
      if (localChanged && !sameToDooDraftValue(right, before) && !sameToDooDraftValue(left, right))
        conflict(kind, mine.id, field, left, right);
      if (localChanged) {
        if (left === undefined) delete result[field];
        else result[field] = copy(left);
      }
    }
    return result as T;
  }
  const blocks: ToDooEntityMap['timeBlock'][] = [];
  const localBlocks = new Map(local.blocks.map((block) => [block.id, block]));
  const baseBlocks = new Map(baseline.blocks.map((block) => [block.id, block]));
  const remoteBlocks = new Map(remote.blocks.map((block) => [block.id, block]));
  for (const id of new Set([...baseBlocks.keys(), ...localBlocks.keys(), ...remoteBlocks.keys()])) {
    const mine = localBlocks.get(id), base = baseBlocks.get(id), theirs = remoteBlocks.get(id);
    const localDeleted = !mine || !!mine.deletedAt,
      remoteDeleted = !theirs || !!theirs.deletedAt;
    if (base && localDeleted && remoteDeleted) {
      if (theirs) blocks.push(copy(theirs));
      continue;
    }
    if (base && localDeleted !== remoteDeleted) {
      const surviving = localDeleted ? theirs : mine;
      // A deletion conflicts only when the other writer actually edited that plan.
      const content = (value: typeof surviving) => value && Object.fromEntries(
        Object.entries(value).filter(([field]) => !metadata.has(field) && field !== 'deletedAt'));
      if (!sameToDooDraftValue(content(surviving), content(base))) {
        conflict('timeBlock', id, '$entity', mine || null, theirs || null);
        if (mine) blocks.push(theirs ? { ...copy(mine), revision: theirs.revision,
          createdAt: theirs.createdAt, updatedAt: theirs.updatedAt } : copy(mine));
        continue;
      }
      if (localDeleted) {
        if (theirs) blocks.push({ ...copy(theirs), deletedAt: mine?.deletedAt || new Date().toISOString() });
      } else if (theirs) blocks.push(copy(theirs));
      continue;
    }
    if (mine && theirs) blocks.push(merge('timeBlock', mine, base, theirs));
    else if (mine) blocks.push(copy(mine));
    else if (theirs) blocks.push(copy(theirs));
  }
  return { draft: {
    task: merge('task', local.task, baseline.task, remote.task),
    occurrence: local.occurrence && remote.occurrence
      ? merge('occurrence', local.occurrence, baseline.occurrence || undefined, remote.occurrence)
      : copy(remote.occurrence),
    blocks,
  } satisfies ToDooTaskDraft, conflicts };
}
