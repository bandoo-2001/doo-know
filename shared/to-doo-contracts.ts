import { z } from 'zod';

export const toDooId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
export const toDooDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(v + 'T00:00:00Z');
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, '无效日期');
const timestamp = z.string().datetime();
const text = (n = 65536) =>
  z
    .string()
    .max(n)
    .refine((v) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v));
const zone = z
  .string()
  .max(128)
  .refine((v) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: v });
      return true;
    } catch {
      return false;
    }
  }, '无效时区');
const base = {
  id: toDooId,
  revision: toDooId,
  createdAt: timestamp,
  updatedAt: timestamp,
  deletedAt: timestamp.nullable().default(null),
};
const title = text(256).min(1);
export const toDooStatusSchema = z.enum([
  'todo',
  'doing',
  'blocked',
  'done',
  'cancelled',
  'skipped',
]);
export const toDooDateTimeSchema = z
  .object({
    date: toDooDate,
    time: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .nullable()
      .default(null),
    timeZone: zone.default('UTC'),
  })
  .strict();
export type ToDooDateTime = z.infer<typeof toDooDateTimeSchema>;
const ref = z
  .object({
    noteId: toDooId,
    role: z.enum(['source', 'material', 'output', 'review']).default('material'),
    title: text(256).optional(),
  })
  .strict();
const reminderRule = z
  .object({
    id: toDooId,
    anchor: z.enum(['due', 'plan', 'occurrence', 'absolute']).default('due'),
    offsetMinutes: z.number().int().min(-525600).max(525600).default(0),
    at: timestamp.optional(),
    allDayTime: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .default('09:00'),
  })
  .strict();
export const toDooRecurrenceSchema = z
  .object({
    id: toDooId,
    frequency: z.enum(['daily', 'weekly', 'monthly', 'yearly', 'after_completion']),
    interval: z.number().int().min(1).max(1000).default(1),
    anchorDate: toDooDate,
    time: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .nullable()
      .default(null),
    timeZone: zone.default('UTC'),
    weekdays: z.array(z.number().int().min(0).max(6)).max(7).default([]),
    monthDay: z.number().int().min(1).max(31).optional(),
    weekOrdinal: z
      .number()
      .int()
      .min(-1)
      .max(5)
      .refine((v) => v !== 0)
      .optional(),
    until: toDooDate.nullable().default(null),
    count: z.number().int().positive().max(100000).nullable().default(null),
    shortMonth: z.enum(['last_day', 'skip']).default('last_day'),
    excludedDates: z.array(toDooDate).max(10000).default([]),
    additionalDates: z.array(toDooDate).max(10000).default([]),
    endedAt: timestamp.nullable().default(null),
    previousSegmentId: toDooId.optional(),
    completionUnit: z.enum(['day', 'week', 'month']).default('day'),
  })
  .strict();
export type ToDooRecurrence = z.infer<typeof toDooRecurrenceSchema>;
export const toDooHabitRuleSchema = z
  .object({
    id: toDooId,
    effectiveFrom: toDooDate,
    frequency: z.enum(['daily', 'weekly', 'monthly']),
    target: z.number().positive().max(1000000),
    unit: text(40),
    timeZone: zone,
    weekdays: z.array(z.number().int().min(0).max(6)).max(7),
    startDate: toDooDate,
    endDate: toDooDate.nullable(),
    weekStartsOn: z.number().int().min(0).max(6).default(1),
    skipPolicy: z.enum(['break', 'exempt']).default('break'),
    estimated: z.boolean().default(false),
  })
  .strict();
export type ToDooHabitRule = z.infer<typeof toDooHabitRuleSchema>;
export const toDooScheduleChangeSchema = z
  .object({
    occurrenceId: toDooId,
    expectedRevision: toDooId,
    start: toDooDateTimeSchema,
    durationMinutes: z.number().int().positive().max(525600),
    blockId: toDooId.optional(),
    expectedBlockRevision: toDooId.optional(),
    allDay: z.boolean().optional(),
    dateEndExclusive: toDooDate.nullable().optional(),
  })
  .strict();
