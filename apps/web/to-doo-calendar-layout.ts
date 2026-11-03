import type { ToDooEntityMap } from '../../shared/to-doo-contracts';
import { shiftToDooDate, toDooDisplayTime } from './to-doo-workbench';

/** Resolve the same local-time ambiguity policy as the existing editor/display contract. */
export function toDooTimeInstant(value: ToDooEntityMap['timeBlock']['start']): number {
  const utc = toDooDisplayTime({ ...value, time: value.time || '00:00' }, 'UTC');
  return Date.parse(utc.date + 'T' + utc.time + ':00Z');
}
export function toDooInstantTime(instant: number, zone: string) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(instant));
}
export function toDooBlockSegment(block: ToDooEntityMap['timeBlock'], date: string, zone: string) {
  if (block.allDay || !block.start.time) {
    const end =
      block.dateEndExclusive ||
      shiftToDooDate(block.start.date, Math.max(1, Math.ceil(block.durationMinutes / 1440)));
    return block.start.date <= date && date < end
      ? { time: null, endTime: null, duration: 1440, from: 0, to: 0 }
      : null;
  }
  const start = toDooTimeInstant(block.start);
  const from = Math.max(start, toDooTimeInstant({ date, time: '00:00', timeZone: zone }));
  const to = Math.min(
    start + block.durationMinutes * 60000,
    toDooTimeInstant({ date: shiftToDooDate(date, 1), time: '00:00', timeZone: zone }),
  );
  return from < to
    ? {
        time: toDooInstantTime(from, zone),
        endTime: toDooInstantTime(to, zone),
        duration: (to - from) / 60000,
        from,
        to,
      }
    : null;
}
/** Half-open intervals; drawing height never changes conflict membership. */
export function toDooConflictLanes<T extends { from: number; to: number }>(values: T[]) {
  const sorted = [...values].sort((a, b) => a.from - b.from || a.to - b.to);
  const result: (T & { lane: number; lanes: number })[] = [];
  let component: (T & { lane: number; lanes: number })[] = [],
    ends: number[] = [],
    until = -Infinity;
  function flush() {
    result.push(...component.map((entry) => ({ ...entry, lanes: ends.length })));
    component = [];
    ends = [];
    until = -Infinity;
  }
  for (const value of sorted) {
    if (value.from >= until) flush();
    let lane = ends.findIndex((end) => end <= value.from);
    if (lane < 0) lane = ends.length;
    ends[lane] = value.to;
    until = Math.max(until, value.to);
    component.push({ ...value, lane, lanes: 1 });
  }
  flush();
  return result;
}
