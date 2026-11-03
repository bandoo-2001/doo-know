import { readFileSync } from 'node:fs';
import { compileScript, parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as Vue from 'vue';
import { afterEach, expect, test } from 'vitest';
import * as workbench from '../apps/web/to-doo-workbench';
import * as presentation from '../apps/web/to-doo-presentation';
import * as groups from '../apps/web/to-doo-task-groups';
import * as anniversaries from '../shared/to-doo-anniversaries';
import { toDooEntitySchemas, type ToDooEntityMap } from '../shared/to-doo-contracts';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));

function calendar(event: ToDooEntityMap['calendarEvent'], timeZone = 'UTC') {
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
        snapshot: { settings: { timeZone }, calendarEvents: [event], timeBlocks: [] },
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
