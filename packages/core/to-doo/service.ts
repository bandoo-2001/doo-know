import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '../db.js';
import { readKnowledgeDataFile, writeKnowledgeDataFile } from '../knowledge-data.js';
import type { NoteService } from '../notes.js';
import type { AppConfig } from '../../../shared/contracts.js';
import {
  toDooCommandSchema,
  toDooEntitySchemas,
  toDooHabitRuleSchema,
  resolveToDooStatusSelection,
  type ToDooStatusSelectionInput,
  type ToDooEntityKind,
  type ToDooEntity,
  type ToDooEntityMap,
  type ToDooCommandResult,
  type ToDooQuery,
  type ToDooService,
  type ToDooCheckpoint,
  type ToDooTask,
  type ToDooOccurrence,
  type ToDooPlan,
} from '../../../shared/to-doo-contracts.js';
import {
  createToDooStore,
  parseEntity,
  toDooError,
  toDooHash,
  canonical,
  type PendingEntity,
  type ToDooState,
} from './store.js';
import {
  stableToDooId,
  expandRecurrence,
  addDays,
  addMonths,
  localDate,
  dateTimeInstant,
} from './recurrence.js';
import { validateToDooPlan, previewToDooDependentAdjustment } from './planning.js';
import type { ToDooCommandContext } from '../../../shared/to-doo-contracts.js';
import { buildToDooSnapshot } from './queries.js';

function validateRelations(s: ToDooState, changedIds?: Set<string>) {
  const affected = changedIds ?? new Set(s.task.keys());
  if (!affected.size) return;
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const task of s.task.values())
      if (task.parentTaskId && affected.has(task.parentTaskId) && !affected.has(task.id)) {
        affected.add(task.id);
        expanded = true;
      }
  }
  const colors = new Map<string, number>();
  function dependencies(id: string, depth = 0) {
    if (colors.get(id) === 1) toDooError('任务依赖存在循环', 400);
    if (colors.get(id) === 2) return;
    if (depth > 1000) toDooError('依赖链过深，请拆分项目', 400);
    const task = s.task.get(id);
    if (!task || task.deletedAt) return;
    colors.set(id, 1);
    for (const dep of task.dependencies) dependencies(dep.taskId, depth + 1);
    colors.set(id, 2);
  }
  for (const id of affected) {
    const task = s.task.get(id);
    if (!task || task.deletedAt) continue;
    const seen = new Set([id]);
    let current = task,
      depth = 1;
    while (current.parentTaskId) {
      const parent = s.task.get(current.parentTaskId);
      if (!parent || parent.deletedAt) break;
      if (seen.has(parent.id)) toDooError('任务层级存在循环', 400);
      seen.add(parent.id);
      if (parent.listId !== task.listId) toDooError('子树必须位于同一清单', 400);
      current = parent;
      if (++depth > (s.settings.get('settings')?.maxDepth ?? 8))
        toDooError('任务层级超过设置上限', 400);
    }
    dependencies(id);
  }
}

