import type {
  ToDooDateTime,
  ToDooEntityMap,
  ToDooSnapshot,
} from '../../../shared/to-doo-contracts.js';
import { addDays, dateTimeInstant } from './recurrence.js';

export type ToDooPlanningData = Pick<ToDooSnapshot, 'tasks' | 'occurrences' | 'timeBlocks'>;
export type ToDooScheduleChange = {
  occurrenceId: string;
  expectedRevision: string;
  start: ToDooDateTime;
  durationMinutes: number;
  blockId?: string;
  expectedBlockRevision?: string;
  allDay?: boolean;
  dateEndExclusive?: string | null;
};
export type PlanningIssueCode =
  | 'invalid_change'
  | 'missing_occurrence'
  | 'inactive_occurrence'
  | 'stale_occurrence'
  | 'missing_block'
  | 'stale_block'
  | 'duplicate_block'
  | 'overlap'
  | 'dependency_unverifiable'
  | 'dependency_ambiguous'
  | 'dependency_cycle'
  | 'dependency_timing'
  | 'scope_required'
  | 'planning_limit'
  | 'time_unrepresentable';
export type PlanningIssue = {
  code: PlanningIssueCode;
  message: string;
  occurrenceId?: string;
  otherOccurrenceId?: string;
  taskId?: string;
  blockId?: string;
  otherBlockId?: string;
  changeIndex?: number;
};
export type ToDooPlanningOptions = {
  maxAffected?: number;
  maxChanges?: number;
  allowedTaskIds?: readonly string[];
};
export type ToDooPlanningResult = {
  changes: ToDooScheduleChange[];
  conflicts: string[];
  issues: PlanningIssue[];
  affectedOccurrenceIds: string[];
  expectedRevisions: Record<string, string>;
};
type Task = ToDooEntityMap['task'];
type Occurrence = ToDooEntityMap['occurrence'];
type Block = ToDooEntityMap['timeBlock'];
type Interval = {
  start: number;
  end: number;
  occurrenceId: string | null;
  blockId: string | null;
  changeIndex: number | null;
};
const terminal = new Set(['done', 'cancelled', 'skipped']);
const dayNumber = (date: string) => Date.parse(date + 'T00:00:00Z') / 86400000;
function validDateTime(value: ToDooDateTime) {
  if (
    !value ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value.date) ||
    !Number.isFinite(Date.parse(value.date + 'T00:00:00Z')) ||
    new Date(value.date + 'T00:00:00Z').toISOString().slice(0, 10) !== value.date ||
    (value.time !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time))
  )
    throw new Error('invalid time');
  new Intl.DateTimeFormat('en', { timeZone: value.timeZone });
}
function toLocal(at: number, timeZone: string, allDay = false): ToDooDateTime {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(at))
      .map((part) => [part.type, part.value]),
  );
  const result = {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: allDay ? null : `${parts.hour}:${parts.minute}`,
    timeZone,
  };
  validDateTime(result);
  if (dateTimeInstant(result, '00:00').getTime() !== at)
    throw new Error('The requested instant is ambiguous in the stored local-time representation');
  return result;
}
function interval(
  start: ToDooDateTime,
  duration: number,
  allDay: boolean,
  endDate?: string | null,
): Pick<Interval, 'start' | 'end'> {
  validDateTime(start);
  if (!Number.isInteger(duration) || duration <= 0 || duration > 525600)
    throw new Error('invalid duration');
  if (allDay && start.time !== null) throw new Error('all-day value needs a date');
  const instant = dateTimeInstant(start, '00:00').getTime();
  const end = allDay
    ? dateTimeInstant(
        {
          date: endDate ?? addDays(start.date, Math.max(1, Math.ceil(duration / 1440))),
          time: null,
          timeZone: start.timeZone,
        },
        '00:00',
      ).getTime()
    : instant + duration * 60000;
  if (!Number.isFinite(end) || end <= instant) throw new Error('invalid interval');
  return { start: instant, end };
}

