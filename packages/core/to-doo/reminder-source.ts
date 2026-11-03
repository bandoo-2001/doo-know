import { toDooDate, type ToDooSnapshot, type ToDooReminderSource } from '../../../shared/to-doo-contracts.js';
import { toDooError } from './store.js';

/** History navigation is separate from whether a reminder can still be acted on. */
export function resolveToDooReminderSource(state: ToDooSnapshot, id: string): ToDooReminderSource {
  const event = state.reminderEvents.find((row) => row.id === id && !row.deletedAt);
  if (!event) toDooError('未找到这条提醒', 404);
  const source = { sourceId: event.sourceId, sourceType: event.sourceType };
  const gone = () => toDooError('提醒来源已移除或执行记录不再可用', 410, 'TO_DOO_SOURCE_GONE');
  if (event.sourceType === 'task') {
    const task = state.tasks.find((row) => row.id === event.sourceId && !row.deletedAt);
    const occurrence = state.occurrences.find(
      (row) => row.taskId === task?.id && row.cycleKey === event.occurrenceKey && !row.deletedAt,
    );
    if (!task || !occurrence) return gone();
    return {
      ...source,
      section: 'tasks',
      taskId: task.id,
      occurrenceId: occurrence.id,
      ...(occurrence.scheduledDate || occurrence.due?.date
        ? { date: occurrence.scheduledDate ?? occurrence.due!.date }
        : {}),
    };
  }
  const entity =
    event.sourceType === 'habit'
      ? state.habits.find((row) => row.id === event.sourceId && !row.deletedAt)
      : state.anniversaries.find((row) => row.id === event.sourceId && !row.deletedAt);
  if (!entity) return gone();
  return {
    ...source,
    section:
      event.sourceType === 'habit' && event.occurrenceKey.startsWith('history:')
        ? 'notifications'
        : event.sourceType === 'habit'
          ? 'habits'
          : 'anniversaries',
    ...(toDooDate.safeParse(event.occurrenceKey).success ? { date: event.occurrenceKey } : {}),
  };
}
