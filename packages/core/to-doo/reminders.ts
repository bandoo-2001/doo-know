import { createHash } from 'node:crypto';
import type { AppDatabase } from '../db.js';
import type {
  ToDooCommand,
  ToDooEntityMap,
  ToDooService,
  ToDooSnapshot,
} from '../../../shared/to-doo-contracts.js';
import type { ToDooReminderCard, ToDooReminderFeed } from '../../../shared/to-doo-reminders.js';
import { summarizeHabitPeriod } from '../../../shared/to-doo-habits.js';
import { quietHoursEnd, reminderSourceValid, ToDooNotificationError } from './notifications.js';

type Reminder = ToDooEntityMap['reminderEvent'];
export type ToDooReminderOptions = { db: AppDatabase; now?: () => Date };
type CompleteInput = { requestId: string; expectedRevision: string; amount?: number };
type ActionReceipt = {
  fingerprint: string;
  command: string | null;
  acknowledgement: string;
  response: string | null;
};
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const history = (event: Reminder) =>
  event.sourceType === 'habit' &&
  event.occurrenceKey.startsWith('history:') &&
  event.ruleId.startsWith('history_');
const dueAt = (event: Reminder) =>
  Date.parse(
    event.userState === 'snoozed' ? (event.snoozedUntil ?? event.scheduledAt) : event.scheduledAt,
  );
const gone = () => new ToDooNotificationError('提醒已失效，请在通知中心查看', 410);