export type ToDooScheduleChange = z.infer<typeof toDooScheduleChangeSchema>;
const taskFields = {
  title,
  description: text().default(''),
  listId: toDooId.nullable().default(null),
  sectionId: toDooId.nullable().default(null),
  parentTaskId: toDooId.nullable().default(null),
  orderKey: text(128).default('a0'),
  priority: z.enum(['none', 'low', 'normal', 'high']).default('none'),
  importance: z.enum(['normal', 'important']).default('normal'),
  urgentOverride: z.boolean().nullable().default(null),
  tagIds: z.array(toDooId).max(100).default([]),
  estimateMinutes: z.number().int().min(0).max(525600).nullable().default(null),
  noteRefs: z.array(ref).max(100).default([]),
  attachments: z
    .array(
      z
        .object({
          hash: z.string().regex(/^[a-f0-9]{64}$/),
          name: text(256).min(1),
          mime: text(128).min(1),
          size: z
            .number()
            .int()
            .min(0)
            .max(10 * 1024 * 1024),
        })
        .strict(),
    )
    .max(100)
    .default([]),
  source: z
    .object({
      noteId: toDooId,
      quote: text(),
      contentHash: text(128).nullable().default(null),
      startLineHint: z.number().int().positive().optional(),
      draft: z.boolean().default(false),
    })
    .strict()
    .nullable()
    .default(null),
  criteria: text().default(''),
  dependencies: z
    .array(z.object({ taskId: toDooId, lagMinutes: z.number().int().min(0).default(0) }).strict())
    .max(100)
    .default([]),
  reminders: z.array(reminderRule).max(20).default([]),
  recurrence: toDooRecurrenceSchema.nullable().default(null),
  recurrenceHistory: z.array(toDooRecurrenceSchema).default([]),
  inheritRecurrence: z.boolean().default(true),
  archivedAt: timestamp.nullable().default(null),
  pinned: z.boolean().default(false),
};
export const toDooTaskSchema = z.object({ ...base, ...taskFields }).strict();
export const toDooAttachmentSchema = toDooTaskSchema.shape.attachments.removeDefault().element;
export type ToDooAttachment = z.infer<typeof toDooAttachmentSchema>;
export const toDooOccurrenceSchema = z
  .object({
    ...base,
    taskId: toDooId,
    cycleKey: text(256),
    seriesSegmentId: toDooId.nullable().default(null),
    parentOccurrenceId: toDooId.nullable().default(null),
    status: toDooStatusSchema.default('todo'),
    due: toDooDateTimeSchema.nullable().default(null),
    scheduledDate: toDooDate.nullable().default(null),
    completedAt: timestamp.nullable().default(null),
    resultSummary: text().default(''),
    blockedReason: text(2000).default(''),
    scheduleRevision: toDooId,
    reminders: z.array(reminderRule).nullable().default(null),
    manuallyEdited: z.boolean().default(false),
    titleOverride: text(256).nullable().default(null),
    estimateMinutesOverride: z.number().int().min(0).nullable().default(null),
    predecessorId: toDooId.nullable().default(null),
  })
  .strict();
const timeBlockFields = {
  occurrenceId: toDooId.nullable().default(null),
  title: text(256).default(''),
  start: toDooDateTimeSchema,
  durationMinutes: z.number().int().positive().max(525600).default(30),
  allDay: z.boolean().default(false),
  dateEndExclusive: toDooDate.nullable().default(null),
};
const settings = z
  .object({
    ...base,
    timeZone: zone.default('UTC'),
    weekStartsOn: z.number().int().min(0).max(6).default(1),
    defaultView: text(40).default('tasks'),
    defaultDurationMinutes: z.number().int().positive().max(1440).default(30),
    urgentHours: z.number().int().positive().max(8760).default(48),
    focusMinutes: z.number().int().positive().max(1440).default(25),
    shortBreakMinutes: z.number().int().min(0).max(1440).default(5),
    longBreakMinutes: z.number().int().min(0).max(1440).default(15),
    longBreakAfter: z.number().int().positive().max(100).default(4),
    maxDepth: z.number().int().min(1).max(32).default(8),
    quietHours: z
      .object({ enabled: z.boolean(), start: text(5), end: text(5), timeZone: zone })
      .strict()
      .nullable()
      .default(null),
  })
  .strict();
const list = z
  .object({
    ...base,
    name: title,
    kind: z.enum(['list', 'goal']).default('list'),
    description: text().default(''),
    goalDate: toDooDate.nullable().default(null),
    criteria: text().default(''),
    noteRefs: z.array(ref).default([]),
    color: text(40).default('#647be8'),
    orderKey: text(128).default('a0'),
    archivedAt: timestamp.nullable().default(null),
    autoCompleteParents: z.boolean().default(false),
  })
  .strict();
const baseFilterSchema = z
  .object({
    query: text(500).optional(),
    listIds: z.array(toDooId).optional(),
    tagIds: z.array(toDooId).optional(),
    statuses: z.array(toDooStatusSchema).optional(),
    priorities: z.array(z.enum(['none', 'low', 'normal', 'high'])).optional(),
    importance: z.enum(['normal', 'important']).optional(),
    from: toDooDate.optional(),
    to: toDooDate.optional(),
    dueBefore: toDooDate.optional(),
    unscheduled: z.boolean().optional(),
    hasEvidence: z.boolean().optional(),
    includeDeleted: z.boolean().optional(),
    includeArchived: z.boolean().optional(),
    leafOnly: z.boolean().optional(),
  })
  .strict();
