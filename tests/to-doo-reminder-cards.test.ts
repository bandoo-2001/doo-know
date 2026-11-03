import { readFileSync } from 'node:fs';
import { compileScript, parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as Vue from 'vue';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as reminders from '../apps/web/to-doo-reminders';
import { toDooEntitySchemas } from '../shared/to-doo-contracts';
import type { ToDooReminderCard, ToDooReminderFeed } from '../shared/to-doo-reminders';

const cleanup: (() => void)[] = [];
beforeEach(() => {
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} });
  vi.stubGlobal('document', {
    visibilityState: 'visible',
    addEventListener() {},
    removeEventListener() {},
  });
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('BroadcastChannel', undefined);
  vi.stubGlobal('location', {
    href: 'https://app.example/?view=apps&app=to-doo&reminder=reminder-1',
    origin: 'https://app.example',
  });
});
afterEach(() => {
  cleanup.splice(0).forEach((fn) => fn());
  vi.unstubAllGlobals();
});

async function settled() {
  for (let i = 0; i < 8; i++) await Vue.nextTick();
}

async function cards(queued: ToDooReminderCard[] = []) {
  const current: ToDooReminderCard = {
    event: toDooEntitySchemas.reminderEvent.parse({
      id: 'reminder-1',
      revision: 'r1',
      createdAt: '2026-10-30T08:00:00Z',
      updatedAt: '2026-10-30T08:00:00Z',
      sourceType: 'habit',
      sourceId: 'habit-1',
      occurrenceKey: '2026-10-30',
      ruleId: 'rule-1',
      scheduleRevision: 'r1',
      scheduledAt: '2026-10-30T08:00:00Z',
      title: '阅读十页',
    }),
    section: 'habits',
    completion: 'habit',
    date: '2026-10-30',
    habit: { amount: 0, target: 10, unit: '页' },
  };
  const writes: { url: string; body: any }[] = [];
  let release!: (value: ToDooReminderFeed) => void;
  let pending = true;
  const delayed = new Promise<ToDooReminderFeed>((resolve) => {
    release = resolve;
  });
  const feed = (): ToDooReminderFeed => ({
    reminders: [structuredClone(current), ...queued.map((card) => structuredClone(card))],
    missedCount: 0,
    timeZone: 'UTC',
  });
  const request = async (url: string, method = 'GET', body?: unknown) => {
    if (method === 'POST') {
      writes.push({ url, body: JSON.parse(JSON.stringify(body)) });
      return {};
    }
    if (url.endsWith('/pending')) {
      if (pending) {
        pending = false;
        return delayed;
      }
      return feed();
    }
    if (url.endsWith('/reminder-1')) return structuredClone(current);
    throw Error('Unexpected request: ' + url);
  };
  const { descriptor } = parse(
    readFileSync(
      new URL('../apps/web/components/to-doo/ToDooReminderCards.vue', import.meta.url),
      'utf8',
    ),
  );
  const script = compileScript(descriptor, { id: 'reminder-cards' });
  const compiled = ts.transpileModule(script.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const output = { exports: {} as any };
  new Function('require', 'module', 'exports', compiled)(
    (id: string) => {
      if (id === 'vue') return Vue;
      if (id.endsWith('/to-doo-reminders')) return reminders;
      if (id === '../../api') return { api: request };
      if (id === 'ant-design-vue') return {};
      throw Error('Unexpected reminder card dependency: ' + id);
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
  const app = renderer.createApp({ ...output.exports.default, render: () => null });
  const instance = app.mount({});
  cleanup.push(() => app.unmount());
  await settled();
  return {
    state: (instance.$ as any).setupState,
    current,
    writes,
    refreshArrives: async () => {
      release(feed());
      await settled();
    },
  };
}

test('a delayed refresh after opening a habit notification preserves the entered amount and submits it once', async () => {
  const view = await cards();
  expect(view.state.amount).toBe(10);
  view.state.amount = 3;
  view.state.minutes = 30;
  await view.refreshArrives();
  expect(view.state.amount).toBe(3);
  expect(view.state.minutes).toBe(30);
  await view.state.complete();
  expect(view.writes).toEqual([
    {
      url: '/api/to-doo/reminders/reminder-1/complete',
      body: expect.objectContaining({ amount: 3 }),
    },
  ]);
  expect(view.state.state.cards).toEqual([]);
});

test('a new delivery generation initializes its own quantity and snooze interval', async () => {
  const view = await cards();
  await view.refreshArrives();
  view.state.amount = 3;
  view.state.minutes = 30;
  view.current.event.deliveryGeneration = 1;
  view.current.habit!.amount = 2;
  await view.state.controller.refresh();
  await settled();
  expect(view.state.amount).toBe(8);
  expect(view.state.minutes).toBe(15);
});

test('an ordinary weekly reminder submits one check-in even without a quantity draft', async () => {
  const view = await cards();
  await view.refreshArrives();
  Object.assign(view.current.habit!, { goalMode: 'checkin', target: 3, unit: '次' });
  view.current.event.deliveryGeneration = 1;
  await view.state.controller.refresh();
  await settled();
  expect(view.state.amount).toBe(1);
  view.state.amount = undefined;
  await view.state.complete();
  expect(view.writes).toEqual([
    {
      url: '/api/to-doo/reminders/reminder-1/complete',
      body: expect.objectContaining({ amount: 1 }),
    },
  ]);
});


test('activating a notification displays its exact reminder after browsing another queued card', async () => {
  const queued: ToDooReminderCard[] = [];
  const view = await cards(queued);
  await view.refreshArrives();
  const other = structuredClone(view.current);
  other.event.id = 'reminder-2';
  other.event.title = '另一条排队提醒';
  queued.push(other);
  await view.state.controller.refresh();
  view.state.current = 1;
  await settled();
  expect(view.state.card.event.id).toBe('reminder-2');
  await view.state.message(new MessageEvent('message', {
    data: { type: 'dooknow-to-doo-open-reminder', eventId: view.current.event.id },
  }));
  await settled();
  expect(view.state.card.event.id).toBe(view.current.event.id);
});
