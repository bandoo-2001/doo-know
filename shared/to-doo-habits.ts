import type { ToDooEntityMap, ToDooHabitRule } from './to-doo-contracts.js';
type Habit = ToDooEntityMap['habit'];
type Entry = ToDooEntityMap['habitEntry'];
const dayMs = 86400000;
const addDays = (date: string, n: number) =>
  new Date(Date.parse(date + 'T00:00:00Z') + n * dayMs).toISOString().slice(0, 10);
const maxDate = (a: string, b: string) => (a > b ? a : b);
const minDate = (a: string, b: string) => (a < b ? a : b);
export function getHabitRule(habit: Habit, date: string): ToDooHabitRule {
  const versions = [...(habit.ruleVersions ?? [])].sort((a, b) =>
    a.effectiveFrom.localeCompare(b.effectiveFrom),
  );
  const chosen = versions.filter((v) => v.effectiveFrom <= date).at(-1);
  if (chosen) return chosen;
  if (versions[0]) return { ...versions[0], estimated: true };
  return {
    id: 'legacy',
    effectiveFrom: habit.startDate,
    frequency: habit.frequency,
    target: habit.target,
    unit: habit.unit,
    timeZone: habit.timeZone,
    weekdays: habit.weekdays,
    startDate: habit.startDate,
    endDate: habit.endDate,
    weekStartsOn: habit.weekStartsOn ?? 1,
    skipPolicy: habit.skipPolicy ?? 'break',
    estimated: true,
  };
}
export function getHabitPeriod(habit: Habit, date: string) {
  const rule = getHabitRule(habit, date);
  let start = date,
    endExclusive = addDays(date, 1);
  if (rule.frequency === 'weekly') {
    const weekday = new Date(date + 'T00:00:00Z').getUTCDay();
    start = addDays(date, -((weekday - rule.weekStartsOn + 7) % 7));
    endExclusive = addDays(start, 7);
  }
  if (rule.frequency === 'monthly') {
    start = date.slice(0, 7) + '-01';
    const d = new Date(start + 'T00:00:00Z');
    d.setUTCMonth(d.getUTCMonth() + 1);
    endExclusive = d.toISOString().slice(0, 10);
  }
  start = maxDate(start, maxDate(rule.startDate, rule.effectiveFrom));
  const next = (habit.ruleVersions ?? [])
    .filter((v) => v.effectiveFrom > rule.effectiveFrom)
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))[0];
  if (next) endExclusive = minDate(endExclusive, next.effectiveFrom);
  if (rule.endDate) endExclusive = minDate(endExclusive, addDays(rule.endDate, 1));
  const scheduledDates: string[] = [];
  if (
    date >= rule.startDate &&
    (!rule.endDate || date <= rule.endDate) &&
    date >= rule.effectiveFrom
  )
    for (let day = start; day < endExclusive; day = addDays(day, 1)) {
      if (rule.weekdays.length && !rule.weekdays.includes(new Date(day + 'T00:00:00Z').getUTCDay()))
        continue;
      if (habit.pausedDates.includes(day)) continue;
      scheduledDates.push(day);
    }
  return { start, endExclusive, rule, scheduledDates, estimated: rule.estimated };
}
export type ToDooHabitPeriodSummary = ReturnType<typeof getHabitPeriod> & {
  amount: number;
  target: number;
  status: 'achieved' | 'pending' | 'skipped' | 'exempt' | 'inactive';
};
export function summarizeHabitPeriod(
  habit: Habit,
  entries: readonly Entry[],
  date: string,
): ToDooHabitPeriodSummary {
  const period = getHabitPeriod(habit, date),
    selected = entries.filter(
      (e) =>
        e.habitId === habit.id &&
        !e.deletedAt &&
        e.localDate >= period.start &&
        e.localDate < period.endExclusive,
    );
  const amount = selected.filter((e) => !e.skipped).reduce((sum, e) => sum + e.amount, 0),
    skipDates = new Set(selected.filter((e) => e.skipped).map((e) => e.localDate));
  let status: ToDooHabitPeriodSummary['status'];
  if (
    date < period.rule.startDate ||
    date < period.rule.effectiveFrom ||
    (period.rule.endDate && date > period.rule.endDate)
  )
    status = 'inactive';
  else if (!period.scheduledDates.length) status = 'exempt';
  else if (amount >= period.rule.target) status = 'achieved';
  else if (period.scheduledDates.every((day) => skipDates.has(day)))
    status = period.rule.skipPolicy === 'exempt' ? 'exempt' : 'skipped';
  else status = 'pending';
  return { ...period, amount, target: period.rule.target, status };
}
export function habitStreak(
  habit: Habit,
  entries: readonly Entry[],
  today: string,
  maxPeriods = 5000,
) {
  const versions = habit.ruleVersions ?? [];
  let cursor = versions.length
      ? versions.reduce((a, v) => minDate(a, v.startDate), habit.startDate)
      : habit.startDate,
    current = 0,
    longest = 0,
    estimated = false,
    periods = 0;
  for (; cursor <= today && periods < maxPeriods; periods++) {
    const summary = summarizeHabitPeriod(habit, entries, cursor);
    estimated ||= summary.estimated;
    if (summary.status === 'achieved') {
      current++;
      longest = Math.max(longest, current);
    } else if (
      summary.status === 'skipped' ||
      (summary.status === 'pending' && summary.endExclusive <= today)
    )
      current = 0;
    cursor = summary.endExclusive > cursor ? summary.endExclusive : addDays(cursor, 1);
  }
  const truncated = cursor <= today;
  return {
    current: truncated ? 0 : current,
    longest,
    estimated: estimated || truncated,
    truncated,
    periods,
  };
}
