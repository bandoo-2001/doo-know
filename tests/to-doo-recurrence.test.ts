import { expect, it } from 'vitest';
import {
  expandRecurrence,
  nextAnniversary,
  dateTimeInstant,
} from '../packages/core/to-doo/recurrence';
import { toDooRecurrenceSchema } from '../shared/to-doo-contracts';
const rule = (extra: Record<string, unknown>) =>
  toDooRecurrenceSchema.parse({
    id: 'rule-a',
    frequency: 'monthly',
    anchorDate: '2026-01-31',
    ...extra,
  });
it('preserves a day-31 anchor across short months', () => {
  expect(expandRecurrence(rule({}), '2026-01-01', '2026-04-30').map((x) => x.date)).toEqual([
    '2026-01-31',
    '2026-02-28',
    '2026-03-31',
    '2026-04-30',
  ]);
});
it('uses weekly anchors, excluded dates, and additional dates without duplicates', () => {
  expect(
    expandRecurrence(
      rule({
        frequency: 'weekly',
        anchorDate: '2026-10-26',
        weekdays: [1, 3],
        excludedDates: ['2026-10-28'],
        additionalDates: ['2026-10-30'],
      }),
      '2026-10-26',
      '2026-11-04',
    ).map((x) => x.date),
  ).toEqual(['2026-10-26', '2026-10-30', '2026-11-02', '2026-11-04']);
});
it('interprets local times in the task zone rather than the server zone', () => {
  expect(
    dateTimeInstant({ date: '2026-10-29', time: '09:00', timeZone: 'Asia/Shanghai' }).toISOString(),
  ).toBe('2026-10-29T01:00:00.000Z');
});
it('converts a lunar anniversary using real calendar arithmetic', () => {
  expect(
    nextAnniversary(
      {
        calendar: 'lunar',
        date: '2000-01-01',
        repeatYearly: true,
        lunarLeapMonth: false,
        leapPolicy: 'previous_day',
      } as any,
      '2026-01-01',
    ).date,
  ).toBe('2026-02-17');
});
