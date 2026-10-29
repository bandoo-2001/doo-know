import { expect, it } from 'vitest';
import { toDooEntitySchemas } from '../shared/to-doo-contracts';
import { getHabitPeriod, summarizeHabitPeriod, habitStreak } from '../shared/to-doo-habits';
const common = {
  id: 'habit',
  revision: 'revision',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};
const habit = (extra: Record<string, unknown> = {}) =>
  toDooEntitySchemas.habit.parse({
    ...common,
    name: 'Read',
    startDate: '2026-10-26',
    target: 1,
    ...extra,
  });
const entry = (date: string, amount: number, extra: Record<string, unknown> = {}) =>
  toDooEntitySchemas.habitEntry.parse({
    ...common,
    id: 'entry-' + date + '-' + amount,
    habitId: 'habit',
    localDate: date,
    occurredAt: date + 'T12:00:00.000Z',
    amount,
    ...extra,
  });
it('aggregates a weekly goal over its whole period', () => {
  const h = habit({ frequency: 'weekly', target: 2 });
  const summary = summarizeHabitPeriod(
    h,
    [entry('2026-10-26', 1), entry('2026-10-28', 1)],
    '2026-10-29',
  );
  expect(summary.amount).toBe(2);
  expect(summary.status).toBe('achieved');
  expect(summary.start).toBe('2026-10-26');
  expect(summary.endExclusive).toBe('2026-11-02');
});
it('aggregates monthly amounts and marks legacy rule history as estimated', () => {
  const h = habit({ frequency: 'monthly', startDate: '2026-10-01', target: 5 });
  const summary = summarizeHabitPeriod(
    h,
    [entry('2026-10-01', 2), entry('2026-10-28', 3)],
    '2026-10-29',
  );
  expect(summary.status).toBe('achieved');
  expect(summary.estimated).toBe(true);
  expect(summary.endExclusive).toBe('2026-11-01');
});
it('keeps paused dates exempt and applies the chosen skipped-date streak policy', () => {
  const entries = [
    entry('2026-10-26', 1),
    entry('2026-10-28', 1),
    entry('2026-10-29', 1, { skipped: true }),
    entry('2026-10-30', 1),
  ];
  const h = habit({ pausedDates: ['2026-10-27'] });
  expect(summarizeHabitPeriod(h, entries, '2026-10-27').status).toBe('exempt');
  expect(habitStreak(h, entries, '2026-10-30')).toMatchObject({ current: 1, longest: 2 });
  expect(habitStreak(habit({ ...h, skipPolicy: 'exempt' }), entries, '2026-10-30')).toMatchObject({
    current: 3,
    longest: 3,
  });
});
it('does not break a streak before the current period has ended', () => {
  const h = habit();
  expect(
    habitStreak(h, [entry('2026-10-26', 1), entry('2026-10-27', 1)], '2026-10-28').current,
  ).toBe(2);
  expect(getHabitPeriod(h, '2026-10-28').scheduledDates).toEqual(['2026-10-28']);
});
