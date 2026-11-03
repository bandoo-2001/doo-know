import lunar from 'lunar-javascript';
import type { ToDooEntityMap } from './to-doo-contracts.js';
const dayMs = 86400000;
const dateString = (date: Date) => date.toISOString().slice(0, 10);

export function nextToDooAnniversary(
  value: Pick<
    ToDooEntityMap['anniversary'],
    'calendar' | 'date' | 'repeatYearly' | 'lunarLeapMonth' | 'leapPolicy'
  >,
  today: string,
): { date: string; days: number } {
  const [y, m, d] = value.date.split('-').map(Number),
    startYear = Number(today.slice(0, 4));
  let selected: string | undefined;
  // Early dates in a solar year may still belong to the previous lunar year.
  for (
    let year = value.repeatYearly ? startYear - (value.calendar === 'lunar' ? 1 : 0) : y;
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

export function toDooAnniversaryDate(
  value: ToDooEntityMap['anniversary'],
  from: string,
): string | null {
  try {
    return nextToDooAnniversary(value, from).date;
  } catch {
    return null;
  }
}