function context(
  data: ToDooPlanningData,
  input: readonly ToDooScheduleChange[],
  options: ToDooPlanningOptions,
) {
  const tasks = new Map(
    data.tasks.filter((task) => !task.deletedAt).map((task) => [task.id, task]),
  );
  const occurrences = new Map(
    data.occurrences.filter((item) => !item.deletedAt).map((item) => [item.id, item]),
  );
  const blocks = new Map(
    data.timeBlocks.filter((item) => !item.deletedAt).map((item) => [item.id, item]),
  );
  const deletedOccurrenceIds = new Set(
      data.occurrences.filter((item) => item.deletedAt).map((item) => item.id),
    ),
    deletedTaskIds = new Set(data.tasks.filter((task) => task.deletedAt).map((task) => task.id));
  const allowed = options.allowedTaskIds ? new Set(options.allowedTaskIds) : null;
  const maxAffected = Math.max(1, Math.min(options.maxAffected ?? 1000, 2000)),
    maxChanges = Math.max(1, Math.min(options.maxChanges ?? 1000, 10000));
  const issues: PlanningIssue[] = [],
    issueKeys = new Set<string>(),
    expectedRevisions: Record<string, string> = {};
  const isAllowed = (taskId: string) => !allowed || allowed.has(taskId);
  function issue(value: PlanningIssue) {
    const key = JSON.stringify(value);
    if (!issueKeys.has(key)) {
      issueKeys.add(key);
      issues.push(value);
    }
  }
  const rememberTask = (task: Task) => {
    if (isAllowed(task.id)) expectedRevisions['task:' + task.id] = task.revision;
  };
  const rememberOccurrence = (item: Occurrence) => {
    if (isAllowed(item.taskId)) {
      expectedRevisions['occurrence:' + item.id] = item.revision;
      const task = tasks.get(item.taskId);
      if (task) rememberTask(task);
    }
  };
  const canRevealInterval = (item: Interval) =>
    !allowed ||
    (!!item.occurrenceId &&
      !!occurrences.get(item.occurrenceId) &&
      isAllowed(occurrences.get(item.occurrenceId)!.taskId));
  const rememberBlock = (item: Block) => {
    if (
      !allowed ||
      (!!item.occurrenceId && isAllowed(occurrences.get(item.occurrenceId)?.taskId ?? ''))
    )
      expectedRevisions['timeBlock:' + item.id] = item.revision;
  };
  if (input.length > maxChanges)
    issue({ code: 'planning_limit', message: '提议变更超出单次规划上限，请缩小范围' });
  const changes: ToDooScheduleChange[] = [],
    replaced = new Set<string>(),
    candidateIntervals: Interval[] = [];
  input.slice(0, maxChanges).forEach((raw, index) => {
    const change = { ...raw, start: { ...raw.start } };
    const item = occurrences.get(change.occurrenceId);
    if (!item || !tasks.has(item.taskId)) {
      issue({
        code: 'missing_occurrence',
        message: '候选实例不存在或尚未完整同步',
        occurrenceId: change.occurrenceId,
        changeIndex: index,
      });
      changes.push(change);
      return;
    }
    if (!isAllowed(item.taskId)) {
      issue({
        code: 'scope_required',
        message: '规划包含授权范围之外的行动，需先核对权限',
        changeIndex: index,
      });
      return;
    }
    rememberOccurrence(item);
    if (terminal.has(item.status))
      issue({
        code: 'inactive_occurrence',
        message: '已完成、取消或跳过的实例不能加入安排',
        occurrenceId: item.id,
        changeIndex: index,
      });
    if (item.revision !== change.expectedRevision)
      issue({
        code: 'stale_occurrence',
        message: '候选实例版本已变化，请重新预览',
        occurrenceId: item.id,
        changeIndex: index,
      });
    const referenced = change.blockId ? blocks.get(change.blockId) : undefined;
    const prior = referenced?.occurrenceId === item.id ? referenced : undefined;
    if (change.blockId) {
      if (!prior || prior.occurrenceId !== item.id)
        issue({
          code: 'missing_block',
          message: '待移动的原时间块不存在或不属于该实例',
          occurrenceId: item.id,
          blockId: change.blockId,
          changeIndex: index,
        });
      else {
        rememberBlock(prior);
        if (replaced.has(prior.id))
          issue({
            code: 'duplicate_block',
            message: '同一时间块不能在一个方案中重复修改',
            occurrenceId: item.id,
            blockId: prior.id,
          });
        replaced.add(prior.id);
        if (!change.expectedBlockRevision || change.expectedBlockRevision !== prior.revision)
          issue({
            code: 'stale_block',
            message: '原时间块版本已变化或缺少预期版本，请重新预览',
            occurrenceId: item.id,
            blockId: prior.id,
            changeIndex: index,
          });
      }
    } else if (change.expectedBlockRevision)
      issue({
        code: 'invalid_change',
        message: '时间块预期版本必须和原时间块 ID 一同提交',
        occurrenceId: item.id,
        changeIndex: index,
      });
    try {
      const allDay = change.allDay ?? prior?.allDay ?? change.start.time === null;
      if (allDay) {
        const span =
          prior?.allDay && prior.dateEndExclusive
            ? dayNumber(prior.dateEndExclusive) - dayNumber(prior.start.date)
            : Math.max(1, Math.ceil(change.durationMinutes / 1440));
        change.allDay = true;
        change.dateEndExclusive = change.dateEndExclusive ?? addDays(change.start.date, span);
      }
      candidateIntervals.push({
        ...interval(change.start, change.durationMinutes, allDay, change.dateEndExclusive),
        occurrenceId: item.id,
        blockId: change.blockId ?? null,
        changeIndex: changes.length,
      });
    } catch {
      issue({
        code: 'invalid_change',
        message: '候选日期、时区或时间区间无法解释，请核对安排',
        occurrenceId: item.id,
        changeIndex: index,
      });
    }
    changes.push(change);
  });
  const existingIntervals: Interval[] = [];
  for (const block of blocks.values()) {
    if (replaced.has(block.id)) continue;
    if (
      block.occurrenceId &&
      (deletedOccurrenceIds.has(block.occurrenceId) ||
        deletedTaskIds.has(occurrences.get(block.occurrenceId)?.taskId ?? ''))
    )
      continue;
    try {
      existingIntervals.push({
        ...interval(block.start, block.durationMinutes, block.allDay, block.dateEndExclusive),
        occurrenceId: block.occurrenceId,
        blockId: block.id,
        changeIndex: null,
      });
    } catch {
      if (input.some((change) => change.occurrenceId === block.occurrenceId))
        issue({
          code: 'invalid_change',
          message: '该实例原有时间块无法解释，需先核对原数据',
          occurrenceId: block.occurrenceId ?? undefined,
          blockId: block.id,
        });
    }
  }
  const allIntervals = [...existingIntervals, ...candidateIntervals],
    byOccurrence = new Map<string, Interval[]>();
  for (const value of allIntervals)
    if (value.occurrenceId) {
      const group = byOccurrence.get(value.occurrenceId) ?? [];
      group.push(value);
      byOccurrence.set(value.occurrenceId, group);
    }
  const byTask = new Map<string, Occurrence[]>();
  for (const item of occurrences.values()) {
    const group = byTask.get(item.taskId) ?? [];
    group.push(item);
    byTask.set(item.taskId, group);
  }
  const originalPeriod = (item: Occurrence) =>
    item.cycleKey.match(/(?:^|:)(\d{4}-\d{2}-\d{2})$/)?.[1] ?? item.scheduledDate;
  function predecessor(
    successor: Occurrence,
    taskId: string,
  ): {
    value?: Occurrence;
    code?: 'dependency_unverifiable' | 'dependency_ambiguous' | 'scope_required';
  } {
    if (!isAllowed(taskId)) return { code: 'scope_required' };
    if (!tasks.has(taskId)) return { code: 'dependency_unverifiable' };
    const values = (byTask.get(taskId) ?? []).filter(
      (item) => !['cancelled', 'skipped'].includes(item.status),
    );
    const sameCycle = values.filter((item) => item.cycleKey === successor.cycleKey);
    if (sameCycle.length === 1) return { value: sameCycle[0] };
    if (sameCycle.length > 1) return { code: 'dependency_ambiguous' };
    const period = originalPeriod(successor),
      samePeriod = period ? values.filter((item) => originalPeriod(item) === period) : [];
    if (samePeriod.length === 1) return { value: samePeriod[0] };
    if (samePeriod.length > 1) return { code: 'dependency_ambiguous' };
    return values.length === 1
      ? { value: values[0] }
      : { code: values.length ? 'dependency_ambiguous' : 'dependency_unverifiable' };
  }
  function dependencyIssue(
    item: Occurrence,
    code: 'dependency_unverifiable' | 'dependency_ambiguous' | 'scope_required',
  ) {
    issue({
      code,
      message:
        code === 'scope_required'
          ? '前置或后续行动超出授权范围，不能扩张规划'
          : code === 'dependency_ambiguous'
            ? '前置依赖有多个周期，无法唯一核对本次发生'
            : '前置依赖没有可核对的完成时刻或计划结束',
      occurrenceId: item.id,
    });
  }
  function finish(item: Occurrence): number | null {
    rememberOccurrence(item);
    if (item.status === 'done') {
      const value = item.completedAt ? Date.parse(item.completedAt) : NaN;
      return Number.isFinite(value) ? value : null;
    }
    if (terminal.has(item.status)) return null;
    const values = byOccurrence.get(item.id) ?? [];
    for (const value of values)
      if (value.blockId) {
        const block = blocks.get(value.blockId);
        if (block) rememberBlock(block);
      }
    return values.length ? Math.max(...values.map((value) => value.end)) : null;
  }
  const seedTasks = new Set(
    changes
      .map((change) => occurrences.get(change.occurrenceId)?.taskId)
      .filter((id): id is string => !!id && isAllowed(id)),
  );
  const reverse = new Map<string, Set<string>>();
  for (const task of tasks.values())
    for (const dep of task.dependencies) {
      const set = reverse.get(dep.taskId) ?? new Set<string>();
      set.add(task.id);
      reverse.set(dep.taskId, set);
    }
  const forward = new Set(seedTasks),
    queue = [...seedTasks];
  for (let index = 0; index < queue.length; index++)
    for (const successor of reverse.get(queue[index]) ?? []) {
      if (!isAllowed(successor)) {
        issue({ code: 'scope_required', message: '联动的后续行动超出授权范围，请先核对权限' });
        continue;
      }
      if (forward.has(successor)) continue;
      if (forward.size >= maxAffected) {
        issue({ code: 'planning_limit', message: '后续依赖链超出单次规划上限，请缩小范围' });
        break;
      }
      forward.add(successor);
      queue.push(successor);
    }
  const graph = new Set(forward),
    ancestors = [...forward];
  for (let index = 0; index < ancestors.length; index++) {
    const task = tasks.get(ancestors[index]);
    if (!task) continue;
    rememberTask(task);
    for (const dep of task.dependencies) {
      if (!isAllowed(dep.taskId)) {
        issue({ code: 'scope_required', message: '前置依赖超出授权范围，无法核对安排' });
        continue;
      }
      if (!tasks.has(dep.taskId) || graph.has(dep.taskId)) continue;
      if (graph.size >= maxAffected) {
        issue({ code: 'planning_limit', message: '前置依赖链超出单次规划上限，请缩小范围' });
        break;
      }
      graph.add(dep.taskId);
      ancestors.push(dep.taskId);
    }
  }
  const degree = new Map<string, number>();
  for (const id of graph)
    degree.set(
      id,
      new Set(
        tasks
          .get(id)
          ?.dependencies.filter((dep) => graph.has(dep.taskId))
          .map((dep) => dep.taskId) ?? [],
      ).size,
    );
  const ready = [...graph].filter((id) => degree.get(id) === 0).sort(),
    order: string[] = [];
  for (let index = 0; index < ready.length; index++) {
    const id = ready[index];
    order.push(id);
    for (const successor of reverse.get(id) ?? [])
      if (graph.has(successor)) {
        const value = (degree.get(successor) ?? 0) - 1;
        degree.set(successor, value);
        if (value === 0) ready.push(successor);
      }
  }
  if (order.length < graph.size)
    issue({ code: 'dependency_cycle', message: '依赖存在循环，无法计算后续安排' });
  const affected = new Set(
    changes
      .map((change) => change.occurrenceId)
      .filter((id) => {
        const item = occurrences.get(id);
        return !!item && isAllowed(item.taskId);
      }),
  );
  for (const taskId of order) {
    if (!forward.has(taskId)) continue;
    const task = tasks.get(taskId)!;
    for (const item of byTask.get(taskId) ?? []) {
      if (terminal.has(item.status) || affected.has(item.id)) continue;
      for (const dep of task.dependencies) {
        const prior = predecessor(item, dep.taskId);
        if (prior.value && affected.has(prior.value.id)) {
          affected.add(item.id);
          break;
        }
        if (prior.code && [...affected].some((id) => occurrences.get(id)?.taskId === dep.taskId)) {
          affected.add(item.id);
          dependencyIssue(item, prior.code);
          break;
        }
      }
      if (affected.size > maxAffected) {
        issue({ code: 'planning_limit', message: '受影响实例超过单次规划上限，请缩小日期区间' });
        break;
      }
    }
  }
  return {
    tasks,
    occurrences,
    blocks,
    changes,
    issues,
    expectedRevisions,
    candidateIntervals,
    existingIntervals,
    byOccurrence,
    byTask,
    affected,
    order,
    maxChanges,
    isAllowed,
    canRevealInterval,
    issue,
    rememberOccurrence,
    rememberBlock,
    predecessor,
    dependencyIssue,
    finish,
  };
}
function validateContext(ctx: ReturnType<typeof context>) {
  for (let index = 0; index < ctx.candidateIntervals.length; index++) {
    const candidate = ctx.candidateIntervals[index];
    for (let otherIndex = index + 1; otherIndex < ctx.candidateIntervals.length; otherIndex++) {
      const other = ctx.candidateIntervals[otherIndex];
      if (candidate.start < other.end && other.start < candidate.end)
        ctx.issue({
          code: 'overlap',
          message: `候选安排 ${(candidate.changeIndex ?? 0) + 1} 与 ${(other.changeIndex ?? 0) + 1} 的时间重叠`,
          occurrenceId: candidate.occurrenceId ?? undefined,
          otherOccurrenceId: other.occurrenceId ?? undefined,
          blockId: candidate.blockId ?? undefined,
          otherBlockId: other.blockId ?? undefined,
        });
    }
    for (const other of ctx.existingIntervals)
      if (candidate.start < other.end && other.start < candidate.end) {
        const visible = ctx.canRevealInterval(other);
        if (visible && other.blockId) {
          const block = ctx.blocks.get(other.blockId);
          if (block) ctx.rememberBlock(block);
        }
        ctx.issue({
          code: 'overlap',
          message: `候选安排 ${(candidate.changeIndex ?? 0) + 1} 与已有安排的时间重叠`,
          occurrenceId: candidate.occurrenceId ?? undefined,
          otherOccurrenceId: visible ? (other.occurrenceId ?? undefined) : undefined,
          blockId: candidate.blockId ?? undefined,
          otherBlockId: visible ? (other.blockId ?? undefined) : undefined,
        });
      }
  }
  for (const id of ctx.affected) {
    const item = ctx.occurrences.get(id);
    if (!item || terminal.has(item.status)) continue;
    const task = ctx.tasks.get(item.taskId),
      values = ctx.byOccurrence.get(id) ?? [];
    if (!task || !values.length) continue;
    ctx.rememberOccurrence(item);
    for (const value of values)
      if (value.blockId) {
        const block = ctx.blocks.get(value.blockId);
        if (block) ctx.rememberBlock(block);
      }
    const start = Math.min(...values.map((value) => value.start));
    for (const dep of task.dependencies) {
      const prior = ctx.predecessor(item, dep.taskId);
      if (!prior.value) {
        ctx.dependencyIssue(item, prior.code ?? 'dependency_unverifiable');
        continue;
      }
      const finish = ctx.finish(prior.value);
      if (finish === null || !Number.isInteger(dep.lagMinutes) || dep.lagMinutes < 0) {
        ctx.dependencyIssue(item, 'dependency_unverifiable');
        continue;
      }
      if (start < finish + dep.lagMinutes * 60000)
        ctx.issue({
          code: 'dependency_timing',
          message: `“${task.title}”应在前置完成后至少 ${dep.lagMinutes} 分钟开始`,
          occurrenceId: item.id,
          otherOccurrenceId: prior.value.id,
          taskId: task.id,
        });
    }
  }
}
function result(ctx: ReturnType<typeof context>): ToDooPlanningResult {
  return {
    changes: ctx.changes,
    conflicts: [...new Set(ctx.issues.map((issue) => issue.message))],
    issues: ctx.issues,
    affectedOccurrenceIds: [...ctx.affected].sort(),
    expectedRevisions: ctx.expectedRevisions,
  };
}