export function createToDooReminders(service: ToDooService, options: ToDooReminderOptions) {
  const db = options.db;
  const now = options.now ?? (() => new Date());
  db.exec(`CREATE TABLE IF NOT EXISTS to_doo_reminder_actions(
    request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, command TEXT,
    acknowledgement TEXT NOT NULL, response TEXT
  )`);
  function resolve(
    state: ToDooSnapshot,
    event: Reminder,
    allowCompleted = false,
  ): ToDooReminderCard {
    if (!reminderSourceValid(state, event, now(), allowCompleted)) throw gone();
    if (history(event)) return { event, section: 'notifications', completion: 'open' };
    if (event.sourceType === 'task') {
      const task = state.tasks.find((t) => t.id === event.sourceId)!;
      const occurrence = state.occurrences.find(
        (o) => o.taskId === task.id && o.cycleKey === event.occurrenceKey && !o.deletedAt,
      )!;
      const complex =
        !!task.criteria.trim() ||
        state.tasks.some((t) => !t.deletedAt && t.parentTaskId === task.id);
      return {
        event,
        section: 'tasks',
        taskId: task.id,
        occurrenceId: occurrence.id,
        ...(occurrence.scheduledDate || occurrence.due?.date
          ? { date: occurrence.scheduledDate ?? occurrence.due!.date }
          : {}),
        completion: complex ? 'open' : 'task',
      };
    }
    if (event.sourceType === 'habit') {
      const habit = state.habits.find((h) => h.id === event.sourceId)!;
      const summary = summarizeHabitPeriod(habit, state.habitEntries, event.occurrenceKey);
      return {
        event,
        section: 'habits',
        date: event.occurrenceKey,
        completion: 'habit',
        habit: { amount: summary.amount, target: summary.target, unit: summary.rule.unit },
      };
    }
    return {
      event,
      section: 'anniversaries',
      date: event.occurrenceKey,
      completion: 'acknowledge',
    };
  }
  function pending(): ToDooReminderFeed {
    const state = service.snapshot({ all: true });
    const at = now();
    const result: ToDooReminderFeed = {
      reminders: [],
      missedCount: 0,
      timeZone: state.settings.timeZone,
    };
    if (quietHoursEnd(at, state.settings.quietHours)) return result;
    const events = state.reminderEvents
      .filter(
        (event) =>
          !event.deletedAt &&
          !history(event) &&
          (event.userState === 'unread' || event.userState === 'snoozed') &&
          dueAt(event) <= at.getTime(),
      )
      .sort((a, b) => dueAt(a) - dueAt(b) || a.id.localeCompare(b.id));
    for (const event of events) {
      if (!reminderSourceValid(state, event, at)) continue;
      if (event.deliveryGeneration === 0 && dueAt(event) < at.getTime() - 15 * 60000)
        result.missedCount++;
      else if (result.reminders.length < 50) result.reminders.push(resolve(state, event));
    }
    return result;
  }
  function get(id: string): ToDooReminderCard {
    const state = service.snapshot({ all: true });
    const event = state.reminderEvents.find((e) => e.id === id);
    if (!event) throw new ToDooNotificationError('未找到这条提醒', 404);
    if (
      event.deletedAt ||
      ['acknowledged', 'dismissed'].includes(event.userState) ||
      dueAt(event) > now().getTime()
    )
      throw gone();
    return resolve(state, event);
  }
  function complete(id: string, input: CompleteInput): { event: Reminder; replayed: boolean } {
    if (
      !/^[A-Za-z0-9_-]{1,128}$/.test(input.requestId) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(input.expectedRevision) ||
      (input.amount !== undefined &&
        (!Number.isFinite(input.amount) || input.amount <= 0 || input.amount > 1000000))
    )
      throw new ToDooNotificationError('完成请求无效，请刷新后重试');
    const requestKey =
      'reminder_' + hash([service.snapshot().datasetId, input.requestId]).slice(0, 40);
    const fingerprint = hash([id, input.expectedRevision, input.amount ?? null]);
    let receipt = db
      .prepare(
        'SELECT fingerprint,command,acknowledgement,response FROM to_doo_reminder_actions WHERE request_id=?',
      )
      .get(requestKey) as ActionReceipt | undefined;
    const replayed = !!receipt;
    if (receipt && receipt.fingerprint !== fingerprint)
      throw new ToDooNotificationError('相同请求标识携带不同内容，请刷新后重试', 409);
    if (receipt?.response) return { ...JSON.parse(receipt.response), replayed: true };
    if (!receipt) {
      const state = service.snapshot({ all: true });
      const event = state.reminderEvents.find((e) => e.id === id);
      if (!event) throw new ToDooNotificationError('未找到这条提醒', 404);
      if (event.revision !== input.expectedRevision)
        throw new ToDooNotificationError('对应事项已更新，请刷新后重试', 409);
      if (
        event.deletedAt ||
        ['acknowledged', 'dismissed'].includes(event.userState) ||
        dueAt(event) > now().getTime()
      )
        throw gone();
      const card = resolve(state, event, true);
      if (card.completion === 'open')
        throw new ToDooNotificationError('请打开事项填写完成信息', 409);
      if (input.amount !== undefined && card.completion !== 'habit')
        throw new ToDooNotificationError('仅习惯打卡可以填写数量');
      let command: ToDooCommand | null = null;
      if (card.completion === 'task') {
        const occurrence = state.occurrences.find((o) => o.id === card.occurrenceId)!;
        if (occurrence.status !== 'done')
          command = {
            requestId: requestKey + '_source',
            action: 'set_occurrence_status',
            payload: {
              id: occurrence.id,
              expectedRevision: occurrence.revision,
              status: 'done',
              cascade: false,
            },
          };
      } else if (card.completion === 'habit' && card.habit!.amount < card.habit!.target) {
        if (input.amount === undefined && card.habit!.target !== 1)
          throw new ToDooNotificationError('请填写本次完成数量');
        command = {
          requestId: requestKey + '_source',
          action: 'checkin_habit',
          payload: {
            habitId: event.sourceId,
            localDate: event.occurrenceKey,
            amount: input.amount ?? 1,
          },
        };
      }
      const acknowledgement: ToDooCommand = {
        requestId: requestKey + '_ack',
        action: 'save_entity',
        payload: {
          kind: 'reminderEvent',
          entity: { ...event, userState: 'acknowledged', snoozedUntil: null },
          expectedRevision: event.revision,
        },
      };
      receipt = {
        fingerprint,
        command: command ? JSON.stringify(command) : null,
        acknowledgement: JSON.stringify(acknowledgement),
        response: null,
      };
      db.prepare(
        'INSERT INTO to_doo_reminder_actions(request_id,fingerprint,command,acknowledgement) VALUES(?,?,?,?)',
      ).run(requestKey, fingerprint, receipt.command, receipt.acknowledgement);
    }
    if (receipt.command) {
      const command = JSON.parse(receipt.command) as ToDooCommand;
      // A failed attempt may only resume an action whose original source is still valid.
      if (!service.getReceipt(command.requestId)) {
        const state = service.snapshot({ all: true });
        const event = state.reminderEvents.find((e) => e.id === id);
        if (!event || event.revision !== input.expectedRevision)
          throw new ToDooNotificationError('对应事项已更新，请刷新后重试', 409);
        const card = resolve(state, event, true);
        if (card.completion === 'open')
          throw new ToDooNotificationError('请打开事项填写完成信息', 409);
        const achieved =
          card.completion === 'habit'
            ? card.habit!.amount >= card.habit!.target
            : card.completion === 'task' &&
              state.occurrences.find((o) => o.id === card.occurrenceId)?.status === 'done';
        if (achieved) {
          receipt.command = null;
          db.prepare('UPDATE to_doo_reminder_actions SET command=NULL WHERE request_id=?').run(
            requestKey,
          );
        }
      }
      if (receipt.command) service.command(command);
    }
    const acknowledgement = JSON.parse(receipt.acknowledgement) as ToDooCommand;
    if (!receipt.command && !service.getReceipt(acknowledgement.requestId)) {
      const state = service.snapshot({ all: true });
      const event = state.reminderEvents.find((e) => e.id === id);
      if (!event || event.revision !== input.expectedRevision)
        throw new ToDooNotificationError('对应事项已更新，请刷新后重试', 409);
      resolve(state, event, true);
    }
    service.command(acknowledgement);
    const event = service.getEntity('reminderEvent', id) as Reminder;
    const result = { event, replayed };
    db.prepare('UPDATE to_doo_reminder_actions SET response=? WHERE request_id=?').run(
      JSON.stringify(result),
      requestKey,
    );
    return result;
  }
  return { pending, get, complete };
}
