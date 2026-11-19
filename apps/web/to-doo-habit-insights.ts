import type { ToDooEntityMap } from '../../shared/to-doo-contracts';
import {
  getHabitGoalMode,
  getHabitPeriod,
  getHabitRule,
  summarizeHabitPeriod,
  sumHabitAmounts,
} from '../../shared/to-doo-habits';

type Habit = ToDooEntityMap['habit'];
type HabitEntry = ToDooEntityMap['habitEntry'];
const shiftDate = (date: string, days: number) =>
  new Date(Date.parse(date + 'T12:00:00Z') + days * 86400000).toISOString().slice(0, 10);
const actualEntries = (habit: Habit, entries: readonly HabitEntry[], nowDate: string) =>
  entries.filter(
    (entry) => entry.habitId === habit.id && !entry.deletedAt && entry.localDate <= nowDate,
  );

/** Remaining quantity is a period goal; available dates are recording opportunities, not a daily quota. */
export function habitPeriodPlan(
  habit: Habit,
  entries: readonly HabitEntry[],
  date: string,
  nowDate: string,
) {
  const actual = actualEntries(habit, entries, nowDate);
  const summary = summarizeHabitPeriod(habit, actual, date);
  const mode = getHabitGoalMode(summary.rule);
  const skippedDates = new Set(
    actual.filter((entry) => entry.skipped).map((entry) => entry.localDate),
  );
  const recordedDates = new Set(
    actual.filter((entry) => !entry.skipped && entry.amount > 0).map((entry) => entry.localDate),
  );
  const from = [date, nowDate, summary.start].sort().at(-1)!;
  const recordableDates = summary.scheduledDates.filter(
    (day) =>
      day >= from && !skippedDates.has(day) && (mode !== 'checkin' || !recordedDates.has(day)),
  );
  return {
    summary,
    remaining: Math.max(0, sumHabitAmounts([summary.target, -summary.amount])),
    remainingUnit: mode === 'checkin' ? '天' : summary.rule.unit,
    remainingDates: recordableDates.length,
    recordableDates,
    ended: summary.endExclusive <= nowDate,
    isCurrentPeriod: summary.start <= nowDate && nowDate < summary.endExclusive,
    estimated: summary.estimated,
  };
}

export type ToDooHabitTrendDay = {
  date: string;
  amount: number;
  unit: string;
  recorded: boolean;
  scheduled: boolean;
  achieved: boolean;
  skipped: boolean;
  paused: boolean;
  estimated: boolean;
};
export type ToDooHabitTrendWindow = {
  from: string;
  to: string;
  total: number | null;
  activeDays: number;
  scheduledDays: number;
  recordedScheduledDays: number;
  /** Share of scheduled days with a record; this is deliberately not a target completion rate. */
  coverage: number | null;
};

/** Equal trailing windows compare actual activity, without stretching a weekly target across every date. */
export function buildHabitTrend(
  habit: Habit,
  entries: readonly HabitEntry[],
  nowDate: string,
  days = 14,
) {
  const half = Math.max(1, Math.min(183, Math.floor((Number.isFinite(days) ? days : 14) / 2)));
  const length = half * 2;
  const actual = actualEntries(habit, entries, nowDate);
  const records = new Map<string, HabitEntry[]>();
  for (const entry of actual) {
    const values = records.get(entry.localDate) || [];
    values.push(entry);
    records.set(entry.localDate, values);
  }
  const dimensions = new Set<string>();
  const items: ToDooHabitTrendDay[] = Array.from({ length }, (_, index) => {
    const date = shiftDate(nowDate, index - length + 1);
    const rule = getHabitRule(habit, date);
    const mode = getHabitGoalMode(rule);
    const unit = mode === 'checkin' ? '天' : rule.unit;
    dimensions.add(JSON.stringify([mode, unit]));
    const values = records.get(date) || [];
    const ordinary = values.filter((entry) => !entry.skipped && entry.amount > 0);
    const period = getHabitPeriod(habit, date);
    const summary = summarizeHabitPeriod(habit, actual, date);
    const recorded = ordinary.length > 0;
    const scheduled = period.scheduledDates.includes(date);
    const skipped = values.some((entry) => entry.skipped);
    return {
      date,
      amount:
        mode === 'checkin'
          ? Number(recorded)
          : sumHabitAmounts(ordinary.map((entry) => entry.amount)),
      unit,
      recorded,
      scheduled,
      achieved: rule.frequency === 'daily' && summary.status === 'achieved',
      skipped,
      paused: habit.pausedDates.includes(date),
      estimated: period.estimated && (scheduled || recorded || skipped),
    };
  });
  const comparable = dimensions.size === 1;
  const window = (values: ToDooHabitTrendDay[]): ToDooHabitTrendWindow => {
    const scheduledDays = values.filter((day) => day.scheduled).length;
    const recordedScheduledDays = values.filter((day) => day.scheduled && day.recorded).length;
    return {
      from: values[0]!.date,
      to: values.at(-1)!.date,
      total: comparable ? sumHabitAmounts(values.map((day) => day.amount)) : null,
      activeDays: values.filter((day) => day.recorded).length,
      scheduledDays,
      recordedScheduledDays,
      coverage: scheduledDays ? recordedScheduledDays / scheduledDays : null,
    };
  };
  const previous = window(items.slice(0, half));
  const current = window(items.slice(half));
  return {
    days: items,
    current,
    previous,
    comparable,
    unit: comparable ? items[0]!.unit : null,
    delta: comparable ? sumHabitAmounts([current.total!, -previous.total!]) : null,
    estimated: items.some((day) => day.estimated),
  };
}
