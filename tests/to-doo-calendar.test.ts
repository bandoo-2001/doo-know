import { describe, expect, it } from 'vitest';
import {
  calendarItemId,
  expandCalendar,
  exportCalendar,
  parseCalendar,
} from '../packages/core/to-doo/calendar.js';

describe('iCalendar exchange', () => {
  const source =
    'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:weekly@example\r\nDTSTART;TZID=Asia/Shanghai:20261029T090000\r\nDTEND;TZID=Asia/Shanghai:20261029T100000\r\nRRULE:FREQ=WEEKLY;COUNT=4;BYDAY=TH\r\nEXDATE;TZID=Asia/Shanghai:20261105T090000\r\nSUMMARY:设计\\, review\r\nDESCRIPTION:First\\nSecond\r\nATTACH:https://127.0.0.1/private\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:weekly@example\r\nRECURRENCE-ID;TZID=Asia/Shanghai:20261112T090000\r\nDTSTART;TZID=Asia/Shanghai:20261112T110000\r\nDTEND;TZID=Asia/Shanghai:20261112T120000\r\nSUMMARY:Moved\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  it('round-trips timezone, recurrence exceptions and escaped text without fetching URLs', () => {
    const parsed = parseCalendar(source, { timeZone: 'UTC' });
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0]).toMatchObject({
      uid: 'weekly@example',
      title: '设计, review',
      description: 'First\nSecond',
      start: { date: '2026-10-29', time: '09:00', timeZone: 'Asia/Shanghai' },
    });
    expect(parsed.items[0].excludedDates).toEqual(['2026-11-05T09:00:00']);
    expect(parsed.warnings.join(' ')).toMatch(/ATTACH/);
    const again = parseCalendar(
      exportCalendar(parsed.items, { datasetId: 'dataset', includeDescription: true }),
      { timeZone: 'UTC' },
    );
    expect(again.items.map(({ raw, ...item }) => item)).toEqual(
      parsed.items.map(({ raw, ...item }) => item),
    );
  });
  it('preserves date-only values and stable original-period identities', () => {
    const parsed = parseCalendar(
      'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTODO\r\nUID:todo-1\r\nDUE;VALUE=DATE:20261201\r\nSUMMARY:Pay\r\nEND:VTODO\r\nEND:VCALENDAR\r\n',
      { timeZone: 'Asia/Shanghai' },
    );
    expect(parsed.items[0]).toMatchObject({
      component: 'VTODO',
      allDay: true,
      start: { date: '2026-12-01', time: null, timeZone: 'Asia/Shanghai' },
    });
    expect(
      parseCalendar(exportCalendar(parsed.items, { datasetId: 'a' }), { timeZone: 'Asia/Shanghai' })
        .items[0].start.date,
    ).toBe('2026-12-01');
    expect(calendarItemId('s', 'uid', 'original')).toBe(calendarItemId('s', 'uid', 'original'));
    expect(calendarItemId('s', 'uid', 'original')).not.toBe(calendarItemId('s', 'uid', 'other'));
  });
  it('rejects truncated, invalid or floating-time input without an explicit time zone', () => {
    expect(() => parseCalendar(source.replace('END:VCALENDAR', ''), { timeZone: 'UTC' })).toThrow(
      /complete|calendar/i,
    );
    expect(() =>
      parseCalendar(source.replace('Asia/Shanghai', 'Not/AZone'), { timeZone: 'UTC' }),
    ).toThrow(/zone/i);
    expect(() =>
      parseCalendar(
        'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nDTSTART:20261029T090000\r\nSUMMARY:X\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n',
      ),
    ).toThrow(/zone/i);
  });
  it('expands a bounded recurring source using original identities, exclusions and moved exceptions', () => {
    const parsed = parseCalendar(source, { timeZone: 'UTC' });
    const expanded = expandCalendar(parsed.items, { from: '2026-10-29', to: '2026-11-30' });
    expect(expanded.map((e) => e.start.date + 'T' + e.start.time)).toEqual([
      '2026-10-29T09:00',
      '2026-11-12T11:00',
      '2026-11-19T09:00',
    ]);
    expect(expanded[1].recurrenceId).toBe('2026-11-12T09:00:00');
    expect(() =>
      expandCalendar(parsed.items, { from: '2026-10-29', to: '2026-11-30', limit: 1 }),
    ).toThrow(/limit|budget/i);
  });
  it('exports a timezone definition for every local TZID', () => {
    const output = exportCalendar(parseCalendar(source, { timeZone: 'UTC' }).items, {
      datasetId: 'd',
    });
    expect(output).toContain('BEGIN:VTIMEZONE');
    expect(output).toContain('TZID:Asia/Shanghai');
  });
});
