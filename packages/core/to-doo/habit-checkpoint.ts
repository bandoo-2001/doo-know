import type { AppDatabase } from '../db.js';
import type { ToDooCommandResult, ToDooEntityMap, ToDooService } from '../../../shared/to-doo-contracts.js';
import { canonical, parseEntity, toDooError, toDooHash, type PortableTransaction } from './store.js';

type Habit = ToDooEntityMap['habit'];
type Checkpoint = NonNullable<Habit['reminderCheckpoint']>;
export type HabitCheckpointWrite = {
  requestId: string;
  habitId: string;
  expectedRevision: string;
  checkpoint: Checkpoint;
  events: Record<string, unknown>[];
};
const writers = new WeakMap<ToDooService, (input: HabitCheckpointWrite) => ToDooCommandResult>();
export function registerHabitCheckpointWriter(service: ToDooService, writer: (input: HabitCheckpointWrite) => ToDooCommandResult) {
  writers.set(service, writer);
}
export function writeHabitCheckpoint(service: ToDooService, input: HabitCheckpointWrite) {
  const writer = writers.get(service);
  if (!writer) toDooError('习惯提醒内部写入能力不可用', 503);
  return writer(input);
}
function eventValue(value: Record<string, unknown>) {
  const { revision: _revision, createdAt: _createdAt, updatedAt: _updatedAt, ...event } = parseEntity('reminderEvent', {
    ...value, revision: 'internal-checkpoint', createdAt: '2000-01-01T00:00:00Z', updatedAt: '2000-01-01T00:00:00Z',
  });
  return event;
}
/** This action is deliberately absent from the public command schema. */
export function habitCheckpointInput(input: HabitCheckpointWrite) {
  const events = input.events.map(eventValue).sort((a, b) => a.id.localeCompare(b.id));
  if (events.length > 1 || events.some(event => event.sourceType !== 'habit' ||
      event.sourceId !== input.habitId || !event.occurrenceKey.startsWith('history:') ||
      !event.ruleId.startsWith('history_') || !!event.deletedAt))
    toDooError('习惯提醒内部写入范围无效', 400);
  return { internalAction: 'habit.reminder-checkpoint', requestId: input.requestId,
    habitId: input.habitId, expectedRevision: input.expectedRevision, checkpoint: input.checkpoint, events };
}
function habitValue(habit: Habit) {
  const { revision: _revision, updatedAt: _updatedAt, reminderCheckpoint: _checkpoint, ...value } = habit;
  return value;
}
/** Accept only a complete chain of authenticated internal metadata writes. */
export function isHabitCheckpointContinuation(db: AppDatabase, habit: Habit, expectedRevision: string) {
  if (!db.inTransaction) return false;
  // Bound work by recent global history, not only by the number of matching
  // habit rows. Older clients conservatively refresh instead of scanning a library.
  const rows = db.prepare(`SELECT t.data FROM todo_transactions t WHERE t.sequence >= COALESCE(
    (SELECT sequence FROM todo_transactions ORDER BY sequence DESC LIMIT 1 OFFSET 4095), 0
  ) AND EXISTS(
    SELECT 1 FROM json_each(t.data,'$.members') m
    WHERE json_extract(m.value,'$.kind')='habit' AND json_extract(m.value,'$.id')=?
  ) ORDER BY t.sequence DESC LIMIT 65`).all(habit.id) as { data: string }[];
  const history = rows.map(row => JSON.parse(row.data) as PortableTransaction);
  const revisions = new Map<string, { transaction: PortableTransaction; member: PortableTransaction['members'][number] }>();
  for (const transaction of history) {
    const member = transaction.members.find(row => row.kind === 'habit' && row.id === habit.id);
    if (!member || revisions.has(member.after.revision)) return false;
    revisions.set(member.after.revision, { transaction, member });
  }
  const currentRow = db.prepare("SELECT envelope FROM todo_entities WHERE kind='habit' AND id=?").get(habit.id) as { envelope: string } | undefined;
  if (!currentRow) return false;
  const current = JSON.parse(currentRow.envelope);
  if (canonical(current.data) !== canonical(habit)) return false;
  let revision = habit.revision;
  const seen = new Set<string>();
  while (revision !== expectedRevision) {
    if (seen.has(revision) || seen.size >= 64) return false;
    seen.add(revision);
    const step = revisions.get(revision);
    if (!step || (revision === habit.revision && step.transaction.id !== current.lastTransactionId)) return false;
    const before = step.member.fromRevision && revisions.get(step.member.fromRevision);
    if (!before) return false;
    const afterHabit = parseEntity('habit', step.member.after.data);
    const beforeHabit = parseEntity('habit', before.member.after.data);
    if (!afterHabit.reminderCheckpoint || canonical(habitValue(afterHabit)) !== canonical(habitValue(beforeHabit))) return false;
    if (step.transaction.members.some(member => member !== step.member && member.kind !== 'reminderEvent')) return false;
    const events = step.transaction.members.filter(member => member !== step.member);
    if (events.some(member => member.fromRevision !== null)) return false;
    try {
      const input = habitCheckpointInput({ requestId: step.transaction.requestId, habitId: habit.id,
        expectedRevision: beforeHabit.revision, checkpoint: afterHabit.reminderCheckpoint,
        events: events.map(member => member.after.data as unknown as Record<string, unknown>) });
      if (toDooHash(canonical(input)) !== step.transaction.fingerprint) return false;
    } catch { return false; }
    revision = beforeHabit.revision;
  }
  return true;
}
