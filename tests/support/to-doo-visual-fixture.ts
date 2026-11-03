import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { BrowserContext, Page } from '@playwright/test';

export const VISUAL_NOW = '2026-10-30T09:00:00.000Z';
export const VISUAL_ORIGIN = `http://127.0.0.1:${process.env.DOOKNOW_E2E_WEB_PORT || 4179}`;
export async function authenticateVisualContext(context: BrowserContext) {
  const config = JSON.parse(await readFile('.local/e2e-config.json', 'utf8'));
  const root = dirname(resolve(config.dataRoot));
  if (
    dirname(root) !== resolve(tmpdir()) ||
    !root.split('/').at(-1)?.startsWith('dooknow-browser-')
  )
    throw Error('Visual acceptance must use an isolated temporary dataset');
  const cookies = JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8'));
  // Session cookies keep a historical business clock reproducible after their wall-clock expiry.
  await context.addCookies(cookies.map(({ expires: _expires, ...cookie }: any) => cookie));
}
export async function seedToDooVisual(page: Page) {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const headers = { origin: VISUAL_ORIGIN, 'x-csrf-token': csrf.token };
  async function command(action: string, payload: Record<string, unknown>) {
    const response = await page.request.post('/api/to-doo/commands', {
      headers,
      data: { requestId: crypto.randomUUID(), action, payload },
    });
    if (!response.ok())
      throw Error(
        'Visual fixture ' + action + ': ' + response.status() + ' ' + (await response.text()),
      );
    return response.json();
  }
  const initial = await (await page.request.get('/api/to-doo/state')).json();
  if (initial.now !== VISUAL_NOW)
    throw Error('Visual acceptance requires its fixed clock and an empty task dataset');
  if (initial.tasks.length) {
    const marker = await readFile('.local/to-doo-visual-seed.json', 'utf8')
      .then(JSON.parse)
      .catch(() => null);
    if (
      marker?.datasetId === initial.datasetId &&
      initial.tasks.every((task: any) => task.id.startsWith('visual-'))
    )
      return marker;
    throw Error('The visual seed is incomplete; start a fresh isolated browser fixture');
  }
  const save = (kind: string, entity: Record<string, unknown>) =>
    command('save_entity', { kind, entity });
  for (const entity of [
    { id: 'visual-work', name: '工作与创造', kind: 'list', color: '#4566c6' },
    {
      id: 'visual-growth',
      name: '保持阅读与学习',
      kind: 'goal',
      goalDate: '2026-12-31',
      description: '持续学习，把收获变成行动。',
      color: '#538775',
    },
  ])
    await save('list', entity);
  for (const entity of [
    { id: 'visual-writing', name: '写作', color: '#4566c6' },
    { id: 'visual-reading', name: '阅读', color: '#538775' },
  ])
    await save('tag', entity);
  const tasks = [
    {
      id: 'visual-next-step',
      title: '整理项目的下一步',
      listId: 'visual-work',
      description: '把重要的事变成清晰、可执行的下一步。',
      priority: 'high',
      importance: 'important',
      urgentOverride: true,
      due: { date: '2026-10-31', time: '17:00', timeZone: 'UTC' },
      tagIds: ['visual-writing'],
    },
    {
      id: 'visual-read-plan',
      title: '梳理本周的阅读计划',
      listId: 'visual-growth',
      priority: 'normal',
      importance: 'important',
      urgentOverride: false,
      tagIds: ['visual-reading'],
    },
    {
      id: 'visual-reply',
      title: '回复合作伙伴的反馈',
      listId: 'visual-work',
      priority: 'normal',
      urgentOverride: true,
    },
    {
      id: 'visual-notes',
      title: '整理一份读书笔记',
      listId: 'visual-growth',
      importance: 'normal',
      urgentOverride: false,
    },
    {
      id: 'visual-finished',
      title: '完成一章阅读与练习',
      listId: 'visual-growth',
      importance: 'normal',
      urgentOverride: false,
    },
  ];
  for (const task of tasks) await command('create_task', task);
  let state = await (await page.request.get('/api/to-doo/state')).json();
  const occurrence = (id: string) => state.occurrences.find((row: any) => row.taskId === id);
  for (const [id, status] of [
    ['visual-next-step', 'doing'],
    ['visual-finished', 'done'],
  ])
    await command('set_occurrence_status', {
      id: occurrence(id).id,
      expectedRevision: occurrence(id).revision,
      status,
      ...(status === 'done' ? { at: '2026-10-30T08:30:00Z' } : {}),
    });
  state = await (await page.request.get('/api/to-doo/state')).json();
  for (const entity of [
    {
      id: 'visual-plan',
      title: '专心整理下一步',
      occurrenceId: occurrence('visual-next-step').id,
      start: { date: '2026-10-30', time: '09:00', timeZone: 'UTC' },
      durationMinutes: 45,
    },
    {
      id: 'visual-reading-time',
      title: '安静的阅读时间',
      occurrenceId: occurrence('visual-read-plan').id,
      start: { date: '2026-10-29', time: '14:00', timeZone: 'UTC' },
      durationMinutes: 60,
    },
    {
      id: 'visual-walk',
      title: '散步与放空',
      occurrenceId: null,
      start: { date: '2026-10-31', time: '17:00', timeZone: 'UTC' },
      durationMinutes: 30,
    },
  ])
    await save('timeBlock', entity);
  await command('import_entities', {
    entities: [
      {
        kind: 'calendarSource',
        entity: { id: 'visual-external', name: '学习日历', type: 'ics', enabled: true },
      },
      {
        kind: 'calendarEvent',
        entity: {
          id: 'visual-course',
          sourceId: 'visual-external',
          uid: 'visual-course',
          title: '公开课：如何保持专注',
          start: { date: '2026-10-30', time: '15:00', timeZone: 'UTC' },
          end: { date: '2026-10-30', time: '16:00', timeZone: 'UTC' },
          readOnly: true,
        },
      },
    ],
  });
  for (const entity of [
    { id: 'visual-habit-read', name: '阅读', unit: '页', target: 20, frequency: 'daily' },
    { id: 'visual-habit-run', name: '运动', unit: '次', target: 3, frequency: 'weekly' },
    { id: 'visual-habit-english', name: '练习英语', unit: '分钟', target: 15, frequency: 'daily' },
  ])
    await save('habit', { ...entity, startDate: '2026-10-01', listId: 'visual-growth' });
  for (const [habitId, amount, localDate] of [
    ['visual-habit-read', 10, '2026-10-30'],
    ['visual-habit-run', 2, '2026-10-29'],
    ['visual-habit-english', 15, '2026-10-30'],
  ])
    await command('checkin_habit', { habitId, amount, localDate });
  await save('anniversary', {
    id: 'visual-birthday',
    name: '家人的生日',
    date: '2000-10-31',
    category: '生日',
  });
  await save('anniversary', {
    id: 'visual-autumn',
    name: '中秋团圆',
    calendar: 'lunar',
    date: '2000-08-15',
    category: '传统节日',
  });
  for (const entity of [
    { id: 'visual-focus-read', name: '阅读与学习', listId: 'visual-growth', color: '#538775' },
    { id: 'visual-focus-work', name: '工作与创造', listId: 'visual-work', color: '#4566c6' },
    {
      id: 'visual-focus-archive',
      name: '已经完成的学习计划',
      listId: 'visual-growth',
      archivedAt: '2026-10-01T00:00:00Z',
    },
  ])
    await save('focusTopic', entity);
  for (const entity of [
    {
      id: 'visual-session-read',
      topicId: 'visual-focus-read',
      listId: 'visual-growth',
      note: '阅读了20页，整理了两点想法。',
      segments: [{ start: '2026-10-30T08:00:00Z', end: '2026-10-30T08:25:00Z' }],
    },
    {
      id: 'visual-session-work',
      topicId: 'visual-focus-work',
      listId: 'visual-work',
      occurrenceId: occurrence('visual-next-step').id,
      note: '把复杂的问题拆成三个可行动的步骤。',
      segments: [{ start: '2026-10-29T14:00:00Z', end: '2026-10-29T15:10:00Z' }],
    },
    {
      id: 'visual-session-archive',
      topicId: 'visual-focus-archive',
      listId: 'visual-growth',
      note: '已归档，记录继续保留。',
      segments: [{ start: '2026-10-28T08:00:00Z', end: '2026-10-28T08:30:00Z' }],
    },
  ])
    await save('focusSession', { ...entity, mode: 'pomodoro', status: 'finished' });
  await save('record', {
    id: 'visual-record',
    content: '把阅读中的方法整理成可执行的清单。',
    listId: 'visual-growth',
    sourceSessionId: 'visual-session-read',
    occurredAt: '2026-10-30T08:30:00Z',
    minutes: 25,
  });
  await command('save_entity', {
    kind: 'review',
    entity: {
      id: 'visual-review',
      name: '本周复盘',
      from: '2026-10-24',
      to: '2026-10-30',
      content: '持续阅读，减少分心。下周为最重要的任务留出完整的专注时间。',
      capturedAt: VISUAL_NOW,
    },
    captureMetrics: true,
  });
  await command('import_entities', {
    entities: [
      {
        kind: 'reminderEvent',
        entity: {
          id: 'visual-reminder-unread',
          sourceType: 'task',
          sourceId: 'visual-next-step',
          occurrenceKey: occurrence('visual-next-step').cycleKey,
          ruleId: 'visual-old-rule',
          scheduleRevision: 'visual-old-schedule',
          scheduledAt: '2026-10-30T08:00:00Z',
          firstRaisedAt: '2026-10-30T08:00:00Z',
          title: '整理项目的下一步',
          message: '给今天最重要的事留出时间。',
          userState: 'acknowledged',
        },
      },
      {
        kind: 'reminderEvent',
        entity: {
          id: 'visual-reminder-handled',
          sourceType: 'habit',
          sourceId: 'visual-habit-read',
          occurrenceKey: '2026-10-29',
          ruleId: 'visual-old-habit-rule',
          scheduleRevision: 'visual-old-habit-schedule',
          scheduledAt: '2026-10-29T08:00:00Z',
          firstRaisedAt: '2026-10-29T08:00:00Z',
          title: '阅读',
          message: '记录一点积累。',
          userState: 'dismissed',
        },
      },
    ],
  });
  const result = {
    taskId: 'visual-next-step',
    occurrenceId: occurrence('visual-next-step').id,
    datasetId: initial.datasetId,
  };
  await writeFile('.local/to-doo-visual-seed.json', JSON.stringify(result));
  return result;
}
