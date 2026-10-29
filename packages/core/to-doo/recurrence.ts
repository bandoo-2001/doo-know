import { createHash } from 'node:crypto';
import lunar from 'lunar-javascript';
import type {
  ToDooRecurrence,
  ToDooDateTime,
  ToDooEntityMap,
} from '../../../shared/to-doo-contracts.js';
export const stableToDooId = (...parts: string[]) =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
const dayMs = 86400000;
export const dateString = (date: Date) => date.toISOString().slice(0, 10);
export function addDays(date: string, n: number): string {
  return dateString(new Date(Date.parse(date + 'T00:00:00Z') + n * dayMs));
}
export function addMonths(
  date: string,
  n: number,
  shortMonth: 'last_day' | 'skip' = 'last_day',
): string | null {
  const [y, m, d] = date.split('-').map(Number),
    target = new Date(Date.UTC(y, m - 1 + n, 1)),
    last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  if (d > last && shortMonth === 'skip') return null;
  target.setUTCDate(Math.min(d, last));
  return dateString(target);
}
export function expandRecurrence(
  rule: ToDooRecurrence,
  from: string,
  to: string,
  limit = 2000,
): { date: string; cycleKey: string }[] {
  if (rule.endedAt || to < rule.anchorDate || to < from || rule.frequency === 'after_completion')
    return [];
  const anchor = new Date(rule.anchorDate + 'T00:00:00Z'),
    [ay, am, ad] = rule.anchorDate.split('-').map(Number);
  const dates = new Set<string>();
  let count = 0,
    iterations = 0;
  const end = rule.until && rule.until < to ? rule.until : to;
  for (let date = rule.anchorDate; date <= end; date = addDays(date, 1)) {
    if (++iterations > 366000) throw new Error('重复区间过大，请缩小日期范围');
    const d = new Date(date + 'T00:00:00Z'),
      diff = Math.round((d.getTime() - anchor.getTime()) / dayMs),
      monthDiff = (d.getUTCFullYear() - ay) * 12 + d.getUTCMonth() - (am - 1);
    let matches = false;
    if (rule.frequency === 'daily') matches = diff % rule.interval === 0;
    if (rule.frequency === 'weekly')
      matches =
        Math.floor(diff / 7) % rule.interval === 0 &&
        (rule.weekdays.length ? rule.weekdays : [anchor.getUTCDay()]).includes(d.getUTCDay());
    if (rule.frequency === 'monthly' && monthDiff % rule.interval === 0) {
      const target = rule.monthDay ?? ad,
        last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      if (rule.weekOrdinal && rule.weekdays.length) {
        const ordinal =
          rule.weekOrdinal === -1
            ? Math.floor((last - d.getUTCDate()) / 7) === 0
            : Math.floor((d.getUTCDate() - 1) / 7) + 1 === rule.weekOrdinal;
        matches = ordinal && rule.weekdays.includes(d.getUTCDay());
      } else
        matches =
          d.getUTCDate() === (rule.shortMonth === 'last_day' ? Math.min(target, last) : target);
    }
    if (
      rule.frequency === 'yearly' &&
      (d.getUTCFullYear() - ay) % rule.interval === 0 &&
      d.getUTCMonth() + 1 === am
    ) {
      const last = new Date(Date.UTC(d.getUTCFullYear(), am, 0)).getUTCDate();
      matches = d.getUTCDate() === (rule.shortMonth === 'last_day' ? Math.min(ad, last) : ad);
    }
    if (matches) {
      count++;
      if (rule.count !== null && count > rule.count) break;
      if (date >= from && !rule.excludedDates.includes(date)) dates.add(date);
    }
    if (dates.size > limit) throw new Error('重复结果超出单次上限，请分页缩小区间');
  }
  for (const date of rule.additionalDates) if (date >= from && date <= end) dates.add(date);
  return [...dates].sort().map((date) => ({ date, cycleKey: rule.id + ':' + date }));
}
const formatterCache = new Map<string, Intl.DateTimeFormat>();
function localParts(at: Date, timeZone: string) {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatterCache.set(timeZone, f);
  }
  const parts = Object.fromEntries(f.formatToParts(at).map((p) => [p.type, p.value]));
  return {
    date: parts.year + '-' + parts.month + '-' + parts.day,
    time: parts.hour + ':' + parts.minute,
  };
}
export function localDate(at: Date, timeZone: string): string {
  return localParts(at, timeZone).date;
}
export function dateTimeInstant(value: ToDooDateTime, allDayTime = '23:59'): Date {
  const time = value.time ?? allDayTime,
    target = value.date + 'T' + time;
  const targetMs = Date.parse(target + ':00Z');
  let guess = targetMs;
  for (let i = 0; i < 5; i++) {
    const p = localParts(new Date(guess), value.timeZone),
      localMs = Date.parse(p.date + 'T' + p.time + ':00Z');
    const delta = targetMs - localMs;
    if (!delta) break;
    guess += delta;
  }
  const matches: number[] = [];
  for (const delta of [-120, -60, 0, 60, 120]) {
    const candidate = guess + delta * 60000,
      p = localParts(new Date(candidate), value.timeZone);
    if (p.date + 'T' + p.time === target) matches.push(candidate);
  }
  if (matches.length) return new Date(Math.min(...matches));
  // DST gap: select the earliest valid local minute after the requested slot.
  let best: number | undefined, bestLocal: string | undefined;
  for (let offset = -180; offset <= 180; offset++) {
    const candidate = guess + offset * 60000,
      p = localParts(new Date(candidate), value.timeZone),
      key = p.date + 'T' + p.time;
    if (
      key >= target &&
      (!bestLocal || key < bestLocal || (key === bestLocal && candidate < best!))
    ) {
      best = candidate;
      bestLocal = key;
    }
  }
  if (best === undefined) throw new Error('无法解释当地时间');
  return new Date(best);
}
export function nextAnniversary(
  value: Pick<
    ToDooEntityMap['anniversary'],
    'calendar' | 'date' | 'repeatYearly' | 'lunarLeapMonth' | 'leapPolicy'
  >,
  today: string,
): { date: string; days: number } {
  const [y, m, d] = value.date.split('-').map(Number),
    startYear = Number(today.slice(0, 4));
  let selected: string | undefined;
  for (
    let year = value.repeatYearly ? startYear : y;
    year <= (value.repeatYearly ? startYear + 20 : y);
    year++
  ) {
    let candidate: string | undefined;
    try {
      if (value.calendar === 'lunar') {
        const solar = lunar.Lunar.fromYmd(year, value.lunarLeapMonth ? -m : m, d).getSolar();
        candidate =
          String(solar.getYear()).padStart(4, '0') +
          '-' +
          String(solar.getMonth()).padStart(2, '0') +
          '-' +
          String(solar.getDay()).padStart(2, '0');
      } else {
        const last = new Date(Date.UTC(year, m, 0)).getUTCDate();
        if (d > last && value.leapPolicy === 'skip') continue;
        candidate =
          d > last && value.leapPolicy === 'next_day'
            ? dateString(new Date(Date.UTC(year, m, 1)))
            : dateString(new Date(Date.UTC(year, m - 1, Math.min(d, last))));
      }
    } catch {
      if (value.leapPolicy === 'skip') continue;
      if (value.calendar === 'lunar' && value.lunarLeapMonth) {
        try {
          const solar = lunar.Lunar.fromYmd(year, m, d).getSolar();
          candidate =
            String(solar.getYear()).padStart(4, '0') +
            '-' +
            String(solar.getMonth()).padStart(2, '0') +
            '-' +
            String(solar.getDay()).padStart(2, '0');
        } catch {
          continue;
        }
      } else continue;
    }
    if (candidate && (candidate >= today || !value.repeatYearly)) {
      selected = candidate;
      break;
    }
  }
  if (!selected) throw new Error('历法支持范围内未找到下一日期');
  return {
    date: selected,
    days: Math.round(
      (Date.parse(selected + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / dayMs,
    ),
  };
}