export const toDooFilterConditionSchema = z
  .object({
    field: z.enum([
      'query',
      'listId',
      'tagId',
      'status',
      'priority',
      'importance',
      'dueDate',
      'plannedDate',
      'createdDate',
      'completedDate',
      'hasEvidence',
      'isLeaf',
      'isUnscheduled',
    ]),
    operator: z.enum([
      'contains',
      'not_contains',
      'is',
      'is_not',
      'in',
      'not_in',
      'before',
      'on',
      'after',
      'between',
      'is_empty',
      'not_empty',
    ]),
    value: z.union([text(1000), z.array(text(1000)).max(100), z.boolean()]).optional(),
  })
  .strict()
  .superRefine((leaf, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    const op = leaf.operator,
      v = leaf.value;
    if (leaf.field === 'query') {
      if (!['contains', 'not_contains'].includes(op) || typeof v !== 'string')
        issue('文字条件需要contains/not_contains和文本');
    } else if (['hasEvidence', 'isLeaf', 'isUnscheduled'].includes(leaf.field)) {
      if (op !== 'is' || typeof v !== 'boolean') issue('布尔条件需要is和布尔值');
    } else if (leaf.field.endsWith('Date')) {
      if (!['before', 'on', 'after', 'between', 'is_empty', 'not_empty'].includes(op))
        issue('日期比较不支持');
      else if (!['is_empty', 'not_empty'].includes(op)) {
        const values = op === 'between' ? v : [v];
        if (
          !Array.isArray(values) ||
          (op === 'between' && values.length !== 2) ||
          values.some((d) => !toDooDate.safeParse(d).success)
        )
          issue('日期条件无效');
        else if (op === 'between' && String(values[0]) > String(values[1])) issue('日期区间颠倒');
      }
    } else {
      if (
        !['is', 'is_not', 'in', 'not_in'].includes(op) ||
        (typeof v !== 'string' && !Array.isArray(v))
      )
        issue('选择条件需要is/in及文本值');
      const values = Array.isArray(v) ? v : [v];
      const allowed: Record<string, string[]> = {
        status: ['todo', 'doing', 'blocked', 'done', 'cancelled', 'skipped'],
        priority: ['none', 'low', 'normal', 'high'],
        importance: ['normal', 'important'],
      };
      if (
        values.some(
          (x) => typeof x !== 'string' || (allowed[leaf.field] && !allowed[leaf.field].includes(x)),
        )
      )
        issue('选择值无效');
    }
  });
export type ToDooFilterCondition = z.infer<typeof toDooFilterConditionSchema>;
export type ToDooFilterGroup = {
  operator: 'and' | 'or';
  conditions: (ToDooFilterCondition | ToDooFilterGroup)[];
};
export const toDooFilterGroupSchema: z.ZodType<ToDooFilterGroup> = z.lazy(() =>
  z
    .object({
      operator: z.enum(['and', 'or']),
      conditions: z.array(z.union([toDooFilterConditionSchema, toDooFilterGroupSchema])).max(30),
    })
    .strict(),
);
const filters = baseFilterSchema
  .extend({ group: toDooFilterGroupSchema.optional() })
  .strict()
  .superRefine((filter, ctx) => {
    let leaves = 0;
    function walk(group: ToDooFilterGroup, depth: number) {
      if (depth > 3) {
        ctx.addIssue({ code: 'custom', message: '条件组最多3层' });
        return;
      }
      for (const condition of group.conditions)
        if ('field' in condition) leaves++;
        else walk(condition, depth + 1);
    }
    if (filter.group) walk(filter.group, 1);
    if (leaves > 30) ctx.addIssue({ code: 'custom', message: '最多30个过滤条件' });
  });
