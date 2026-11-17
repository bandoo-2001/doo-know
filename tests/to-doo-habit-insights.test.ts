import { describe, expect, it } from 'vitest';
import { toDooEntitySchemas, toDooHabitRuleSchema } from '../shared/to-doo-contracts';
import { buildHabitTrend, habitPeriodPlan } from '../apps/web/to-doo-habit-insights';

const stamp = {
  id: 'habit',
  revision: 'r1',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};
const habit = (extra: Record<string, unknown> = {}) =>
  toDooEntitySchemas.habit.parse({
    ...stamp,
    name: 'Reading',
    startDate: '2026-10-01',
    goalMode: 'quantity',
    target: 20,
    unit: '页',
    ...extra,
  });
const entry = (date: string, amount: number, extra: Record<string, unknown> = {}) =>
  toDooEntitySchemas.habitEntry.parse({
    ...stamp,
    id: date + '-' + String(amount).replace(/[^A-Za-z0-9_-]/g, '_'),
    habitId: 'habit',
    localDate: date,
    occurredAt: date + 'T08:00:00.000Z',
    amount,
    ...extra,
  });
const version = (extra: Record<string, unknown> = {}) =>
  toDooHabitRuleSchema.parse({
    id: 'rule-v1',
    effectiveFrom: '2026-10-01',
    startDate: '2026-10-01',
    frequency: 'daily',
    goalMode: 'quantity',
    target: 20,
    unit: '页',
    timeZone: 'Asia/Shanghai',
    weekdays: [],
    endDate: null,
    estimated: false,
    ...extra,
  });

describe('habit period plan', () => {
  it('keeps weekly remaining quantity separate from eligible dates, including a partial today', () => {
    const h = habit({ frequency: 'weekly', target: 3, unit: '次', pausedDates: ['2026-11-20'] });
    const plan = habitPeriodPlan(
      h,
      [entry('2026-11-16', 1), entry('2026-11-17', 1)],
      '2026-11-17',
      '2026-11-17',
    );
    expect(plan.summary.amount).toBe(2);
    expect(plan.remaining).toBe(1);
    expect(plan.remainingUnit).toBe('次');
    expect(plan.recordableDates).toEqual([
      '2026-11-17',
      '2026-11-18',
      '2026-11-19',
      '2026-11-21',
      '2026-11-22',
    ]);
    expect(plan).toMatchObject({ remainingDates: 5, ended: false, isCurrentPeriod: true });
  });

  it('excludes a skipped today from available recording days without erasing the remaining weekly goal', () => {
    const plan = habitPeriodPlan(
      habit({ frequency: 'weekly', target: 3, unit: '次', pausedDates: ['2026-11-20'] }),
      [entry('2026-11-16', 1), entry('2026-11-17', 0, { skipped: true })],
      '2026-11-17',
      '2026-11-17',
    );
    expect(plan).toMatchObject({ remaining: 2, remainingDates: 4 });
    expect(plan.recordableDates).toEqual(['2026-11-18', '2026-11-19', '2026-11-21', '2026-11-22']);
  });

  it('does not count an already checked-in day as another opportunity and honors allowed weekdays', () => {
    const h = habit({
      frequency: 'weekly',
      goalMode: 'checkin',
      target: 3,
      unit: '次',
      weekdays: [1, 2, 4, 6],
    });
    const plan = habitPeriodPlan(
      h,
      [entry('2026-11-17', 1), entry('2026-11-17', 1, { id: 'duplicate' })],
      '2026-11-17',
      '2026-11-17',
    );
    expect(plan.summary.amount).toBe(1);
    expect(plan.remaining).toBe(2);
    expect(plan.remainingUnit).toBe('天');
    expect(plan.recordableDates).toEqual(['2026-11-19', '2026-11-21']);
  });

  it('does not suggest new recording dates for a past month or count future imports toward its goal', () => {
    const h = habit({ frequency: 'monthly', target: 2, unit: '本' });
    const records = [entry('2026-10-20', 1), entry('2026-11-10', 1), entry('2026-11-30', 99)];
    expect(habitPeriodPlan(h, records, '2026-10-20', '2026-11-17')).toMatchObject({
      remaining: 1,
      remainingDates: 0,
      ended: true,
      isCurrentPeriod: false,
    });
    const current = habitPeriodPlan(h, records, '2026-11-05', '2026-11-17');
    expect(current.summary.amount).toBe(1);
    expect(current.recordableDates[0]).toBe('2026-11-17');
    expect(current.recordableDates.at(-1)).toBe('2026-11-30');
  });

  it('clips opportunities at an end date and at the next rule version', () => {
    const h = habit({
      frequency: 'weekly',
      target: 100,
      ruleVersions: [
        version({ frequency: 'weekly', target: 100 }),
        version({ id: 'rule-v2', effectiveFrom: '2026-11-19', frequency: 'daily', target: 10 }),
      ],
    });
    expect(habitPeriodPlan(h, [], '2026-11-17', '2026-11-17').recordableDates).toEqual([
      '2026-11-17',
      '2026-11-18',
    ]);
    expect(
      habitPeriodPlan(
        habit({ frequency: 'weekly', endDate: '2026-11-18' }),
        [],
        '2026-11-17',
        '2026-11-17',
      ).recordableDates,
    ).toEqual(['2026-11-17', '2026-11-18']);
  });

  it('uses daily interval rules and reports attained targets without a negative remainder', () => {
    const h = habit({ startDate: '2026-11-01', intervalDays: 3 });
    expect(habitPeriodPlan(h, [], '2026-11-17', '2026-11-17').remainingDates).toBe(0);
    expect(
      habitPeriodPlan(habit(), [entry('2026-11-17', 26)], '2026-11-17', '2026-11-17').remaining,
    ).toBe(0);
  });
});

