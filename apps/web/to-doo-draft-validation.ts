import { toDooEntitySchemas } from '../../shared/to-doo-contracts';
import type { ToDooTaskDraft } from './to-doo-workbench';

export type ToDooDraftPanel = 'title' | 'description' | 'due' | 'priority' | 'list' | 'plan' | 'repeat' | 'reminders' | 'resources' | 'classification' | 'attachments' | 'results' | 'properties';
export type ToDooDraftIssue = {
  panel: ToDooDraftPanel;
  kind: 'task' | 'occurrence' | 'timeBlock';
  entityId: string;
  path: (string | number)[];
  label: string;
  message: string;
};
const panels: Record<string, ToDooDraftPanel> = {
  title: 'title', description: 'description', priority: 'priority', listId: 'list', parentTaskId: 'list',
  recurrence: 'repeat', recurrenceHistory: 'repeat', inheritRecurrence: 'repeat', reminders: 'reminders',
  noteRefs: 'resources', attachments: 'attachments', importance: 'classification', urgentOverride: 'classification',
  criteria: 'results', due: 'due',
};
const labels: Record<string, string> = {
  title: '任务标题', description: '任务说明', interval: '间隔', anchorDate: '开始日期', timeZone: '时区',
  until: '结束日期', count: '最多次数', monthDay: '每月日期', weekOrdinal: '第几个', weekdays: '每周日期',
  excludedDates: '排除这些日期', additionalDates: '额外安排这些日期', estimateMinutes: '预计分钟',
  lagMinutes: '完成后等待（分钟）', durationMinutes: '时长（分钟）', dateEndExclusive: '结束日期（不含）',
  priority: '优先级', listId: '所属目标或清单', sectionId: '分组', blockedReason: '受阻原因',
  criteria: '完成标准', source: '来源资料', dependencies: '前置任务', tagIds: '标签',
  offsetMinutes: '提前或延后（分钟）', allDayTime: '全天提醒时间', noteRefs: '关联资料', attachments: '任务附件',
};

/** Validate edit values before they reach the stricter recovery and command schemas. */
export function validateToDooTaskDraft(
  draft: ToDooTaskDraft | null | undefined,
  options: { panel?: ToDooDraftPanel; allowEmptyTitle?: boolean } = {},
): ToDooDraftIssue[] {
  if (!draft) return [];
  // Optional picker blanks and a new block's missing server revision are valid edit states.
  // Work on a copy: validation must never silently rewrite a user's input.
  const copy = JSON.parse(JSON.stringify(draft)) as ToDooTaskDraft;
  if (options.allowEmptyTitle && typeof copy.task.title === 'string' && !copy.task.title.trim()) copy.task.title = '草稿';
  for (const rule of [copy.task.recurrence, ...copy.task.recurrenceHistory]) {
    if (!rule) continue;
    if ((rule.time as unknown) === '') rule.time = null;
    if ((rule.until as unknown) === '') rule.until = null;
  }
  const issues: ToDooDraftIssue[] = [];
  function add(kind: ToDooDraftIssue['kind'], entityId: string, path: (string | number)[], message?: string) {
    const field = String(path[0] || ''), leaf = String(typeof path[path.length - 1] === 'number' ? path[path.length - 2] : path[path.length - 1] || field);
    const panel = kind === 'timeBlock' ? 'plan' : panels[field] || 'properties';
    const label = leaf === 'date' ? (panel === 'due' ? '截止日期' : '日期')
      : leaf === 'time' ? (panel === 'repeat' ? '重复时间' : panel === 'due' ? '截止时间' : '时间')
      : leaf === 'timeZone' && panel === 'due' ? '截止时区' : labels[leaf] || labels[field] || '输入内容';
    if (options.panel && options.panel !== panel) return;
    if (!issues.some(issue => issue.kind === kind && issue.entityId === entityId && issue.path.join('.') === path.join('.')))
      issues.push({ panel, kind, entityId, path, label, message: message || '请检查' + label + '，填写有效值后再保存' });
  }
  const entities = [
    { kind: 'task' as const, entity: copy.task, schema: toDooEntitySchemas.task },
    ...(copy.occurrence ? [{ kind: 'occurrence' as const, entity: copy.occurrence, schema: toDooEntitySchemas.occurrence }] : []),
    ...copy.blocks.map(entity => ({ kind: 'timeBlock' as const, entity: { ...entity, revision: entity.revision === '' ? 'draft' : entity.revision }, schema: toDooEntitySchemas.timeBlock })),
  ];
  for (const { kind, entity, schema } of entities) {
    const result = schema.safeParse(entity);
    if (!result.success) for (const issue of result.error.issues) add(kind, entity.id, issue.path.filter((part): part is string | number => typeof part === 'string' || typeof part === 'number'));
  }
  if (!options.allowEmptyTitle && typeof copy.task.title === 'string' && !copy.task.title.trim())
    add('task', copy.task.id, ['title'], '请填写任务标题');
  // Schema defaults describe incoming entities, not a cleared required editor.
  const interval = draft.task.recurrence?.interval;
  if (draft.task.recurrence && (!Number.isInteger(interval) || interval! < 1 || interval! > 1000))
    add('task', draft.task.id, ['recurrence', 'interval']);
  draft.task.dependencies.forEach((dependency, index) => {
    if (!Number.isInteger(dependency.lagMinutes) || dependency.lagMinutes < 0)
      add('task', draft.task.id, ['dependencies', index, 'lagMinutes']);
  });
  draft.blocks.forEach(block => {
    if (!Number.isInteger(block.durationMinutes) || block.durationMinutes <= 0 || block.durationMinutes > 525600)
      add('timeBlock', block.id, ['durationMinutes']);
  });
  return issues;
}