export const toDooFilterSchema = filters;
const schemas = {
  settings,
  list,
  section: z
    .object({ ...base, listId: toDooId, name: title, orderKey: text(128).default('a0') })
    .strict(),
  tag: z.object({ ...base, name: title, color: text(40).default('#647be8') }).strict(),
  task: toDooTaskSchema,
  occurrence: toDooOccurrenceSchema,
  exception: z
    .object({
      ...base,
      taskId: toDooId,
      cycleKey: text(256),
      kind: z.enum(['skip', 'additional', 'override']),
      date: toDooDate,
      due: toDooDateTimeSchema.nullable().default(null),
      title: text(256).nullable().default(null),
    })
    .strict(),
  timeBlock: z.object({ ...base, ...timeBlockFields }).strict(),
  outcome: z
    .object({
      ...base,
      occurrenceId: toDooId.nullable().default(null),
      listId: toDooId.nullable().default(null),
      summary: text(),
      verification: z
        .enum(['self_assessed', 'practice', 'reviewed', 'delivered'])
        .default('self_assessed'),
      criteriaResults: z
        .array(z.object({ label: text(1000), passed: z.boolean() }).strict())
        .default([]),
      evidenceRefs: z.array(ref).default([]),
      followupTaskIds: z.array(toDooId).default([]),
    })
    .strict(),
  record: z
    .object({
      ...base,
      taskId: toDooId.nullable().default(null),
      occurrenceId: toDooId.nullable().default(null),
      listId: toDooId.nullable().default(null),
      content: text(),
      minutes: z.number().int().min(0).max(525600).nullable().default(null),
      occurredAt: timestamp,
      noteRefs: z.array(ref).default([]),
      sourceSessionId: toDooId.nullable().default(null),
    })
    .strict(),
  activity: z
    .object({
      ...base,
      action: text(80),
      entityId: toDooId,
      occurrenceId: toDooId.nullable().default(null),
      at: timestamp,
      summary: text(2000).default(''),
      reversesId: toDooId.nullable().default(null),
      requestId: toDooId,
    })
    .strict(),
  focusSession: z
    .object({
      ...base,
      mode: z.enum(['pomodoro', 'stopwatch', 'break']),
      occurrenceId: toDooId.nullable().default(null),
      listId: toDooId.nullable().default(null),
      targetMinutes: z.number().int().positive().max(1440).nullable().default(null),
      status: z.enum(['running', 'paused', 'finished', 'cancelled', 'interrupted']),
      segments: z
        .array(z.object({ start: timestamp, end: timestamp.nullable() }).strict())
        .max(10000),
      note: text().default(''),
      correctedMinutes: z.number().min(0).max(525600).nullable().default(null),
    })
    .strict(),
  habit: z
    .object({
      ...base,
      name: title,
      description: text().default(''),
      listId: toDooId.nullable().default(null),
      timeZone: zone.default('UTC'),
      frequency: z.enum(['daily', 'weekly', 'monthly']).default('daily'),
      target: z.number().positive().max(1000000).default(1),
      unit: text(40).default('次'),
      weekdays: z.array(z.number().int().min(0).max(6)).default([]),
      startDate: toDooDate,
      endDate: toDooDate.nullable().default(null),
      pausedDates: z.array(toDooDate).default([]),
      reminders: z.array(reminderRule).default([]),
      noteRefs: z.array(ref).default([]),
      color: text(40).default('#5bbda5'),
      effectiveFrom: toDooDate.optional(),
      ruleVersions: z.array(toDooHabitRuleSchema).max(10000).default([]),
      weekStartsOn: z.number().int().min(0).max(6).default(1),
      skipPolicy: z.enum(['break', 'exempt']).default('break'),
      reminderCheckpoint: z
        .object({
          throughDate: toDooDate,
          checkedAt: timestamp,
          ruleFingerprint: text(128),
          coveredFrom: toDooDate,
          uncoveredBefore: toDooDate.nullable(),
          estimated: z.boolean(),
        })
        .strict()
        .nullable()
        .default(null),
    })
    .strict(),
  habitEntry: z
    .object({
      ...base,
      habitId: toDooId,
      localDate: toDooDate,
      occurredAt: timestamp,
      amount: z.number().positive().max(1000000),
      note: text().default(''),
      skipped: z.boolean().default(false),
      sourceSessionId: toDooId.nullable().default(null),
    })
    .strict(),
  anniversary: z
    .object({
      ...base,
      name: title,
      calendar: z.enum(['gregorian', 'lunar']).default('gregorian'),
      date: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/),
      lunarLeapMonth: z.boolean().default(false),
      repeatYearly: z.boolean().default(true),
      leapPolicy: z.enum(['previous_day', 'next_day', 'skip']).default('previous_day'),
      countMode: z.enum(['exclude_today', 'include_today']).default('exclude_today'),
      category: text(100).default(''),
      description: text().default(''),
      noteRefs: z.array(ref).default([]),
      reminders: z.array(reminderRule).default([]),
    })
    .strict(),
  view: z
    .object({
      ...base,
      name: title,
      mode: z
        .enum(['tasks', 'board', 'calendar', 'timeline', 'matrix', 'overview'])
        .default('tasks'),
      filter: filters,
      sort: z.enum(['manual', 'due', 'priority', 'created', 'title']).default('manual'),
      groupBy: z.enum(['none', 'list', 'section', 'status', 'priority', 'tag']).default('none'),
    })
    .strict(),
  template: z
    .object({
      ...base,
      name: title,
      description: text().default(''),
      tasks: z
        .array(
          z
            .object({
              key: toDooId,
              parentKey: toDooId.nullable().default(null),
              title,
              description: text().default(''),
              criteria: text().default(''),
              estimateMinutes: z.number().int().min(0).nullable().default(null),
              noteRefs: z.array(ref).default([]),
            })
            .strict(),
        )
        .max(10000),
    })
    .strict(),
  review: z
    .object({
      ...base,
      name: title,
      from: toDooDate,
      to: toDooDate,
      content: text().default(''),
      listId: toDooId.nullable().default(null),
      noteRefs: z.array(ref).default([]),
      metrics: z.record(z.string(), z.number()).default({}),
      capturedAt: timestamp,
    })
    .strict(),
  plan: z
    .object({
      ...base,
      name: title,
      changes: z.array(toDooScheduleChangeSchema).max(1000),
      includeDependents: z.boolean().default(false),
      expectedRevisions: z
        .record(z.string().regex(/^(task|occurrence|timeBlock):[A-Za-z0-9_-]+$/), toDooId)
        .default({}),
      conflicts: z.array(text(2000)).default([]),
      appliedAt: timestamp.nullable().default(null),
      reason: text().default(''),
    })
    .strict(),
  reminderEvent: z
    .object({
      ...base,
      sourceType: z.enum(['task', 'habit', 'anniversary']),
      sourceId: toDooId,
      occurrenceKey: text(256),
      ruleId: toDooId,
      scheduleRevision: toDooId,
      scheduledAt: timestamp,
      firstRaisedAt: timestamp.nullable().default(null),
      userState: z
        .enum(['unread', 'read', 'acknowledged', 'dismissed', 'snoozed'])
        .default('unread'),
      snoozedUntil: timestamp.nullable().default(null),
      deliveryGeneration: z.number().int().min(0).default(0),
      title: text(256).default(''),
      message: text(2000).default(''),
    })
    .strict(),
  calendarSource: z
    .object({
      ...base,
      name: title,
      type: z.enum(['ics', 'csv', 'json']),
      enabled: z.boolean().default(false),
      color: text(40).default('#8b99b5'),
      metadata: z.record(z.string(), z.unknown()).default({}),
    })
    .strict(),
  calendarEvent: z
    .object({
      ...base,
      sourceId: toDooId.nullable().default(null),
      uid: text(1000),
      recurrenceId: text(256).nullable().default(null),
      title,
      description: text().default(''),
      start: toDooDateTimeSchema,
      end: toDooDateTimeSchema.nullable().default(null),
      allDay: z.boolean().default(false),
      rawRecurrence: text(2000).nullable().default(null),
      readOnly: z.boolean().default(false),
      component: z.enum(['VEVENT', 'VTODO']).default('VEVENT'),
      recurrenceTimeZone: zone.nullable().default(null),
      excludedDates: z.array(text(100)).default([]),
      additionalDates: z.array(text(100)).default([]),
      sourceStatus: text(100).nullable().default(null),
      rawSource: text().nullable().default(null),
      seriesMaster: z.boolean().default(false),
      expandedFromId: toDooId.nullable().default(null),
    })
    .strict(),
  calendarFeed: z
    .object({
      ...base,
      name: title,
      listIds: z.array(toDooId).default([]),
      includeDescription: z.boolean().default(false),
      includeCompleted: z.boolean().default(false),
      enabled: z.boolean().default(false),
    })
    .strict(),
  operation: z
    .object({
      ...base,
      kind: z.literal('outcome_note'),
      requestId: toDooId,
      fingerprint: text(128).min(1),
      occurrenceId: toDooId,
      expectedRevision: toDooId,
      title,
      folderPath: text(1024),
      fileName: text(256),
      content: text(),
      verification: z
        .enum(['self_assessed', 'practice', 'reviewed', 'delivered'])
        .default('self_assessed'),
      complete: z.boolean().default(false),
      criteriaResults: z
        .array(z.object({ label: text(1000), passed: z.boolean() }).strict())
        .default([]),
      noteId: toDooId.nullable().default(null),
      state: z.enum(['prepared', 'note_saved', 'completed', 'needs_reconciliation']),
    })
    .strict(),
  import: z
    .object({
      ...base,
      sourceType: z.enum(['ics', 'csv', 'json']),
      name: title,
      fingerprint: text(128),
      importedIds: z.array(toDooId).default([]),
      warnings: z.array(text(2000)).default([]),
    })
    .strict(),
};
export const toDooEntitySchemas = schemas;
export type ToDooEntityMap = { [K in keyof typeof schemas]: z.infer<(typeof schemas)[K]> };
export type ToDooEntityKind = keyof ToDooEntityMap;
export type ToDooEntity = ToDooEntityMap[ToDooEntityKind];
export type ToDooTask = ToDooEntityMap['task'];
export type ToDooOccurrence = ToDooEntityMap['occurrence'];
export type ToDooSettings = ToDooEntityMap['settings'];
export type ToDooPlan = ToDooEntityMap['plan'];
export type ToDooFilter = z.infer<typeof filters>;
export const TO_DOO_COLLECTIONS = {
  list: 'lists',
  section: 'sections',
  tag: 'tags',
  task: 'tasks',
  occurrence: 'occurrences',
  exception: 'exceptions',
  timeBlock: 'timeBlocks',
  outcome: 'outcomes',
  record: 'records',
  activity: 'activities',
  focusSession: 'focusSessions',
  habit: 'habits',
  habitEntry: 'habitEntries',
  anniversary: 'anniversaries',
  view: 'views',
  template: 'templates',
  review: 'reviews',
  plan: 'plans',
  reminderEvent: 'reminderEvents',
  calendarSource: 'calendarSources',
  calendarEvent: 'calendarEvents',
  calendarFeed: 'calendarFeeds',
  operation: 'operations',
  import: 'imports',
} as const;
export type ToDooCollections = {
  -readonly [K in keyof typeof TO_DOO_COLLECTIONS as (typeof TO_DOO_COLLECTIONS)[K]]: ToDooEntityMap[K][];
};
export type ToDooStatistics = {
  scope?: 'library' | 'period';
  from?: string;
  to?: string;
  completed: number;
  pending: number;
  overdue: number;
  focusMinutes: number;
  habitAmount: number;
  outcomes: number;
  byList: Record<string, { total: number; completed: number }>;
};
export type ToDooQuery = {
  kind?: ToDooEntityKind;
  kinds?: ToDooEntityKind[];
  ids?: string[];
  listIds?: string[];
  taskIds?: string[];
  includeTree?: boolean;
  view?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
  filter?: ToDooFilter;
  /** Trusted export/checkpoint consumers only; public query parsing must omit this. */ all?: boolean;
};
export type ToDooPage = {
  kind: ToDooEntityKind | null;
  total: number;
  limit: number;
  nextCursor: string | null;
  truncated: boolean;
  counts: Record<string, number>;
  from: string;
  to: string;
};
export type ToDooSnapshot = ToDooCollections & {
  page: ToDooPage;
  collectionPages?: Partial<Record<ToDooEntityKind, ToDooPage>>;
  datasetId: string;
  version: string;
  settings: ToDooSettings;
  statistics: ToDooStatistics;
  warnings: { code: string; message: string; entityId?: string }[];
  now: string;
};
export type ToDooStatusSelectionInput = {
  taskIds?: readonly string[];
  occurrenceId?: string;
  includeDescendants?: boolean;
  scope?: 'current' | 'range' | 'all_materialized';
  from?: string;
  to?: string;
  cascade?: boolean;
  status?: ToDooOccurrence['status'];
};
export function resolveToDooStatusSelection(
  data: { tasks: readonly ToDooTask[]; occurrences: readonly ToDooOccurrence[] },
  input: ToDooStatusSelectionInput,
) {
  const tasks = new Map(data.tasks.filter((t) => !t.deletedAt).map((t) => [t.id, t])),
    periods = new Map(data.occurrences.filter((o) => !o.deletedAt).map((o) => [o.id, o]));
  const selectedTasks = new Set<string>(),
    depths = new Map<string, number>(),
    actions = new Set<string>(),
    guards = new Set<string>();
  const requireTask = (id: string) => {
    const task = tasks.get(id);
    if (!task) throw new Error('任务资料尚未完整载入或已删除');
    return task;
  };
  const addTree = (root: ToDooOccurrence, cascade: boolean) => {
    const queue = [{ value: root, depth: 0 }],
      seen = new Set([root.id]);
    for (const { value, depth } of queue) {
      actions.add(value.id);
      guards.add(value.id);
      depths.set(value.id, Math.max(depths.get(value.id) ?? 0, depth));
      selectedTasks.add(requireTask(value.taskId).id);
      if (!cascade) continue;
      for (const child of periods.values()) {
        if (seen.has(child.id)) continue;
        const task = tasks.get(child.taskId);
        if (
          child.parentOccurrenceId === value.id ||
          (!child.parentOccurrenceId &&
            task?.parentTaskId === value.taskId &&
            !task.recurrence &&
            child.cycleKey === value.cycleKey)
        ) {
          seen.add(child.id);
          queue.push({ value: child, depth: depth + 1 });
        }
      }
    }
  };
  if (input.occurrenceId) {
    const root = periods.get(input.occurrenceId);
    if (!root) throw new Error('执行实例尚未完整载入或已删除');
    addTree(root, !!input.cascade);
    if (input.cascade && ['todo', 'doing', 'blocked'].includes(input.status ?? 'done')) {
      let parent = root.parentOccurrenceId;
      const seen = new Set<string>();
      while (parent) {
        if (seen.has(parent)) throw new Error('执行实例层级存在循环');
        seen.add(parent);
        const value = periods.get(parent);
        if (!value) throw new Error('上级执行实例尚未完整载入');
        if (value.status === 'done') {
          guards.add(value.id);
          selectedTasks.add(requireTask(value.taskId).id);
        }
        parent = value.parentOccurrenceId;
      }
    }
  } else {
    for (const id of input.taskIds ?? []) {
      requireTask(id);
      selectedTasks.add(id);
    }
    if (input.includeDescendants !== false) {
      let expanded = true;
      while (expanded) {
        expanded = false;
        for (const task of tasks.values())
          if (
            task.parentTaskId &&
            selectedTasks.has(task.parentTaskId) &&
            !selectedTasks.has(task.id)
          ) {
            selectedTasks.add(task.id);
            expanded = true;
          }
      }
    }
    const taskDepth = (task: ToDooTask) => {
      let n = 0,
        current = task;
      const seen = new Set<string>();
      while (current.parentTaskId && selectedTasks.has(current.parentTaskId)) {
        if (seen.has(current.id)) throw new Error('任务层级存在循环');
        seen.add(current.id);
        n++;
        current = requireTask(current.parentTaskId);
      }
      return n;
    };
    const ordered = [...selectedTasks]
      .map(requireTask)
      .sort((a, b) => taskDepth(a) - taskDepth(b) || a.id.localeCompare(b.id));
    const current = new Map<string, ToDooOccurrence>();
    for (const task of ordered) {
      let candidates = [...periods.values()]
        .filter((o) => o.taskId === task.id && ['todo', 'doing', 'blocked'].includes(o.status))
        .sort(
          (a, b) =>
            (a.scheduledDate ?? '').localeCompare(b.scheduledDate ?? '') ||
            a.id.localeCompare(b.id),
        );
      const parent = task.parentTaskId ? current.get(task.parentTaskId) : undefined;
      if (parent && task.inheritRecurrence && !task.recurrence)
        candidates = candidates.filter((o) => o.cycleKey === parent.cycleKey);
      if (candidates[0]) current.set(task.id, candidates[0]);
    }
    for (const task of ordered)
      for (const value of periods.values()) {
        if (value.taskId !== task.id || !['todo', 'doing', 'blocked'].includes(value.status))
          continue;
        const match =
          input.scope === 'range'
            ? !!value.scheduledDate &&
              (!input.from || value.scheduledDate >= input.from) &&
              (!input.to || value.scheduledDate <= input.to)
            : input.scope === 'all_materialized'
              ? true
              : current.get(task.id)?.id === value.id;
        if (match) addTree(value, input.includeDescendants !== false);
      }
  }
  const expectedRevisions: Record<string, string> = {};
  for (const id of selectedTasks) expectedRevisions[id] = requireTask(id).revision;
  for (const id of guards) expectedRevisions[id] = periods.get(id)!.revision;
  return {
    taskIds: [...selectedTasks].sort(),
    occurrenceIds: [...guards].sort(),
    leafFirstOccurrenceIds: [...actions].sort(
      (a, b) => (depths.get(b) ?? 0) - (depths.get(a) ?? 0) || a.localeCompare(b),
    ),
    expectedRevisions,
  };
}
const expected = z.record(z.string(), toDooId);
const common = { requestId: toDooId };
const saveEntity = z
  .object({
    ...common,
    action: z.literal('save_entity'),
    payload: z
      .object({
        kind: z.enum(Object.keys(schemas) as [ToDooEntityKind, ...ToDooEntityKind[]]),
        entity: z.record(z.string(), z.unknown()),
        expectedRevision: toDooId.optional(),
      })
      .strict(),
  })
  .strict();