describe('habit activity trend', () => {
  it('compares equal 7-day windows using actual daily quantities across month boundaries', () => {
    const trend = buildHabitTrend(
      habit(),
      [
        entry('2026-10-26', 10),
        entry('2026-11-01', 20),
        entry('2026-11-03', 5),
        entry('2026-11-03', 8, { id: 'second' }),
        entry('2026-11-10', 100),
        entry('2026-11-02', 99, { deletedAt: stamp.updatedAt }),
        entry('2026-11-04', 2, { habitId: 'other' }),
      ],
      '2026-11-08',
    );
    expect(trend.days).toHaveLength(14);
    expect(trend.previous).toMatchObject({
      from: '2026-10-26',
      to: '2026-11-01',
      total: 30,
      activeDays: 2,
      scheduledDays: 7,
    });
    expect(trend.current).toMatchObject({
      from: '2026-11-02',
      to: '2026-11-08',
      total: 13,
      activeDays: 1,
      scheduledDays: 7,
    });
    expect(trend.current.coverage).toBeCloseTo(1 / 7);
    expect(trend).toMatchObject({ unit: '页', comparable: true, delta: -17, estimated: true });
  });

  it('does not paint an achieved weekly target onto dates without any actual record', () => {
    const h = habit({ frequency: 'weekly', target: 3, unit: '次' });
    const trend = buildHabitTrend(h, [entry('2026-11-17', 3)], '2026-11-17');
    expect(trend.current.activeDays).toBe(1);
    expect(trend.days.filter((day) => day.recorded)).toHaveLength(1);
    expect(trend.days.filter((day) => day.achieved)).toHaveLength(0);
    expect(trend.days.find((day) => day.date === '2026-11-16')).toMatchObject({
      amount: 0,
      recorded: false,
    });
  });

  it('counts check-ins once per date while preserving skipped and paused date states', () => {
    const h = habit({ goalMode: 'checkin', target: 1, pausedDates: ['2026-11-14'] });
    const trend = buildHabitTrend(
      h,
      [
        entry('2026-11-16', 1),
        entry('2026-11-16', 5, { id: 'duplicate' }),
        entry('2026-11-15', 0, { skipped: true }),
      ],
      '2026-11-17',
    );
    expect(trend.current.total).toBe(1);
    expect(trend.current.activeDays).toBe(1);
    expect(trend.unit).toBe('天');
    expect(trend.days.find((day) => day.date === '2026-11-16')).toMatchObject({
      amount: 1,
      achieved: true,
    });
    expect(trend.days.find((day) => day.date === '2026-11-15')).toMatchObject({
      skipped: true,
      recorded: false,
    });
    expect(trend.days.find((day) => day.date === '2026-11-14')).toMatchObject({
      paused: true,
      scheduled: false,
    });
    expect(trend.current.scheduledDays).toBe(6);
  });

  it('retains each date unit but declines aggregate comparisons across a unit or goal-mode change', () => {
    const rules = [
      version(),
      version({ id: 'rule-v2', effectiveFrom: '2026-11-13', unit: '分钟' }),
    ];
    const trend = buildHabitTrend(
      habit({ unit: '分钟', ruleVersions: rules }),
      [entry('2026-11-10', 20), entry('2026-11-15', 10)],
      '2026-11-17',
    );
    expect(trend).toMatchObject({ comparable: false, unit: null, delta: null, estimated: false });
    expect(trend.previous.total).toBeNull();
    expect(trend.current.total).toBeNull();
    expect(trend.days.find((day) => day.date === '2026-11-10')?.unit).toBe('页');
    expect(trend.days.find((day) => day.date === '2026-11-15')?.unit).toBe('分钟');
    const changedMode = habit({
      goalMode: 'checkin',
      target: 1,
      unit: '天',
      ruleVersions: [
        version({ unit: '天' }),
        version({
          id: 'checkin',
          effectiveFrom: '2026-11-13',
          unit: '天',
          goalMode: 'checkin',
          target: 1,
        }),
      ],
    });
    expect(buildHabitTrend(changedMode, [], '2026-11-17').comparable).toBe(false);
  });

  it('returns useful empty activity and no fabricated coverage before a habit has begun', () => {
    const trend = buildHabitTrend(habit({ startDate: '2026-12-01' }), [], '2026-11-17');
    expect(trend.current).toMatchObject({
      total: 0,
      activeDays: 0,
      scheduledDays: 0,
      coverage: null,
    });
    expect(trend.previous).toMatchObject({
      total: 0,
      activeDays: 0,
      scheduledDays: 0,
      coverage: null,
    });
    expect(trend.delta).toBe(0);
  });

  it('does not label unarranged dates before a new habit began as estimated history', () => {
    const h = habit({
      startDate: '2026-11-16',
      ruleVersions: [version({ effectiveFrom: '2026-11-16', startDate: '2026-11-16' })],
    });
    const trend = buildHabitTrend(h, [entry('2026-11-16', 10)], '2026-11-17');
    expect(trend.estimated).toBe(false);
    expect(trend.days.filter((day) => day.scheduled)).toHaveLength(2);
  });
});

it('keeps fractional progress, default remainder and weekly comparison in the same decimal arithmetic', () => {
  const h = habit({ target: 0.8, unit: '升' });
  const reached = habitPeriodPlan(
    h,
    [entry('2026-11-17', 0.1), entry('2026-11-17', 0.7)],
    '2026-11-17',
    '2026-11-17',
  );
  expect(reached).toMatchObject({ remaining: 0, summary: { amount: 0.8, status: 'achieved' } });
  expect(
    habitPeriodPlan(h, [entry('2026-11-17', 0.7999999999999999)], '2026-11-17', '2026-11-17')
      .remaining,
  ).toBe(1e-16);
  const trend = buildHabitTrend(
    h,
    [
      entry('2026-11-10', 0.1),
      entry('2026-11-11', 0.1),
      entry('2026-11-17', 0.1),
      entry('2026-11-17', 0.2),
    ],
    '2026-11-17',
  );
  expect(trend.days.at(-1)?.amount).toBe(0.3);
  expect(trend.current.total).toBe(0.4);
  expect(trend.previous.total).toBe(0.1);
  expect(trend.delta).toBe(0.3);
});
