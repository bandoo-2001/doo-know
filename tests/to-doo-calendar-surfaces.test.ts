import { readFileSync } from 'node:fs';
import { compileScript, parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as Vue from 'vue';
import { afterEach, expect, test } from 'vitest';
import * as workbench from '../apps/web/to-doo-workbench';
import * as presentation from '../apps/web/to-doo-presentation';
import * as calendarLayout from '../apps/web/to-doo-calendar-layout';
import * as time from '../apps/web/to-doo-time';
import * as groups from '../apps/web/to-doo-task-groups';
import * as anniversaries from '../shared/to-doo-anniversaries';
import { toDooEntitySchemas, type ToDooEntityMap } from '../shared/to-doo-contracts';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));

function calendar(
  event: ToDooEntityMap['calendarEvent'] | null,
  timeZone = 'UTC',
  blocks: ToDooEntityMap['timeBlock'][] = [],
) {
  const { descriptor } = parse(
    readFileSync(
      new URL('../apps/web/components/to-doo/ToDooCalendar.vue', import.meta.url),
      'utf8',
    ),
  );
  const script = compileScript(descriptor, { id: 'calendar-surfaces' });
  const compiled = ts.transpileModule(script.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const output = { exports: {} as any };
  new Function('require', 'module', 'exports', compiled)(
    (id: string) => {
      if (id.endsWith('/to-doo-calendar-layout')) return calendarLayout;
      if (id.endsWith('/to-doo-time')) return time;
      if (id === 'vue') return Vue;
      if (id.endsWith('/to-doo-workbench')) return workbench;
      if (id.endsWith('/to-doo-presentation')) return presentation;
      if (id.endsWith('/to-doo-task-groups')) return groups;
      if (id.endsWith('/to-doo-anniversaries')) return anniversaries;
      if (id === 'ant-design-vue' || id.endsWith('.vue')) return {};
      throw Error('Unexpected calendar dependency: ' + id);
    },
    output,
    output.exports,
  );
  const renderer = Vue.createRenderer<any, any>({
    createComment: () => ({}),
    createElement: () => ({}),
    createText: () => ({}),
    insert() {},
    remove() {},
    setText() {},
    setElementText() {},
    patchProp() {},
    parentNode: () => null,
    nextSibling: () => null,
  });
  const subject = { ...output.exports.default, render: () => null };
  const app = renderer.createApp(subject, {
    model: {
      state: Vue.reactive({
        snapshot: {
          settings: { timeZone },
          calendarEvents: event ? [event] : [],
          timeBlocks: blocks,
        },
      }),
      items: () => [],
    },
    date: '2026-11-02',
    view: 'week',
  });
  const instance = app.mount({});
  cleanup.push(() => app.unmount());
  return (instance.$ as any).setupState;
}

function event(overrides: Partial<ToDooEntityMap['calendarEvent']>) {
  return toDooEntitySchemas.calendarEvent.parse({
    id: 'external-event',
    revision: 'r1',
    createdAt: '2026-10-30T08:00:00Z',
    updatedAt: '2026-10-30T08:00:00Z',
    uid: 'calendar-event',
    title: '外部日历安排',
    readOnly: true,
    start: { date: '2026-11-02', time: null, timeZone: 'UTC' },
    ...overrides,
  });
}

test('a multi-day all-day event appears on every occupied date and excludes its end date', () => {
  const value = event({
    allDay: true,
    end: { date: '2026-11-05', time: null, timeZone: 'UTC' },
  });
  const view = calendar(value, 'Asia/Shanghai');
  expect(view.external('2026-11-01')).toEqual([]);
  expect(view.external('2026-11-02')).toEqual([value]);
  expect(view.external('2026-11-03')).toEqual([value]);
  expect(view.external('2026-11-04')).toEqual([value]);
  expect(view.external('2026-11-05')).toEqual([]);
  expect(view.weekEvents('2026-11-03')).toEqual([]);
});

test('an overnight event splits into clipped segments after conversion to the displayed timezone', () => {
  const value = event({
    start: { date: '2026-11-02', time: '15:00', timeZone: 'UTC' },
    end: { date: '2026-11-02', time: '17:00', timeZone: 'UTC' },
  });
  const view = calendar(value, 'Asia/Shanghai');
  expect(view.external('2026-11-02')).toEqual([value]);
  expect(view.external('2026-11-03')).toEqual([value]);
  expect(view.external('2026-11-04')).toEqual([]);
  expect(view.weekEvents('2026-11-02')).toEqual([
    expect.objectContaining({ time: '23:00', duration: 60, event: value }),
  ]);
  expect(view.weekEvents('2026-11-03')).toEqual([
    expect.objectContaining({ time: '00:00', duration: 60, event: value }),
  ]);
});

test('a timed event ending at midnight does not occupy the following day', () => {
  const view = calendar(
    event({
      start: { date: '2026-11-02', time: '23:00', timeZone: 'UTC' },
      end: { date: '2026-11-03', time: '00:00', timeZone: 'UTC' },
    }),
  );
  expect(view.weekEvents('2026-11-02')).toEqual([
    expect.objectContaining({ time: '23:00', duration: 60 }),
  ]);
  expect(view.external('2026-11-03')).toEqual([]);
});

test('a timed event spanning a full middle day uses that day’s midnight and duration', () => {
  const value = event({
    start: { date: '2026-11-02', time: '22:00', timeZone: 'UTC' },
    end: { date: '2026-11-04', time: '02:00', timeZone: 'UTC' },
  });
  const view = calendar(value);
  expect(view.weekEvents('2026-11-02')[0]).toMatchObject({ time: '22:00', duration: 120 });
  expect(view.weekEvents('2026-11-03')[0]).toMatchObject({ time: '00:00', duration: 1440 });
  expect(view.weekEvents('2026-11-04')[0]).toMatchObject({ time: '00:00', duration: 120 });
});

test('a fall-back event stays visible when its local end time precedes its local start time', () => {
  const value = event({
    start: { date: '2026-11-01', time: '05:30', timeZone: 'UTC' },
    end: { date: '2026-11-01', time: '06:15', timeZone: 'UTC' },
  });
  const view = calendar(value, 'America/New_York');
  expect(view.external('2026-11-01')).toEqual([value]);
  expect(view.weekEvents('2026-11-01')).toEqual([
    expect.objectContaining({ time: '01:30', duration: 45, event: value }),
  ]);
  expect(view.external('2026-11-02')).toEqual([]);
});

test('overnight clipping follows the actual length of a fall-back day', () => {
  const view = calendar(
    event({
      start: { date: '2026-11-01', time: '03:30', timeZone: 'UTC' },
      end: { date: '2026-11-01', time: '06:15', timeZone: 'UTC' },
    }),
    'America/New_York',
  );
  expect(view.weekEvents('2026-10-31')[0]).toMatchObject({ time: '23:30', duration: 30 });
  expect(view.weekEvents('2026-11-01')[0]).toMatchObject({ time: '00:00', duration: 135 });
});

test('a spring-forward event displays its actual elapsed duration', () => {
  const view = calendar(
    event({
      start: { date: '2027-03-14', time: '06:45', timeZone: 'UTC' },
      end: { date: '2027-03-14', time: '07:30', timeZone: 'UTC' },
    }),
    'America/New_York',
  );
  expect(view.weekEvents('2027-03-14')[0]).toMatchObject({ time: '01:45', duration: 45 });
});

function block(id: string, time: string | null, durationMinutes: number, extra = {}) {
  return toDooEntitySchemas.timeBlock.parse({
    id,
    revision: 'r1',
    createdAt: '2026-11-02T08:00:00Z',
    updatedAt: '2026-11-02T08:00:00Z',
    title: id,
    start: { date: '2026-11-02', time, timeZone: 'UTC' },
    durationMinutes,
    ...extra,
  });
}
test('ordinary overnight blocks are clipped on both days and retain the original entity for editing', () => {
  const original = block('overnight', '23:30', 90);
  const view = calendar(null, 'UTC', [original]);
  expect(view.weekEvents('2026-11-02')).toEqual([
    expect.objectContaining({ time: '23:30', duration: 30, block: original }),
  ]);
  expect(view.weekEvents('2026-11-03')).toEqual([
    expect.objectContaining({ time: '00:00', duration: 60, block: original }),
  ]);
  expect(view.blocks('2026-11-03')).toEqual([original]);
  expect(view.weekEvents('2026-11-04')).toEqual([]);
});
test('independent afternoon blocks get full width after an overlapping morning component', () => {
  const view = calendar(null, 'UTC', [
    block('first', '09:00', 60),
    block('second', '09:30', 60),
    block('later', '15:00', 30),
  ]);
  expect(view.weekEvents('2026-11-02').map((entry: any) => [entry.id, entry.lanes])).toEqual([
    ['first', 2],
    ['second', 2],
    ['later', 1],
  ]);
});
test('ordinary segments follow real spring and fall midnight boundaries', () => {
  const fall = block('fall', '03:30', 165, {
    start: { date: '2026-11-01', time: '03:30', timeZone: 'UTC' },
  });
  expect(calendar(null, 'America/New_York', [fall]).weekEvents('2026-11-01')[0]).toMatchObject({
    time: '00:00',
    duration: 135,
  });
  const spring = block('spring', '04:30', 180, {
    start: { date: '2027-03-14', time: '04:30', timeZone: 'UTC' },
  });
  expect(calendar(null, 'America/New_York', [spring]).weekEvents('2027-03-14')[0]).toMatchObject({
    time: '00:00',
    duration: 150,
  });
});

test('adjacent short blocks keep independent actual intervals and receive distinct readable display lanes', () => {
  const view = calendar(null, 'UTC', [
    block('first-short', '09:00', 5),
    block('second-short', '09:05', 5),
  ]);
  const entries = view.weekEvents('2026-11-02');
  expect(entries.map((entry: any) => entry.lanes)).toEqual([1, 1]);
  expect(entries.map((entry: any) => entry.displayLanes)).toEqual([2, 2]);
  expect(entries[0].displayLane).not.toBe(entries[1].displayLane);
});
