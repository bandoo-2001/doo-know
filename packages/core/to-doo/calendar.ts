import { createHash } from 'node:crypto';
import ICAL from 'ical.js';
import type { ToDooDateTime } from '../../../shared/to-doo-contracts.js';

export type CalendarItem = {
  component: 'VEVENT' | 'VTODO';
  uid: string;
  recurrenceId: string | null;
  recurrenceTimeZone: string | null;
  title: string;
  description: string;
  start: ToDooDateTime;
  end: ToDooDateTime | null;
  allDay: boolean;
  status: string | null;
  rrule: string | null;
  excludedDates: string[];
  additionalDates: string[];
  raw: string;
};
export class CalendarFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalendarFormatError';
  }
}
export function calendarItemId(sourceId: string, uid: string, recurrenceId: string | null): string {
  return (
    'cal_' +
    createHash('sha256')
      .update(JSON.stringify([sourceId, uid, recurrenceId]))
      .digest('hex')
      .slice(0, 40)
  );
}
function validZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
function dateTime(property: ICAL.Property | null, defaultZone?: string): ToDooDateTime | null {
  if (!property) return null;
  const value = property.getFirstValue() as ICAL.Time;
  if (!value || typeof value.toString !== 'function')
    throw new CalendarFormatError('Invalid calendar date');
  const zone = String(
    property.getParameter('tzid') || (value.zone?.tzid === 'UTC' ? 'UTC' : defaultZone || ''),
  );
  if (!zone || !validZone(zone))
    throw new CalendarFormatError(
      'Calendar time zone must be explicitly mapped to a supported IANA zone',
    );
  const date = `${String(value.year).padStart(4, '0')}-${String(value.month).padStart(2, '0')}-${String(value.day).padStart(2, '0')}`;
  if (
    !Number.isFinite(Date.parse(date + 'T00:00:00Z')) ||
    new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) !== date
  )
    throw new CalendarFormatError('Invalid calendar date');
  return {
    date,
    time: value.isDate
      ? null
      : `${String(value.hour).padStart(2, '0')}:${String(value.minute).padStart(2, '0')}`,
    timeZone: zone,
  };
}
export function parseCalendar(
  content: string,
  options: { timeZone?: string; maxItems?: number } = {},
): { items: CalendarItem[]; warnings: string[] } {
  if (typeof content !== 'string' || Buffer.byteLength(content) > 10 * 1024 * 1024)
    throw new CalendarFormatError('Calendar exceeds input limit');
  if (
    !/^BEGIN:VCALENDAR\s*$/im.test(content) ||
    !/^END:VCALENDAR\s*$/im.test(content) ||
    content.split('\n').length > 150000
  )
    throw new CalendarFormatError('A complete VCALENDAR is required');
  if (options.timeZone && !validZone(options.timeZone))
    throw new CalendarFormatError('Invalid default time zone');
  let root: ICAL.Component;
  try {
    root = new ICAL.Component(ICAL.parse(content));
  } catch {
    throw new CalendarFormatError('Malformed iCalendar content');
  }
  if (root.name !== 'vcalendar') throw new CalendarFormatError('VCALENDAR is required');
  const components = root
    .getAllSubcomponents()
    .filter((c) => c.name === 'vevent' || c.name === 'vtodo');
  if (components.length > (options.maxItems ?? 10000))
    throw new CalendarFormatError('Calendar item limit exceeded');
  const warnings: string[] = [];
  const items: CalendarItem[] = [];
  const seen = new Set<string>();
  const supported = new Set([
    'uid',
    'dtstart',
    'dtend',
    'due',
    'duration',
    'summary',
    'description',
    'status',
    'rrule',
    'exdate',
    'rdate',
    'recurrence-id',
    'dtstamp',
    'created',
    'last-modified',
    'sequence',
    'prodid',
  ]);
  for (const component of components) {
    const uid = String(component.getFirstPropertyValue('uid') ?? '');
    if (!uid || uid.length > 1000)
      throw new CalendarFormatError('Calendar item requires a bounded UID');
    const start = dateTime(
      component.getFirstProperty('dtstart') ?? component.getFirstProperty('due'),
      options.timeZone,
    );
    if (!start) throw new CalendarFormatError('Calendar item requires DTSTART or DUE');
    let end = dateTime(component.getFirstProperty('dtend'), options.timeZone);
    const duration = component.getFirstPropertyValue('duration') as ICAL.Duration | null;
    if (!end && duration) {
      const startTime = ICAL.Time.fromString(
        start.date + (start.time ? 'T' + start.time + ':00' : ''),
        undefined,
      );
      startTime.addDuration(duration);
      end = {
        date: startTime.toString().slice(0, 10),
        time: start.time ? startTime.toString().slice(11, 16) : null,
        timeZone: start.timeZone,
      };
    }
    const recurrenceProperty = component.getFirstProperty('recurrence-id');
    const recurrence = recurrenceProperty?.getFirstValue() as ICAL.Time | undefined;
    const recurrenceId = recurrence?.toString() ?? null;
    const recurrenceTimeZone = recurrenceProperty
      ? String(
          recurrenceProperty.getParameter('tzid') ||
            (recurrence?.zone?.tzid === 'UTC' ? 'UTC' : start.timeZone),
        )
      : null;
    if (recurrenceTimeZone && !validZone(recurrenceTimeZone))
      throw new CalendarFormatError('Unsupported recurrence time zone');
    const identity = JSON.stringify([uid, recurrenceId]);
    if (seen.has(identity))
      throw new CalendarFormatError('Duplicate UID and RECURRENCE-ID in calendar');
    seen.add(identity);
    const rruleValue = component.getFirstPropertyValue('rrule') as ICAL.Recur | null;
    const rrule = rruleValue?.toString() ?? null;
    if (rrule && rrule.length > 2000)
      throw new CalendarFormatError('Recurrence rule limit exceeded');
    if (rrule && /FREQ=(SECONDLY|MINUTELY|HOURLY)|BYSECOND=|BYMINUTE=|BYHOUR=/i.test(rrule))
      warnings.push(
        `UID ${uid}: fine-grained recurrence remains a read-only source rule; task mapping requires bounded expansion`,
      );
    const dates = (name: string) =>
      component.getAllProperties(name).flatMap((p) => p.getValues().map((v) => String(v)));
    for (const property of component.getAllProperties())
      if (!supported.has(property.name))
        warnings.push(
          `UID ${uid}: ${property.name.toUpperCase()} is preserved in source content; remote resources are not fetched`,
        );
    if (component.getAllSubcomponents().length)
      warnings.push(`UID ${uid}: nested alarms/components are preserved but not activated`);
    const title = String(component.getFirstPropertyValue('summary') ?? '(Untitled)'),
      description = String(component.getFirstPropertyValue('description') ?? '');
    if (title.length > 256 || Buffer.byteLength(description) > 65536)
      throw new CalendarFormatError(
        'Calendar title or description exceeds application limits; split or map the input explicitly',
      );
    items.push({
      component: component.name === 'vtodo' ? 'VTODO' : 'VEVENT',
      uid,
      recurrenceId,
      recurrenceTimeZone,
      title,
      description,
      start,
      end,
      allDay: start.time === null,
      status: component.getFirstPropertyValue('status')
        ? String(component.getFirstPropertyValue('status'))
        : null,
      rrule,
      excludedDates: dates('exdate'),
      additionalDates: dates('rdate'),
      raw: component.toString(),
    });
  }
  return { items, warnings };
}
const escapeText = (value: string) =>
  value
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
function fold(line: string): string {
  let result = '',
    part = '';
  for (const char of line) {
    if (Buffer.byteLength(part + char) > 75) {
      result += part + '\r\n';
      part = ' ';
    }
    part += char;
  }
  return result + part;
}
function formatTime(value: ToDooDateTime): { parameter: string; value: string } {
  if (
    !validZone(value.timeZone) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value.date) ||
    (value.time !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time))
  )
    throw new CalendarFormatError('Invalid calendar date or time zone');
  const date = value.date.replace(/-/g, '');
  if (value.time === null) return { parameter: ';VALUE=DATE', value: date };
  return {
    parameter: value.timeZone === 'UTC' ? '' : ';TZID=' + value.timeZone,
    value: date + 'T' + value.time.replace(':', '') + '00' + (value.timeZone === 'UTC' ? 'Z' : ''),
  };
}
function rawDate(value: string, zone: string): { parameter: string; value: string } {
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}Z?)?$/.test(value))
    throw new CalendarFormatError('Invalid recurrence date');
  if (value.length === 10) return formatTime({ date: value, time: null, timeZone: zone });
  const result = formatTime({
    date: value.slice(0, 10),
    time: value.slice(11, 16),
    timeZone: value.endsWith('Z') ? 'UTC' : zone,
  });
  result.value = result.value.replace(
    /00Z?$/,
    value.slice(17, 19) + (value.endsWith('Z') ? 'Z' : ''),
  );
  return result;
}
export function expandCalendar(
  items: CalendarItem[],
  options: { from: string; to: string; limit?: number },
): CalendarItem[] {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(options.from) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(options.to) ||
    options.to < options.from
  )
    throw new CalendarFormatError('Invalid calendar expansion range');
  const limit = options.limit ?? 10000,
    result: CalendarItem[] = [];
  const exceptions = new Map(
    items
      .filter((i) => i.recurrenceId)
      .map((i) => [JSON.stringify([i.uid, i.recurrenceId?.replace(/Z$/, '')]), i]),
  );
  const used = new Set<string>();
  const append = (item: CalendarItem) => {
    if (
      item.status === 'CANCELLED' ||
      item.start.date < options.from ||
      item.start.date > options.to
    )
      return;
    if (result.length >= limit)
      throw new CalendarFormatError('Calendar expansion result limit exceeded');
    result.push(item);
  };
  for (const item of items.filter((i) => !i.recurrenceId)) {
    if (!item.rrule && !item.additionalDates.length) {
      append(item);
      continue;
    }
    const dates = new Set<string>();
    if (item.rrule) {
      let iterator: ICAL.RecurIterator;
      try {
        iterator = ICAL.Recur.fromString(item.rrule).iterator(
          ICAL.Time.fromString(
            item.start.date + (item.start.time ? 'T' + item.start.time + ':00' : ''),
            undefined,
          ),
        );
      } catch {
        throw new CalendarFormatError('Unsupported recurrence rule');
      }
      let count = 0;
      for (;;) {
        if (++count > 100000)
          throw new CalendarFormatError('Calendar recurrence iteration budget exceeded');
        const date = iterator.next();
        if (!date) break;
        const key = date.toString();
        if (key.slice(0, 10) > options.to) break;
        if (key.slice(0, 10) >= options.from) dates.add(key);
      }
    } else dates.add(item.start.date + (item.start.time ? 'T' + item.start.time + ':00' : ''));
    for (const date of item.additionalDates) dates.add(date.replace(/Z$/, ''));
    const excluded = new Set(item.excludedDates.map((date) => date.replace(/Z$/, '')));
    const span = item.end
      ? Date.parse(item.end.date + 'T' + (item.end.time ?? '00:00') + ':00Z') -
        Date.parse(item.start.date + 'T' + (item.start.time ?? '00:00') + ':00Z')
      : null;
    for (const date of [...dates].sort()) {
      if (excluded.has(date) || excluded.has(date.slice(0, 10))) continue;
      const identity = JSON.stringify([item.uid, date.replace(/Z$/, '')]);
      const exception = exceptions.get(identity);
      if (exception) {
        append(exception);
        used.add(identity);
        continue;
      }
      const start = {
        date: date.slice(0, 10),
        time: item.start.time === null ? null : date.slice(11, 16),
        timeZone: item.start.timeZone,
      };
      let end: ToDooDateTime | null = null;
      if (span !== null) {
        const value = new Date(
          Date.parse(start.date + 'T' + (start.time ?? '00:00') + ':00Z') + span,
        );
        end = {
          date: value.toISOString().slice(0, 10),
          time: item.end!.time === null ? null : value.toISOString().slice(11, 16),
          timeZone: item.end!.timeZone,
        };
      }
      append({
        ...item,
        start,
        end,
        recurrenceId: date,
        recurrenceTimeZone: item.start.timeZone,
        rrule: null,
        excludedDates: [],
        additionalDates: [],
      });
    }
  }
  for (const [key, item] of exceptions) if (!used.has(key)) append(item);
  return result.sort((a, b) =>
    (a.start.date + (a.start.time ?? '')).localeCompare(b.start.date + (b.start.time ?? '')),
  );
}
function timezoneDefinition(zone: string, firstYear: number, lastYear: number): string[] {
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const local = (at: number) => {
    const p = Object.fromEntries(
      formatter.formatToParts(new Date(at)).map((v) => [v.type, v.value]),
    );
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
  };
  const offset = (at: number) => Math.round((Date.parse(local(at) + 'Z') - at) / 60000);
  const offsetText = (minutes: number) => {
    const absolute = Math.abs(minutes);
    return (
      (minutes < 0 ? '-' : '+') +
      String(Math.floor(absolute / 60)).padStart(2, '0') +
      String(absolute % 60).padStart(2, '0')
    );
  };
  const from = Date.UTC(firstYear - 1, 0, 1),
    to = Date.UTC(lastYear + 2, 0, 1);
  let previous = offset(from);
  const lines = ['BEGIN:VTIMEZONE', 'TZID:' + zone, 'X-LIC-LOCATION:' + zone];
  lines.push(
    'BEGIN:STANDARD',
    'DTSTART:' + String(firstYear - 1).padStart(4, '0') + '0101T000000',
    'TZOFFSETFROM:' + offsetText(previous),
    'TZOFFSETTO:' + offsetText(previous),
    'END:STANDARD',
  );
  for (let at = from + 86400000; at <= to; at += 86400000) {
    const current = offset(at);
    if (current === previous) continue;
    let lower = at - 86400000,
      upper = at;
    while (upper - lower > 60000) {
      const middle = Math.floor((lower + upper) / 120000) * 60000;
      if (offset(middle) === previous) lower = middle;
      else upper = middle;
    }
    const component = current > previous ? 'DAYLIGHT' : 'STANDARD';
    const transition = new Date(upper + previous * 60000)
      .toISOString()
      .slice(0, 19)
      .replace(/[-:]/g, '');
    lines.push(
      'BEGIN:' + component,
      'DTSTART:' + transition,
      'TZOFFSETFROM:' + offsetText(previous),
      'TZOFFSETTO:' + offsetText(current),
      'END:' + component,
    );
    previous = current;
  }
  lines.push('END:VTIMEZONE');
  return lines;
}
export function exportCalendar(
  items: CalendarItem[],
  options: { datasetId: string; includeDescription?: boolean; mode?: 'events' | 'todos' },
): string {
  if (items.length > 100000)
    throw new CalendarFormatError('Calendar export requires a bounded range');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//DooKnow//To Doo//EN',
    'CALSCALE:GREGORIAN',
  ];
  const zones = new Map<string, { from: number; to: number }>();
  for (const item of items)
    for (const value of [item.start, item.end])
      if (value?.time && value.timeZone !== 'UTC') {
        const year = Number(value.date.slice(0, 4)),
          range = zones.get(value.timeZone);
        zones.set(value.timeZone, {
          from: Math.min(range?.from ?? year, year),
          to: Math.max(range?.to ?? year, year),
        });
      }
  if (zones.size > 32 || [...zones.values()].some((range) => range.to - range.from > 100))
    throw new CalendarFormatError(
      'Calendar timezone export budget exceeded; select a narrower range',
    );
  for (const [zone, range] of zones) lines.push(...timezoneDefinition(zone, range.from, range.to));
  for (const item of items) {
    const component =
      options.mode === 'todos' ? 'VTODO' : options.mode === 'events' ? 'VEVENT' : item.component;
    lines.push(
      'BEGIN:' + component,
      'UID:' + escapeText(item.uid),
      'DTSTAMP:19700101T000000Z',
      'SUMMARY:' + escapeText(item.title),
    );
    const start = formatTime(item.start);
    lines.push((component === 'VTODO' ? 'DUE' : 'DTSTART') + start.parameter + ':' + start.value);
    if (item.end && component === 'VEVENT') {
      const end = formatTime(item.end);
      lines.push('DTEND' + end.parameter + ':' + end.value);
    }
    if (options.includeDescription && item.description)
      lines.push('DESCRIPTION:' + escapeText(item.description));
    if (item.status && /^[A-Z-]+$/.test(item.status)) lines.push('STATUS:' + item.status);
    if (item.rrule) {
      try {
        lines.push('RRULE:' + ICAL.Recur.fromString(item.rrule).toString());
      } catch {
        throw new CalendarFormatError('Invalid recurrence rule');
      }
    }
    if (item.recurrenceId) {
      const recurrence = rawDate(item.recurrenceId, item.recurrenceTimeZone ?? item.start.timeZone);
      lines.push('RECURRENCE-ID' + recurrence.parameter + ':' + recurrence.value);
    }
    for (const [field, values] of [
      ['EXDATE', item.excludedDates],
      ['RDATE', item.additionalDates],
    ] as const)
      for (const value of values) {
        const date = rawDate(value, item.start.timeZone);
        lines.push(field + date.parameter + ':' + date.value);
      }
    lines.push('END:' + component);
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