const taskPatch = z
  .object(
    Object.fromEntries(
      Object.entries(taskFields).map(([key, schema]) => [
        key,
        schema instanceof z.ZodDefault ? schema.removeDefault().optional() : schema.optional(),
      ]),
    ),
  )
  .strict();
const taskDraft = z
  .object({
    ...taskFields,
    id: toDooId.optional(),
    due: toDooDateTimeSchema.nullable().optional(),
    plan: toDooDateTimeSchema.nullable().optional(),
    reminders: z.array(reminderRule).max(20).optional(),
  })
  .strict();
export const toDooCommandSchema = z.discriminatedUnion('action', [
  saveEntity,
  z
    .object({
      ...common,
      action: z.literal('save_outcome'),
      payload: z
        .object({
          occurrenceId: toDooId,
          expectedRevision: toDooId,
          outcome: z
            .object({
              id: toDooId.optional(),
              summary: text(),
              verification: z
                .enum(['self_assessed', 'practice', 'reviewed', 'delivered'])
                .default('self_assessed'),
              criteriaResults: z
                .array(z.object({ label: text(1000), passed: z.boolean() }).strict())
                .default([]),
              evidenceRefs: z.array(ref).default([]),
            })
            .strict(),
          complete: z.boolean().default(false),
          operationId: toDooId.optional(),
          cascade: z.boolean().default(false),
          expectedOccurrenceIds: z.array(toDooId).max(10000).optional(),
          expectedRevisions: expected.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal('attach_asset'),
      payload: z
        .object({ taskId: toDooId, expectedRevision: toDooId, attachment: toDooAttachmentSchema })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal('detach_asset'),
      payload: z
        .object({
          taskId: toDooId,
          expectedRevision: toDooId,
          hash: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
    })
    .strict(),
  z.object({ ...common, action: z.literal('create_task'), payload: taskDraft }).strict(),
  z
    .object({
      ...common,
      action: z.literal('update_task'),
      payload: z.object({ id: toDooId, expectedRevision: toDooId, patch: taskPatch }).strict(),
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal('set_occurrence_status'),
      payload: z
        .object({
          id: toDooId,
          expectedRevision: toDooId,
          status: toDooStatusSchema,
          cascade: z.boolean().default(false),
          expectedOccurrenceIds: z.array(toDooId).max(10000).optional(),
          expectedRevisions: expected.optional(),
          resultSummary: text().optional(),
          at: timestamp.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal('batch_tasks'),
      payload: z
        .object({
          ids: z.array(toDooId).min(1).max(1000),
          expectedRevisions: expected,
          operation: z.enum(['patch', 'complete', 'cancel', 'delete', 'restore', 'move', 'copy']),
          patch: taskPatch.optional(),
          listId: toDooId.nullable().optional(),
          parentTaskId: toDooId.nullable().optional(),
          includeDescendants: z.boolean().default(true),
          occurrenceIds: z.array(toDooId).max(10000).optional(),
          scope: z.enum(['current', 'range', 'all_materialized']).default('current'),
          from: toDooDate.optional(),
          to: toDooDate.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal('delete_entity'),
      payload: z
        .object({
          kind: z.enum(Object.keys(schemas) as [ToDooEntityKind, ...ToDooEntityKind[]]),
          id: toDooId,
          expectedRevision: toDooId,
          restore: z.boolean().default(false),
          cascade: z.boolean().default(false),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal('materialize_occurrences'),
      payload: z.object({ taskId: toDooId, from: toDooDate, to: toDooDate }).strict(),
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal('change_recurrence'),
      payload: z
        .object({
          taskId: toDooId,
          expectedRevision: toDooId,
          rule: toDooRecurrenceSchema.nullable(),
          scope: z.enum(['all', 'future']),
          from: toDooDate.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal('start_focus'),
      payload: z
        .object({
          mode: z.enum(['pomodoro', 'stopwatch', 'break']),
          occurrenceId: toDooId.nullable().default(null),
          listId: toDooId.nullable().default(null),
          targetMinutes: z.number().int().positive().max(1440).nullable().default(null),
          at: timestamp.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal('control_focus'),
      payload: z
        .object({
          id: toDooId,
          expectedRevision: toDooId,
          operation: z.enum(['pause', 'resume', 'finish', 'cancel', 'correct', 'takeover']),
          at: timestamp.optional(),
          correctedMinutes: z.number().min(0).max(525600).optional(),
          note: text().optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal('checkin_habit'),
      payload: z
        .object({
          habitId: toDooId,
          localDate: toDooDate,
          amount: z.number().positive().max(1000000).default(1),
          note: text().default(''),
          skipped: z.boolean().default(false),
          at: timestamp.optional(),
          sourceSessionId: toDooId.nullable().default(null),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal('apply_template'),
      payload: z
        .object({
          templateId: toDooId,
          listId: toDooId.nullable(),
          titlePrefix: text(100).default(''),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal('preview_plan'),
      payload: z
        .object({
          name: title,
          changes: schemas.plan.shape.changes,
          reason: text().default(''),
          includeDependents: z.boolean().default(false),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal('apply_plan'),
      payload: z.object({ plan: schemas.plan }).strict(),
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal('import_entities'),
      payload: z
        .object({
          entities: z
            .array(
              z
                .object({
                  kind: z.enum(Object.keys(schemas) as [ToDooEntityKind, ...ToDooEntityKind[]]),
                  entity: z.record(z.string(), z.unknown()),
                  expectedRevision: toDooId.optional(),
                })
                .strict(),
            )
            .max(10000),
        })
        .strict(),
    })
    .strict(),
]);
export type ToDooCommand = z.input<typeof toDooCommandSchema>;
export type ParsedToDooCommand = z.output<typeof toDooCommandSchema>;
export type ToDooCommandResult = {
  transactionId: string | null;
  replayed: boolean;
  changed: { kind: ToDooEntityKind; id: string; revision: string }[];
  ids: string[];
  snapshot: ToDooSnapshot;
  preview?: ToDooPlan;
};
export type ToDooPortableReceipt = {
  transactionId: string;
  requestId: string;
  fingerprint: string;
  ids: string[];
  changed: { kind: ToDooEntityKind; id: string; revision: string }[];
};
export type ToDooCheckpoint = {
  format: 1;
  appId: 'to-doo';
  datasetId: string;
  createdAt: string;
  entities: { kind: ToDooEntityKind; entity: ToDooEntity }[];
  transactions: unknown[];
  receipts: ToDooPortableReceipt[];
  assets: { hash: string; data: string }[];
  digest: string;
};
export type ToDooCommandContext = { allowedTaskIds?: readonly string[] };
export type ToDooService = {
  snapshot(query?: ToDooQuery): ToDooSnapshot;
  command(input: ToDooCommand | unknown, context?: ToDooCommandContext): ToDooCommandResult;
  getEntity(kind: ToDooEntityKind, id: string): ToDooEntity | undefined;
  getReceipt(requestId: string): ToDooPortableReceipt | undefined;
  exportCheckpoint(): ToDooCheckpoint;
  importCheckpoint(
    checkpoint: ToDooCheckpoint,
    requestId: string,
    options?: { expectedRevisions?: Record<string, string> },
  ): ToDooCommandResult;
  close(): void;
};