/** Pure validation; every candidate is included before overlaps and finish-to-start constraints are checked. */
export function validateToDooPlan(
  data: ToDooPlanningData,
  changes: readonly ToDooScheduleChange[],
  options: ToDooPlanningOptions = {},
): ToDooPlanningResult {
  const ctx = context(data, changes, options);
  validateContext(ctx);
  return result(ctx);
}

/** Pure, explicit forward adjustment. It never writes data or chooses a free slot behind the user's back. */
export function previewToDooDependentAdjustment(
  data: ToDooPlanningData,
  input: readonly ToDooScheduleChange[],
  options: ToDooPlanningOptions = {},
): ToDooPlanningResult {
  let ctx = context(data, input, options);
  const direct = new Set(ctx.changes.map((change) => change.occurrenceId)),
    changes = [...ctx.changes];
  if (
    ctx.issues.some((issue) =>
      [
        'dependency_cycle',
        'planning_limit',
        'scope_required',
        'missing_occurrence',
        'inactive_occurrence',
        'stale_occurrence',
        'missing_block',
        'stale_block',
        'invalid_change',
        'duplicate_block',
      ].includes(issue.code),
    )
  ) {
    validateContext(ctx);
    return result(ctx);
  }
  const extraIssues: PlanningIssue[] = [];
  for (const taskId of ctx.order) {
    for (const id of [...ctx.affected]) {
      const item = ctx.occurrences.get(id);
      if (!item || item.taskId !== taskId || direct.has(id) || terminal.has(item.status)) continue;
      const task = ctx.tasks.get(taskId)!;
      const values = ctx.byOccurrence.get(id) ?? [];
      if (!values.length) {
        extraIssues.push({
          code: 'dependency_unverifiable',
          message: '后续实例尚无安排，无法自动联动；请先明确其时间块',
          occurrenceId: id,
        });
        continue;
      }
      let required = -Infinity,
        verified = true;
      for (const dep of task.dependencies) {
        const prior = ctx.predecessor(item, dep.taskId),
          finish = prior.value ? ctx.finish(prior.value) : null;
        if (
          !prior.value ||
          finish === null ||
          !Number.isInteger(dep.lagMinutes) ||
          dep.lagMinutes < 0
        ) {
          extraIssues.push({
            code: prior.code ?? 'dependency_unverifiable',
            message: '后续行动的前置结束无法核对，未自动创建或移动安排',
            occurrenceId: id,
          });
          verified = false;
          continue;
        }
        required = Math.max(required, finish + dep.lagMinutes * 60000);
      }
      if (!verified) continue;
      const earliest = Math.min(...values.map((value) => value.start));
      let shift = Math.max(0, Math.ceil((required - earliest) / 60000) * 60000);
      if (!shift) continue;
      const allDayAnchor = values.find(
        (value) => !!value.blockId && ctx.blocks.get(value.blockId)?.allDay,
      );
      if (allDayAnchor) {
        try {
          const block = ctx.blocks.get(allDayAnchor.blockId!)!,
            local = toLocal(allDayAnchor.start + shift, block.start.timeZone);
          if (local.time !== '00:00')
            shift =
              dateTimeInstant(
                { date: addDays(local.date, 1), time: null, timeZone: block.start.timeZone },
                '00:00',
              ).getTime() - allDayAnchor.start;
        } catch {
          extraIssues.push({
            code: 'time_unrepresentable',
            message: '全天后续无法在当前时区边界无损移动，请手动核对',
            occurrenceId: id,
          });
          continue;
        }
      }
      const adjusted: ToDooScheduleChange[] = [];
      let representable = true;
      for (const value of values) {
        const block = value.blockId ? ctx.blocks.get(value.blockId) : undefined;
        if (!block) {
          representable = false;
          break;
        }
        try {
          const start = toLocal(value.start + shift, block.start.timeZone, block.allDay);
          const changed: ToDooScheduleChange = {
            occurrenceId: id,
            expectedRevision: item.revision,
            blockId: block.id,
            expectedBlockRevision: block.revision,
            start,
            durationMinutes: block.durationMinutes,
          };
          if (block.allDay) {
            changed.allDay = true;
            changed.dateEndExclusive = addDays(
              start.date,
              block.dateEndExclusive
                ? dayNumber(block.dateEndExclusive) - dayNumber(block.start.date)
                : Math.max(1, Math.ceil(block.durationMinutes / 1440)),
            );
          }
          const span = interval(
            changed.start,
            changed.durationMinutes,
            block.allDay,
            changed.dateEndExclusive,
          );
          if (span.end - span.start !== value.end - value.start)
            throw new Error('calendar-day duration differs');
          adjusted.push(changed);
        } catch {
          representable = false;
          break;
        }
      }
      if (!representable) {
        extraIssues.push({
          code: 'time_unrepresentable',
          message: '后续区间跨越无法无损表达的夏令时或全天边界，请手动核对',
          occurrenceId: id,
        });
        continue;
      }
      if (changes.length + adjusted.length > ctx.maxChanges) {
        extraIssues.push({
          code: 'planning_limit',
          message: '联动时间块超过单次变更上限，请缩小范围',
        });
        break;
      }
      changes.push(...adjusted);
      ctx = context(data, changes, options);
    }
  }
  ctx = context(data, changes, options);
  for (const issue of extraIssues) ctx.issue(issue);
  validateContext(ctx);
  return result(ctx);
}
