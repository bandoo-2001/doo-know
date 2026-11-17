import { describe, expect, test } from 'vitest';
import { toDooEntitySchemas } from '../shared/to-doo-contracts';
import { sumHabitAmounts, summarizeHabitPeriod } from '../shared/to-doo-habits';

const stamp = {
  revision: 'r1',
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
};
const habit = (target: number) =>
  toDooEntitySchemas.habit.parse({
    ...stamp,
    id: 'decimal',
    name: '饮水',
    startDate: '2026-11-01',
    target,
    unit: '升',
    goalMode: 'quantity',
  });
const records = (amounts: number[]) =>
  amounts.map((amount, index) =>
    toDooEntitySchemas.habitEntry.parse({
      ...stamp,
      id: 'entry-' + index,
      habitId: 'decimal',
      localDate: '2026-11-17',
      occurredAt: '2026-11-17T08:00:00Z',
      amount,
    }),
  );

describe('stable habit decimal quantities', () => {
  test.each([
    [[0.1, 0.2], 0.3],
    [[0.1, 0.7], 0.8],
    [[0.0000001, 0.0000002], 0.0000003],
    [[999999.1, 0.2], 999999.3],
    [[1000000, 0.1], 1000000.1],
    [[1e21, 1, -1e21], 1],
    [[5e-324, 5e-324], 1e-323],
    [[], 0],
  ] as const)(
    'sums canonical decimal values %j without cumulative binary noise',
    (values, expected) => {
      expect(sumHabitAmounts(values)).toBe(expected);
      expect(sumHabitAmounts([...values].reverse())).toBe(expected);
    },
  );

  test('reaching a decimal target changes the status without changing any original record', () => {
    const entries = records([0.1, 0.7]);
    const before = JSON.stringify(entries);
    expect(summarizeHabitPeriod(habit(0.8), entries, '2026-11-17')).toMatchObject({
      amount: 0.8,
      status: 'achieved',
    });
    expect(JSON.stringify(entries)).toBe(before);
  });

  test('genuinely smaller stored decimal values remain below target, including a tiny real gap', () => {
    expect(summarizeHabitPeriod(habit(0.8), records([0.79]), '2026-11-17')).toMatchObject({
      amount: 0.79,
      status: 'pending',
    });
    expect(sumHabitAmounts([0.8, -0.79])).toBe(0.01);
    expect(
      summarizeHabitPeriod(habit(0.8), records([0.7999999999999999]), '2026-11-17').status,
    ).toBe('pending');
    expect(sumHabitAmounts([0.8, -0.7999999999999999])).toBe(1e-16);
  });

  test('a long fractional series stays exact at the final target', () => {
    const entries = records(Array.from({ length: 1000 }, () => 0.1));
    expect(summarizeHabitPeriod(habit(100), entries, '2026-11-17')).toMatchObject({
      amount: 100,
      status: 'achieved',
    });
  });

  test.each([NaN, Infinity, -Infinity])(
    'rejects non-finite values %s rather than presenting a false total',
    (value) => {
      expect(() => sumHabitAmounts([1, value])).toThrow(RangeError);
    },
  );
});
