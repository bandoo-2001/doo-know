import type { ToDooHabitRule } from '../../shared/to-doo-contracts';
import { getHabitGoalMode } from '../../shared/to-doo-habits';

export const HABIT_ICONS = ['🌙', '📖', '💧', '🏃', '🧘', '💊', '✍️', '🎹', '🌱', '🧹', '🚶', '💪'];
export function formatHabitSchedule(
  rule: Pick<
    ToDooHabitRule,
    'frequency' | 'target' | 'unit' | 'goalMode' | 'weekdays' | 'intervalDays'
  >,
) {
  if (rule.frequency !== 'daily') {
    const period = rule.frequency === 'weekly' ? '每周' : '每月';
    return getHabitGoalMode(rule) === 'checkin'
      ? `${period}打卡 ${rule.target} 天`
      : `${period}累计 ${rule.target} ${rule.unit}`;
  }
  const weekdays = [...new Set(rule.weekdays ?? [])].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  const schedule =
    (rule.intervalDays ?? 1) > 1
      ? `每隔 ${rule.intervalDays} 天`
      : weekdays.length && weekdays.length < 7
        ? '每周' + weekdays.map((day) => '日一二三四五六'[day]).join('、')
        : '每天';
  return getHabitGoalMode(rule) === 'checkin'
    ? schedule
    : `${schedule} · ${rule.target} ${rule.unit}`;
}