export function createToDooService(
  config: AppConfig,
  db: AppDatabase,
  _notes: NoteService,
): ToDooService {
  const store = createToDooStore(config, db);
  function mutate(
    requestId: string,
    input: unknown,
    operation: (ctx: ReturnType<typeof context>) => string[],
    extra?: {
      receipts?: ToDooCheckpoint['receipts'];
      transactions?: unknown[];
      adoptDatasetId?: string;
    },
  ): ToDooCommandResult {
    const result = store.execute(requestId, input, (state) => {
      const ctx = context(state, requestId);
      const ids = operation(ctx);
      validateRelations(
        state,
        [...ctx.changes.values()].some((c) => c.kind === 'settings')
          ? undefined
          : new Set(
              [...ctx.changes.values()].filter((c) => c.kind === 'task').map((c) => c.entity.id),
            ),
      );
      return {
        changes: [...ctx.changes.values()],
        ids,
        importedReceipts: extra?.receipts,
        importedTransactions: extra?.transactions,
        adoptDatasetId: extra?.adoptDatasetId,
      };
    });
    return {
      transactionId: result.receipt.transactionId,
      replayed: result.replayed,
      changed: result.receipt.changed,
      ids: result.receipt.ids,
      snapshot: snapshot(),
    };
  }
  function context(state: ToDooState, requestId: string) {
    const changes = new Map<string, PendingEntity>(),
      now = new Date().toISOString();
    function get<K extends ToDooEntityKind>(kind: K, id: string): ToDooEntityMap[K] {
      const entity = state[kind].get(id);
      if (!entity) toDooError('项目不存在或尚未同步', 404, 'TO_DOO_NOT_FOUND');
      return entity;
    }
    function check(kind: ToDooEntityKind, id: string, revision: string) {
      const e = get(kind, id);
      if (e.revision !== revision) toDooError('内容版本已变化，请重新核对');
    }
    function put<K extends ToDooEntityKind>(
      kind: K,
      value: Record<string, unknown>,
      expectedRevision?: string | null,
    ): ToDooEntityMap[K] {
      const id = typeof value.id === 'string' ? value.id : randomUUID(),
        current = state[kind].get(id);
      if (expectedRevision !== undefined && (current?.revision ?? null) !== expectedRevision)
        toDooError('内容版本已变化，请重新核对');
      const key = kind + '\0' + id,
        prior = changes.get(key);
      const entity = parseEntity(kind, {
        ...current,
        ...value,
        id,
        revision: randomUUID(),
        createdAt: current?.createdAt ?? value.createdAt ?? now,
        updatedAt: now,
        deletedAt: Object.hasOwn(value, 'deletedAt')
          ? value.deletedAt
          : (current?.deletedAt ?? null),
      });
      (state[kind] as Map<string, ToDooEntity>).set(id, entity);
      changes.set(key, {
        kind,
        entity,
        expectedRevision: prior ? prior.expectedRevision : (current?.revision ?? null),
      });
      return entity;
    }
    function activity(
      action: string,
      entityId: string,
      occurrenceId: string | null = null,
      summary = '',
      reversesId: string | null = null,
    ) {
      return put('activity', {
        id: stableToDooId(requestId, action, entityId, occurrenceId ?? ''),
        action,
        entityId,
        occurrenceId,
        at: now,
        summary,
        reversesId,
        requestId,
      });
    }
    function descendants(ids: string[], include = true): ToDooTask[] {
      const result = new Set(ids);
      if (include) {
        let changed = true;
        while (changed) {
          changed = false;
          for (const t of state.task.values())
            if (t.parentTaskId && result.has(t.parentTaskId) && !result.has(t.id)) {
              result.add(t.id);
              changed = true;
            }
        }
      }
      return [...result].map((id) => get('task', id));
    }
    function recurrenceOwner(task: ToDooTask): ToDooTask | null {
      let current = task;
      const seen = new Set<string>();
      while (true) {
        if (seen.has(current.id)) toDooError('任务层级存在循环', 400);
        seen.add(current.id);
        if (current.recurrence) return current;
        if (!current.inheritRecurrence || !current.parentTaskId) return null;
        const parent = state.task.get(current.parentTaskId);
        if (!parent) return null;
        current = parent;
      }
    }
    function effectiveRule(task: ToDooTask): ToDooTask['recurrence'] {
      return recurrenceOwner(task)?.recurrence ?? null;
    }
    function occurrence(
      task: ToDooTask,
      cycleKey: string,
      date: string | null,
      rule: ToDooTask['recurrence'],
      due?: ToDooOccurrence['due'],
      predecessorId: string | null = null,
    ): ToDooOccurrence {
      const id = stableToDooId(task.id, cycleKey),
        existing = state.occurrence.get(id);
      if (existing) return existing;
      const parent = [...state.occurrence.values()].find(
        (o) => o.taskId === task.parentTaskId && o.cycleKey === cycleKey,
      );
      const exception = [...state.exception.values()].find(
        (e) => e.taskId === task.id && e.cycleKey === cycleKey && !e.deletedAt,
      );
      return put('occurrence', {
        id,
        taskId: task.id,
        cycleKey,
        seriesSegmentId: rule?.id ?? null,
        parentOccurrenceId: parent?.id ?? null,
        status: exception?.kind === 'skip' ? 'skipped' : 'todo',
        scheduledDate: date,
        due:
          exception?.due ??
          due ??
          (date
            ? {
                date,
                time: rule?.time ?? null,
                timeZone: rule?.timeZone ?? state.settings.get('settings')?.timeZone ?? 'UTC',
              }
            : null),
        scheduleRevision: randomUUID(),
        titleOverride: exception?.title ?? null,
        predecessorId,
      });
    }
    function materialize(task: ToDooTask, from: string, to: string): string[] {
      const rule = effectiveRule(task);
      if (!rule) {
        const saved = [...state.occurrence.values()].filter(
          (o) => o.taskId === task.id && o.seriesSegmentId === null && !o.deletedAt,
        );
        return saved.length ? saved.map((o) => o.id) : [occurrence(task, 'once', null, null).id];
      }
      if (rule.frequency === 'after_completion') {
        const existing = [...state.occurrence.values()].filter(
          (o) => o.taskId === task.id && o.seriesSegmentId === rule.id,
        );
        return existing.length
          ? existing.map((o) => o.id)
          : [occurrence(task, rule.id + ':sequence:0', rule.anchorDate, rule).id];
      }
      return expandRecurrence(rule, from, to).map(
        (p) => occurrence(task, p.cycleKey, p.date, rule).id,
      );
    }
    function createTask(value: Record<string, unknown>): ToDooTask {
      const { due, plan, ...fields } = value;
      const task = put('task', fields);
      const rule = effectiveRule(task);
      let occurrenceId: string;
      if (rule) {
        const ids = materialize(task, rule.anchorDate, addDays(rule.anchorDate, 90));
        occurrenceId = ids[0];
      } else
        occurrenceId = occurrence(task, 'once', (due as any)?.date ?? null, null, due as any).id;
      if (plan && occurrenceId)
        put('timeBlock', {
          occurrenceId,
          start: plan,
          durationMinutes:
            task.estimateMinutes ?? state.settings.get('settings')?.defaultDurationMinutes ?? 30,
        });
      return task;
    }
    function statusSelection(input: ToDooStatusSelectionInput) {
      try {
        return resolveToDooStatusSelection(
          { tasks: [...state.task.values()], occurrences: [...state.occurrence.values()] },
          input,
        );
      } catch (error) {
        toDooError(error instanceof Error ? error.message : '无法核对实例选择');
      }
    }
    function checkStatusSelection(
      selection: ReturnType<typeof resolveToDooStatusSelection>,
      frozenIds: readonly string[] | undefined,
      revisions: Record<string, string> | undefined,
    ) {
      if (!frozenIds || !revisions)
        toDooError('状态批量或级联操作需要冻结实例集合与每个成员的预期版本', 400);
      if (new Set(frozenIds).size !== frozenIds.length) toDooError('冻结实例集合不能重复', 400);
      for (const id of frozenIds) {
        const occurrence = get('occurrence', id);
        const revision = revisions[id];
        if (!revision) toDooError('缺少执行实例预期版本：' + id, 400);
        check('occurrence', id, revision);
        const taskRevision = revisions[occurrence.taskId];
        if (!taskRevision) toDooError('缺少任务预期版本：' + occurrence.taskId, 400);
        check('task', occurrence.taskId, taskRevision);
      }
      for (const id of selection.taskIds) {
        const revision = revisions[id];
        if (!revision) toDooError('缺少任务预期版本：' + id, 400);
        check('task', id, revision);
      }
      const actual = new Set(selection.occurrenceIds);
      if (actual.size !== frozenIds.length || frozenIds.some((id) => !actual.has(id)))
        toDooError('实例选择集合已变化，请重新载入并确认');
      for (const id of selection.occurrenceIds) {
        const revision = revisions[id];
        if (!revision) toDooError('缺少执行实例预期版本：' + id, 400);
        check('occurrence', id, revision);
      }
    }
    function applyStatusSelection(
      selection: ReturnType<typeof resolveToDooStatusSelection>,
      status: ToDooOccurrence['status'],
      rootId?: string,
      summary?: string,
      at?: string,
    ) {
      for (const id of selection.leafFirstOccurrenceIds)
        setStatus(id, status, false, id === rootId ? summary : undefined, at, false);
      if (['todo', 'doing', 'blocked'].includes(status)) {
        const explicit = new Set(selection.leafFirstOccurrenceIds);
        for (const id of selection.occurrenceIds)
          if (!explicit.has(id) && get('occurrence', id).status === 'done')
            setStatus(id, 'todo', false, undefined, at, false);
      }
    }
    function setStatus(
      id: string,
      status: ToDooOccurrence['status'],
      cascade: boolean,
      resultSummary?: string,
      at?: string,
      reopenAncestors = true,
    ) {
      let target = get('occurrence', id);
      const task = get('task', target.taskId);
      const execution: ToDooOccurrence[] = [target],
        seen = new Set([target.id]);
      for (const parent of execution)
        for (const candidate of state.occurrence.values()) {
          if (candidate.deletedAt || seen.has(candidate.id)) continue;
          const candidateTask = state.task.get(candidate.taskId);
          const linked = candidate.parentOccurrenceId === parent.id;
          const legacySamePeriod =
            !candidate.parentOccurrenceId &&
            candidateTask?.parentTaskId === parent.taskId &&
            !candidateTask.recurrence &&
            candidate.cycleKey === parent.cycleKey;
          if (linked || legacySamePeriod) {
            seen.add(candidate.id);
            execution.push(candidate);
          }
        }
      const selected = cascade ? execution : [target];
      if (
        !cascade &&
        status === 'done' &&
        execution.slice(1).some((o) => !['done', 'cancelled', 'skipped'].includes(o.status))
      )
        toDooError('父任务仍有未完成子项，请选择完成整棵子树');
      for (const old of selected) {
        if (old.status === status && resultSummary === undefined) continue;
        const completedAt = status === 'done' ? (at ?? now) : null;
        const next = put('occurrence', {
          ...old,
          status,
          completedAt,
          resultSummary: resultSummary ?? old.resultSummary,
          manuallyEdited: true,
        });
        activity(
          status === 'done' ? 'complete' : status === 'todo' ? 'reopen' : status,
          old.taskId,
          old.id,
        );
        const ownTask = get('task', old.taskId),
          owner = recurrenceOwner(ownTask),
          rule = owner?.recurrence;
        if (
          status === 'done' &&
          rule?.frequency === 'after_completion' &&
          !rule.endedAt &&
          owner?.id === ownTask.id &&
          old.seriesSegmentId === rule.id
        ) {
          const baseDate = localDate(new Date(completedAt!), rule.timeZone),
            nextDate =
              rule.completionUnit === 'month'
                ? addMonths(baseDate, rule.interval)!
                : addDays(baseDate, rule.interval * (rule.completionUnit === 'week' ? 7 : 1));
          const cycleKey = rule.id + ':after:' + old.id,
            rootSuccessor = state.occurrence.get(stableToDooId(owner.id, cycleKey));
          const count = [...state.occurrence.values()].filter(
            (o) => o.taskId === owner.id && o.seriesSegmentId === rule.id,
          ).length;
          if (
            (!rule.until || nextDate <= rule.until) &&
            (rootSuccessor || !rule.count || count < rule.count)
          ) {
            const family = descendants([owner.id]).filter(
              (t) => !t.deletedAt && recurrenceOwner(t)?.id === owner.id,
            );
            const depth = (task: ToDooTask) => {
              let n = 0,
                current = task;
              while (current.id !== owner.id && current.parentTaskId) {
                n++;
                current = get('task', current.parentTaskId);
              }
              return n;
            };
            family.sort((a, b) => depth(a) - depth(b));
            const familyDate =
              rootSuccessor && (rootSuccessor.manuallyEdited || rootSuccessor.status !== 'todo')
                ? (rootSuccessor.scheduledDate ?? nextDate)
                : nextDate;
            for (const member of family) {
              const previous = [...state.occurrence.values()].find(
                  (o) => o.taskId === member.id && o.cycleKey === old.cycleKey && !o.deletedAt,
                ),
                existing = state.occurrence.get(stableToDooId(member.id, cycleKey));
              if (!existing)
                occurrence(member, cycleKey, familyDate, rule, undefined, previous?.id ?? null);
              else if (!existing.manuallyEdited && existing.status === 'todo')
                put('occurrence', {
                  ...existing,
                  scheduledDate: familyDate,
                  due: { date: familyDate, time: rule.time, timeZone: rule.timeZone },
                  scheduleRevision: randomUUID(),
                });
            }
          }
        }
      }
      if (reopenAncestors && status !== 'done' && status !== 'cancelled' && status !== 'skipped') {
        let parent = target.parentOccurrenceId;
        while (parent) {
          const p = get('occurrence', parent);
          if (p.status === 'done')
            put('occurrence', { ...p, status: 'todo', completedAt: null, manuallyEdited: true });
          parent = p.parentOccurrenceId;
        }
      }
    }
    function changeRule(
      taskId: string,
      ruleInput: ToDooTask['recurrence'],
      scope: 'all' | 'future',
      fromDate?: string,
    ): ToDooTask {
      const task = get('task', taskId),
        from =
          scope === 'future'
            ? (fromDate ?? localDate(new Date(), ruleInput?.timeZone ?? 'UTC'))
            : (task.recurrence?.anchorDate ?? '0001-01-01');
      const members = descendants([taskId]).filter((t) => {
        let current = t;
        while (current.id !== taskId) {
          if (current.recurrence || !current.inheritRecurrence || !current.parentTaskId)
            return false;
          const parent = state.task.get(current.parentTaskId);
          if (!parent) return false;
          current = parent;
        }
        return true;
      });
      const memberIds = new Set(members.map((t) => t.id)),
        oldInstances = [...state.occurrence.values()].filter(
          (o) => memberIds.has(o.taskId) && !o.deletedAt,
        );
      const protectedCycles = new Set(
        oldInstances.filter((o) => o.status === 'done' || o.manuallyEdited).map((o) => o.cycleKey),
      );
      const protectedDates = oldInstances
        .filter((o) => protectedCycles.has(o.cycleKey))
        .map((o) => o.scheduledDate ?? o.due?.date)
        .filter((x): x is string => !!x);
      const rule = ruleInput
        ? {
            ...ruleInput,
            id: task.recurrence?.id === ruleInput.id ? randomUUID() : ruleInput.id,
            anchorDate:
              scope === 'future' && ruleInput.anchorDate < from ? from : ruleInput.anchorDate,
            excludedDates: [...new Set([...ruleInput.excludedDates, ...protectedDates])],
          }
        : null;
      const updated = put('task', {
        ...task,
        recurrence: rule,
        recurrenceHistory: [
          ...task.recurrenceHistory,
          ...(task.recurrence ? [{ ...task.recurrence, until: addDays(from, -1) }] : []),
        ],
      });
      for (const o of oldInstances)
        if (
          (!o.scheduledDate || o.scheduledDate >= from) &&
          !protectedCycles.has(o.cycleKey) &&
          ['todo', 'doing', 'blocked'].includes(o.status)
        )
          put('occurrence', {
            ...o,
            status: 'cancelled',
            deletedAt: now,
            scheduleRevision: randomUUID(),
          });
      if (rule)
        for (const member of members)
          materialize(get('task', member.id), rule.anchorDate, addDays(rule.anchorDate, 90));
      else {
        const historicalOnce = oldInstances.some(
          (o) => o.cycleKey === 'once' && o.status === 'done',
        );
        const cycleKey = historicalOnce
          ? 'once:' + stableToDooId(requestId, 'stop-repeat')
          : 'once';
        const depth = (t: ToDooTask) => {
          let n = 0,
            current = t;
          while (current.id !== taskId && current.parentTaskId) {
            n++;
            current = get('task', current.parentTaskId);
          }
          return n;
        };
        members.sort((a, b) => depth(a) - depth(b));
        for (const member of members) {
          const candidate = oldInstances
            .filter(
              (o) => o.taskId === member.id && ['todo', 'doing', 'blocked'].includes(o.status),
            )
            .sort((a, b) => (a.scheduledDate ?? '').localeCompare(b.scheduledDate ?? ''))[0];
          const saved = occurrence(
            get('task', member.id),
            cycleKey,
            candidate?.scheduledDate ?? null,
            null,
            candidate?.due ?? null,
          );
          if (saved.deletedAt)
            put('occurrence', {
              ...saved,
              deletedAt: null,
              status: 'todo',
              completedAt: null,
              seriesSegmentId: null,
              scheduleRevision: randomUUID(),
            });
        }
      }
      activity('change_recurrence', taskId, null, '保留已完成/已编辑实例；更新规则与未来子树');
      return updated;
    }
    function save(
      kind: ToDooEntityKind,
      value: Record<string, unknown>,
      expectedRevision?: string,
    ): ToDooEntity {
      const existing = typeof value.id === 'string' ? state[kind].get(value.id) : undefined;
      if (existing && !expectedRevision) toDooError('修改既有实体需要预期版本', 400);
      if (existing) check(kind, existing.id, expectedRevision!);
      if (kind === 'habit') {
        const old = existing as ToDooEntityMap['habit'] | undefined;
        const candidate = parseEntity('habit', {
          ...old,
          ...value,
          id: old?.id ?? value.id ?? randomUUID(),
          revision: old?.revision ?? randomUUID(),
          createdAt: old?.createdAt ?? now,
          updatedAt: now,
          deletedAt: Object.hasOwn(value, 'deletedAt') ? value.deletedAt : (old?.deletedAt ?? null),
        });
        const fields = [
          'frequency',
          'target',
          'unit',
          'timeZone',
          'weekdays',
          'startDate',
          'endDate',
          'weekStartsOn',
          'skipPolicy',
        ] as const;
        const changed =
          !old || fields.some((field) => canonical(candidate[field]) !== canonical(old[field]));
        const snapshotRule = (
          habit: ToDooEntityMap['habit'],
          effectiveFrom: string,
          estimated: boolean,
        ) =>
          toDooHabitRuleSchema.parse({
            id: randomUUID(),
            effectiveFrom,
            ...Object.fromEntries(fields.map((field) => [field, habit[field]])),
            estimated,
          });
        if (changed) {
          if (old && !Object.hasOwn(value, 'effectiveFrom'))
            toDooError('修改习惯目标或周期需要明确生效日期 effectiveFrom', 400);
          const date = candidate.effectiveFrom ?? candidate.startDate;
          const versions = old
            ? old.ruleVersions.length
              ? [...old.ruleVersions]
              : [snapshotRule(old, old.startDate, true)]
            : [];
          const version = snapshotRule(candidate, date, false);
          return put(
            'habit',
            {
              ...candidate,
              effectiveFrom: date,
              ruleVersions: [...versions.filter((v) => v.effectiveFrom !== date), version].sort(
                (a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom),
              ),
            },
            expectedRevision,
          );
        }
        return put(
          'habit',
          { ...candidate, ruleVersions: old?.ruleVersions ?? [] },
          expectedRevision,
        );
      }

      if (kind === 'task' && !existing) return createTask(value);
      if (
        kind === 'task' &&
        existing &&
        Object.hasOwn(value, 'recurrence') &&
        canonical(value.recurrence) !== canonical((existing as ToDooTask).recurrence)
      ) {
        const { recurrence, recurrenceHistory, ...metadata } = value;
        put('task', metadata, expectedRevision);
        return changeRule(existing.id, recurrence as ToDooTask['recurrence'], 'all');
      }

      if (kind === 'exception') {
        const exception = put('exception', value, expectedRevision);
        const target = [...state.occurrence.values()].find(
          (o) => o.taskId === exception.taskId && o.cycleKey === exception.cycleKey,
        );
        if (target)
          put('occurrence', {
            ...target,
            status: exception.kind === 'skip' ? 'skipped' : target.status,
            due: exception.due ?? target.due,
            titleOverride: exception.title ?? target.titleOverride,
            manuallyEdited: true,
            scheduleRevision: randomUUID(),
          });
        else if (exception.kind === 'additional') {
          const task = get('task', exception.taskId),
            rule = effectiveRule(task);
          occurrence(task, exception.cycleKey, exception.date, rule, exception.due);
        }
        return exception;
      }
      if (kind === 'occurrence' && existing) {
        const o = existing as ToDooOccurrence;
        if (value.status && value.status !== o.status)
          setStatus(
            o.id,
            value.status as ToDooOccurrence['status'],
            false,
            value.resultSummary as string | undefined,
            value.completedAt as string | undefined,
          );
        const scheduled = ['due', 'scheduledDate', 'reminders'].some(
          (k) =>
            Object.hasOwn(value, k) && canonical((value as any)[k]) !== canonical((o as any)[k]),
        );
        return put('occurrence', {
          ...value,
          manuallyEdited: true,
          ...(scheduled ? { scheduleRevision: randomUUID() } : {}),
        });
      }
      if (kind === 'timeBlock') {
        const block = put('timeBlock', value, expectedRevision);
        if (block.occurrenceId) {
          const o = get('occurrence', block.occurrenceId);
          put('occurrence', { ...o, scheduleRevision: randomUUID(), manuallyEdited: true });
        }
        return block;
      }
      if (
        kind === 'task' &&
        existing &&
        Object.hasOwn(value, 'reminders') &&
        canonical(value.reminders) !== canonical((existing as ToDooTask).reminders)
      ) {
        for (const o of state.occurrence.values())
          if (
            o.taskId === existing.id &&
            !o.deletedAt &&
            !['done', 'cancelled', 'skipped'].includes(o.status)
          )
            put('occurrence', { ...o, scheduleRevision: randomUUID() });
      }
      return put(kind, value, expectedRevision);
    }
    return {
      state,
      changes,
      now,
      get,
      check,
      put,
      activity,
      descendants,
      materialize,
      createTask,
      setStatus,
      statusSelection,
      checkStatusSelection,
      applyStatusSelection,
      changeRule,
      save,
    };
  }
  if (!store.entities('settings', 1).length)
    mutate('initialize-settings-' + store.datasetId, { action: 'initialize' }, (c) => [
      c.put('settings', { id: 'settings' }).id,
    ]);
  if (store.newInstance) {
    const running = store
      .entities('focusSession')
      .filter((s) => s.status === 'running' && !s.deletedAt);
    if (running.length)
      mutate(
        'interrupt-restored-focus-' + randomUUID(),
        { action: 'interrupt_restored_focus' },
        (c) =>
          running.map(
            (session) =>
              c.put('focusSession', {
                ...session,
                status: 'interrupted',
                segments: session.segments.map((part) =>
                  part.end ? part : { ...part, end: part.start },
                ),
              }).id,
          ),
      );
  }
  function snapshot(query?: ToDooQuery) {
    store.refresh();
    return db.transaction(() => buildToDooSnapshot(store, query)).deferred();
  }
  function command(input: unknown, trustedContext: ToDooCommandContext = {}): ToDooCommandResult {
    const parsed = toDooCommandSchema.safeParse(input);
    if (!parsed.success)
      toDooError(
        '请求格式不正确：' +
          parsed.error.issues
            .slice(0, 3)
            .map((x) => x.path.join('.') + ' ' + x.message)
            .join('; '),
        400,
        'TO_DOO_INVALID',
      );
    const cmd = parsed.data;
    if (cmd.action === 'preview_plan') {
      store.refresh();
      const current = store.state(),
        data = {
          tasks: [...current.task.values()],
          occurrences: [...current.occurrence.values()],
          timeBlocks: [...current.timeBlock.values()],
        };
      const verified = (
        cmd.payload.includeDependents ? previewToDooDependentAdjustment : validateToDooPlan
      )(data, cmd.payload.changes, { allowedTaskIds: trustedContext.allowedTaskIds });
      const now = new Date().toISOString(),
        preview = parseEntity('plan', {
          id: stableToDooId(cmd.requestId, 'preview'),
          revision: stableToDooId(cmd.requestId, 'preview-revision'),
          createdAt: now,
          updatedAt: now,
          name: cmd.payload.name,
          changes: verified.changes,
          conflicts: verified.conflicts,
          reason: cmd.payload.reason,
          includeDependents: cmd.payload.includeDependents,
          expectedRevisions: verified.expectedRevisions,
        });
      return {
        transactionId: null,
        replayed: false,
        changed: [],
        ids: [preview.id],
        preview,
        snapshot: snapshot(),
      };
    }
    return mutate(cmd.requestId, input, (c) => {
      const { action, payload: p } = cmd;
      switch (action) {
        case 'save_entity':
          return [c.save(p.kind, p.entity, p.expectedRevision).id];
        case 'save_outcome': {
          c.check('occurrence', p.occurrenceId, p.expectedRevision);
          const occurrence = c.get('occurrence', p.occurrenceId),
            task = c.get('task', occurrence.taskId);
          let evidenceRefs = p.outcome.evidenceRefs;
          if (p.operationId) {
            const op = c.get('operation', p.operationId);
            if (op.occurrenceId !== occurrence.id || op.state === 'completed' || !op.noteId)
              toDooError('成果笔记操作尚未就绪或已经完成');
            if (!evidenceRefs.some((ref) => ref.noteId === op.noteId))
              evidenceRefs = [...evidenceRefs, { noteId: op.noteId, role: 'output' }];
          }
          const statusSelection =
            p.complete && p.cascade
              ? c.statusSelection({ occurrenceId: p.occurrenceId, cascade: true, status: 'done' })
              : null;
          if (statusSelection)
            c.checkStatusSelection(statusSelection, p.expectedOccurrenceIds, p.expectedRevisions);
          const outcome = c.put('outcome', {
            ...p.outcome,
            occurrenceId: occurrence.id,
            listId: task.listId,
            evidenceRefs,
          });
          if (p.complete) {
            if (statusSelection) c.applyStatusSelection(statusSelection, 'done', occurrence.id);
            else c.setStatus(occurrence.id, 'done', false);
          }
          if (p.operationId)
            c.put('operation', {
              ...c.get('operation', p.operationId),
              state: 'completed',
              content: '',
            });
          return [outcome.id];
        }
        case 'attach_asset': {
          c.check('task', p.taskId, p.expectedRevision);
          const task = c.get('task', p.taskId);
          if (task.deletedAt) toDooError('任务已删除', 400);
          const bytes = readKnowledgeDataFile(
            config.knowledgeRoot,
            'apps/to-doo/assets/' + p.attachment.hash,
          );
          if (
            !bytes ||
            toDooHash(bytes) !== p.attachment.hash ||
            bytes.length !== p.attachment.size
          )
            toDooError('附件内容缺失或校验失败', 400);
          return [
            c.put('task', {
              ...task,
              attachments: [
                ...task.attachments.filter((a) => a.hash !== p.attachment.hash),
                p.attachment,
              ],
            }).id,
          ];
        }
        case 'detach_asset': {
          c.check('task', p.taskId, p.expectedRevision);
          const task = c.get('task', p.taskId);
          return [
            c.put('task', {
              ...task,
              attachments: task.attachments.filter((a) => a.hash !== p.hash),
            }).id,
          ];
        }
        case 'create_task':
          return [c.createTask(p as Record<string, unknown>).id];
        case 'update_task':
          c.check('task', p.id, p.expectedRevision);
          return [c.save('task', { ...c.get('task', p.id), ...p.patch }, p.expectedRevision).id];
        case 'set_occurrence_status': {
          c.check('occurrence', p.id, p.expectedRevision);
          if (p.cascade) {
            const selection = c.statusSelection({
              occurrenceId: p.id,
              cascade: true,
              status: p.status,
            });
            c.checkStatusSelection(selection, p.expectedOccurrenceIds, p.expectedRevisions);
            c.applyStatusSelection(selection, p.status, p.id, p.resultSummary, p.at);
          } else c.setStatus(p.id, p.status, false, p.resultSummary, p.at);
          return [p.id];
        }
        case 'materialize_occurrences': {
          const root = c.get('task', p.taskId),
            ids: string[] = [];
          for (const task of c.descendants([root.id]).filter((t) => !t.deletedAt))
            ids.push(...c.materialize(task, p.from, p.to));
          return ids;
        }
        case 'change_recurrence': {
          c.check('task', p.taskId, p.expectedRevision);
          return [c.changeRule(p.taskId, p.rule, p.scope, p.from).id];
        }
        case 'batch_tasks': {
          if (p.operation === 'complete' || p.operation === 'cancel') {
            const status = p.operation === 'complete' ? 'done' : 'cancelled',
              selection = c.statusSelection({
                taskIds: p.ids,
                includeDescendants: p.includeDescendants,
                scope: p.scope,
                from: p.from,
                to: p.to,
                status,
              });
            c.checkStatusSelection(selection, p.occurrenceIds, p.expectedRevisions);
            c.applyStatusSelection(selection, status);
            return selection.taskIds;
          }
          const selected = c.descendants(p.ids, p.includeDescendants);
          for (const t of selected) {
            const expected = p.expectedRevisions[t.id];
            if (!expected) toDooError('批量缺少成员预期版本', 400);
            c.check('task', t.id, expected);
          }
          const ids: string[] = [];
          if (p.operation === 'copy') {
            const remap = new Map(selected.map((t) => [t.id, randomUUID()]));
            for (const t of selected) {
              const clone = c.createTask({
                ...t,
                id: remap.get(t.id),
                title: t.title + ' 副本',
                parentTaskId:
                  t.parentTaskId && remap.has(t.parentTaskId) ? remap.get(t.parentTaskId) : null,
                listId: p.listId !== undefined ? p.listId : t.listId,
                deletedAt: null,
              });
              ids.push(clone.id);
            }
            return ids;
          }
          const selectedIds = new Set(selected.map((t) => t.id));
          for (const t of selected) {
            ids.push(t.id);
            if (p.operation === 'delete' || p.operation === 'restore') {
              c.put('task', { ...t, deletedAt: p.operation === 'delete' ? c.now : null });
              for (const o of c.state.occurrence.values())
                if (o.taskId === t.id)
                  c.put('occurrence', { ...o, deletedAt: p.operation === 'delete' ? c.now : null });
            } else {
              const moving = p.operation === 'move';
              c.put('task', {
                ...t,
                ...Object.fromEntries(
                  Object.entries(p.patch ?? {}).filter(([key]) => key !== 'recurrence'),
                ),
                ...(moving
                  ? {
                      listId: p.listId ?? null,
                      sectionId: null,
                      parentTaskId:
                        t.parentTaskId && selectedIds.has(t.parentTaskId)
                          ? t.parentTaskId
                          : (p.parentTaskId ?? null),
                    }
                  : {}),
              });
            }
          }
          if (p.operation === 'patch' && p.patch && Object.hasOwn(p.patch, 'recurrence')) {
            for (const t of selected) {
              if (t.parentTaskId && selectedIds.has(t.parentTaskId)) continue;
              c.changeRule(t.id, p.patch.recurrence as ToDooTask['recurrence'], 'all');
            }
          }
          return ids;
        }
        case 'delete_entity': {
          c.check(p.kind, p.id, p.expectedRevision);
          if (p.kind === 'task') {
            const tasks = c.descendants([p.id], p.cascade);
            if (!p.cascade && c.descendants([p.id]).length > 1) toDooError('请选择同时处理子任务');
            for (const t of tasks) {
              c.put('task', { ...t, deletedAt: p.restore ? null : c.now });
              for (const o of c.state.occurrence.values())
                if (o.taskId === t.id)
                  c.put('occurrence', { ...o, deletedAt: p.restore ? null : c.now });
            }
            return tasks.map((t) => t.id);
          }
          if (p.kind === 'list') {
            const tasks = [...c.state.task.values()].filter((t) => t.listId === p.id);
            if (tasks.length && !p.cascade) toDooError('清单包含任务，请选择级联处理或先移动');
            for (const t of tasks) {
              c.put('task', { ...t, deletedAt: p.restore ? null : c.now });
              for (const o of c.state.occurrence.values())
                if (o.taskId === t.id)
                  c.put('occurrence', { ...o, deletedAt: p.restore ? null : c.now });
            }
          }
          if (p.kind === 'timeBlock') {
            const block = c.get('timeBlock', p.id);
            if (block.occurrenceId) {
              const o = c.get('occurrence', block.occurrenceId);
              c.put('occurrence', { ...o, scheduleRevision: randomUUID(), manuallyEdited: true });
            }
          }
          return [
            c.put(p.kind, { ...c.get(p.kind, p.id), deletedAt: p.restore ? null : c.now }).id,
          ];
        }
        case 'start_focus': {
          if (
            [...c.state.focusSession.values()].some((s) => !s.deletedAt && s.status === 'running')
          )
            toDooError('已有运行中的专注，请先暂停或接管');
          if (p.occurrenceId) c.get('occurrence', p.occurrenceId);
          return [
            c.put('focusSession', {
              mode: p.mode,
              occurrenceId: p.occurrenceId,
              listId: p.listId,
              targetMinutes:
                p.targetMinutes ??
                (p.mode === 'pomodoro' ? c.state.settings.get('settings')!.focusMinutes : null),
              status: 'running',
              segments: [{ start: p.at ?? c.now, end: null }],
            }).id,
          ];
        }
        case 'control_focus': {
          c.check('focusSession', p.id, p.expectedRevision);
          const old = c.get('focusSession', p.id),
            at = p.at ?? c.now;
          const segments = old.segments.map((x) => ({ ...x }));
          if (p.operation === 'correct') {
            if (p.correctedMinutes === undefined) toDooError('请填写修正分钟数', 400);
            return [c.put('focusSession', { ...old, correctedMinutes: p.correctedMinutes }).id];
          }
          if (p.operation === 'takeover') {
            if (old.status !== 'running') toDooError('当前专注未在运行', 400);
            const open = [...segments].reverse().find((x) => x.end === null);
            if (open) {
              if (at < open.start) toDooError('接管时间早于开始', 400);
              open.end = at;
            }
            segments.push({ start: at, end: null });
            return [c.put('focusSession', { ...old, segments, status: 'running' }).id];
          }
          if (p.operation === 'resume') {
            if (old.status !== 'paused' && old.status !== 'interrupted')
              toDooError('该专注不能继续', 400);
            if (
              [...c.state.focusSession.values()].some(
                (x) => x.id !== old.id && x.status === 'running' && !x.deletedAt,
              )
            )
              toDooError('另一个专注正在运行');
            segments.push({ start: at, end: null });
          } else {
            const open = [...segments].reverse().find((x) => x.end === null);
            if (open) {
              if (at < open.start) toDooError('结束时间早于开始', 400);
              open.end = at;
            } else if (p.operation === 'pause') toDooError('专注已经暂停', 400);
          }
          const finished = c.put('focusSession', {
            ...old,
            segments,
            status:
              p.operation === 'resume'
                ? 'running'
                : p.operation === 'pause'
                  ? 'paused'
                  : p.operation === 'finish'
                    ? 'finished'
                    : 'cancelled',
            correctedMinutes: p.correctedMinutes ?? old.correctedMinutes,
            note: p.note ?? old.note,
          });
          const ids = [finished.id];
          if (p.operation === 'finish' && p.note?.trim()) {
            const occurrence = old.occurrenceId
                ? c.state.occurrence.get(old.occurrenceId)
                : undefined,
              task = occurrence ? c.state.task.get(occurrence.taskId) : undefined;
            ids.push(
              c.put('record', {
                id: stableToDooId(old.id, 'focus-result'),
                taskId: task?.id ?? null,
                occurrenceId: old.occurrenceId,
                listId: old.listId ?? task?.listId ?? null,
                content: p.note,
                minutes: null,
                occurredAt: at,
                sourceSessionId: old.id,
              }).id,
            );
          }
          return ids;
        }
        case 'checkin_habit': {
          const habit = c.get('habit', p.habitId);
          if (habit.deletedAt) toDooError('习惯已删除', 400);
          if (p.localDate < habit.startDate || (habit.endDate && p.localDate > habit.endDate))
            toDooError('打卡日期不在习惯生效区间', 400);
          if (
            p.sourceSessionId &&
            [...c.state.habitEntry.values()].some(
              (e) =>
                e.habitId === p.habitId && e.sourceSessionId === p.sourceSessionId && !e.deletedAt,
            )
          )
            toDooError('该专注已经计入习惯');
          const { at, ...entry } = p;
          return [c.put('habitEntry', { ...entry, occurredAt: at ?? c.now }).id];
        }
        case 'apply_template': {
          const template = c.get('template', p.templateId),
            remap = new Map(template.tasks.map((t) => [t.key, randomUUID()]));
          if (remap.size !== template.tasks.length) toDooError('模板任务key重复', 400);
          const ids: string[] = [];
          for (const t of template.tasks) {
            if (t.parentKey && !remap.has(t.parentKey)) toDooError('模板父项不存在', 400);
            const { key, parentKey, ...fields } = t;
            ids.push(
              c.createTask({
                ...fields,
                id: remap.get(key),
                parentTaskId: parentKey ? remap.get(parentKey) : null,
                listId: p.listId,
                title: p.titlePrefix + fields.title,
              }).id,
            );
          }
          return ids;
        }
        case 'apply_plan': {
          const plan = p.plan,
            data = {
              tasks: [...c.state.task.values()],
              occurrences: [...c.state.occurrence.values()],
              timeBlocks: [...c.state.timeBlock.values()],
            };
          const allowed = trustedContext.allowedTaskIds
            ? new Set(trustedContext.allowedTaskIds)
            : null;
          for (const [key, revision] of Object.entries(plan.expectedRevisions)) {
            const [kind, id] = key.split(':') as ['task' | 'occurrence' | 'timeBlock', string];
            if (allowed) {
              const entity = c.state[kind].get(id);
              const taskId =
                kind === 'task'
                  ? id
                  : kind === 'occurrence'
                    ? (entity as ToDooOccurrence | undefined)?.taskId
                    : (entity as ToDooEntityMap['timeBlock'] | undefined)?.occurrenceId
                      ? c.state.occurrence.get(
                          (entity as ToDooEntityMap['timeBlock']).occurrenceId!,
                        )?.taskId
                      : null;
              if (!taskId || !allowed.has(taskId)) toDooError('计划需要额外授权范围');
            }
            c.check(kind, id, revision);
          }
          const verified = (
            plan.includeDependents ? previewToDooDependentAdjustment : validateToDooPlan
          )(data, plan.changes, { allowedTaskIds: trustedContext.allowedTaskIds });
          if (verified.conflicts.length)
            toDooError('计划存在冲突：' + verified.conflicts.join('；'));
          if (
            canonical(verified.expectedRevisions) !== canonical(plan.expectedRevisions) ||
            canonical(verified.changes) !== canonical(plan.changes)
          )
            toDooError('计划基线或联动范围已变化，请重新预览');
          const originals = new Set(plan.changes.map((change) => change.occurrenceId));
          if (verified.changes.some((change) => !originals.has(change.occurrenceId)))
            toDooError('联动范围已变化，请重新预览');
          const ids: string[] = [];
          for (const change of verified.changes) {
            c.check('occurrence', change.occurrenceId, change.expectedRevision);
            const occurrence = c.get('occurrence', change.occurrenceId);
            let previous: ToDooEntityMap['timeBlock'] | undefined;
            if (change.blockId) {
              if (!change.expectedBlockRevision) toDooError('移动原时间块需要版本');
              c.check('timeBlock', change.blockId, change.expectedBlockRevision);
              previous = c.get('timeBlock', change.blockId);
            }
            const block = c.put('timeBlock', {
              ...previous,
              ...(change.blockId ? { id: change.blockId } : {}),
              occurrenceId: occurrence.id,
              start: change.start,
              durationMinutes: change.durationMinutes,
              ...(change.allDay !== undefined ? { allDay: change.allDay } : {}),
              ...(change.dateEndExclusive !== undefined
                ? { dateEndExclusive: change.dateEndExclusive }
                : {}),
            });
            ids.push(block.id);
            c.put('occurrence', {
              ...occurrence,
              scheduleRevision: randomUUID(),
              manuallyEdited: true,
            });
          }
          c.put('plan', {
            ...plan,
            changes: verified.changes,
            conflicts: [],
            expectedRevisions: verified.expectedRevisions,
            appliedAt: c.now,
          });
          return ids;
        }
        case 'import_entities':
          return p.entities.map((e) => {
            const existing =
              typeof e.entity.id === 'string' ? c.state[e.kind].get(e.entity.id) : undefined;
            if (existing) {
              if (!e.expectedRevision) toDooError('导入修改需要预期版本', 400);
              c.check(e.kind, existing.id, e.expectedRevision);
            }
            return c.put(e.kind, e.entity, e.expectedRevision).id;
          });
      }
    });
  }
  function exportCheckpoint() {
    return store.checkpoint();
  }
  function importCheckpoint(
    checkpoint: ToDooCheckpoint,
    requestId: string,
    options?: { expectedRevisions?: Record<string, string> },
  ) {
    if (
      !checkpoint ||
      !Array.isArray(checkpoint.entities) ||
      !Array.isArray(checkpoint.receipts) ||
      !Array.isArray(checkpoint.transactions) ||
      !Array.isArray(checkpoint.assets) ||
      typeof checkpoint.digest !== 'string'
    )
      toDooError('导入包结构无效', 400);
    const { digest, ...payload } = checkpoint;
    if (
      checkpoint.format !== 1 ||
      checkpoint.appId !== 'to-doo' ||
      toDooHash(canonical(payload)) !== digest
    )
      toDooError('导入包校验失败', 400);
    for (const entry of checkpoint.entities) parseEntity(entry.kind, entry.entity);
    for (const asset of checkpoint.assets) {
      if (
        !/^[a-f0-9]{64}$/.test(asset.hash) ||
        typeof asset.data !== 'string' ||
        asset.data.length > 15 * 1024 * 1024
      )
        toDooError('附件数据无效', 400);
      const bytes = Buffer.from(asset.data, 'base64');
      if (toDooHash(bytes) !== asset.hash) toDooError('附件校验失败', 400);
      const path = 'apps/to-doo/assets/' + asset.hash,
        existing = readKnowledgeDataFile(config.knowledgeRoot, path);
      if (existing && toDooHash(existing) !== asset.hash) toDooError('已有附件内容冲突');
      if (!existing) writeKnowledgeDataFile(config.knowledgeRoot, path, bytes, null);
    }
    return mutate(
      requestId,
      {
        action: 'import_checkpoint',
        digest,
        ...(options ? { expectedRevisions: options.expectedRevisions ?? {} } : {}),
      },
      (c) =>
        checkpoint.entities.map(({ kind, entity }) => {
          const existing = c.state[kind].get(entity.id),
            expected = options?.expectedRevisions?.[kind + ':' + entity.id];
          if (expected) {
            c.check(kind, entity.id, expected);
            return c.put(kind, { ...entity }, expected).id;
          }
          if (
            existing &&
            existing.id !== 'settings' &&
            canonical({ ...existing, revision: '', updatedAt: '' }) !==
              canonical({ ...entity, revision: '', updatedAt: '' })
          )
            toDooError('导入包与现有内容冲突，请先预览处理');
          return c.put(kind, { ...entity }).id;
        }),
      {
        receipts: checkpoint.receipts,
        transactions: checkpoint.transactions,
        adoptDatasetId:
          store.entities('task', 1).length === 0 && store.entities('list', 1).length === 0
            ? checkpoint.datasetId
            : undefined,
      },
    );
  }
  return {
    snapshot,
    command,
    getEntity(kind, id) {
      store.refresh();
      const row = store.db
        .prepare('SELECT data FROM todo_entities WHERE kind=? AND id=?')
        .get(kind, id) as { data: string } | undefined;
      return row ? JSON.parse(row.data) : undefined;
    },
    getReceipt(requestId) {
      store.refresh();
      return store.receipt(requestId);
    },
    exportCheckpoint,
    importCheckpoint,
    close: () => store.close(),
  };
}
