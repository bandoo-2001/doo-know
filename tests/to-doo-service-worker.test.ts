import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const origin = 'https://knowledge.example';
const notificationsPath = '/?view=apps&app=to-doo&appSection=notifications';
const source = readFileSync(new URL('../apps/web/public/to-doo-sw.js', import.meta.url), 'utf8');

function windowClient(url: string) {
  const state = { url, messages: [] as unknown[], focused: false, navigations: [] as string[] };
  return {
    state,
    url,
    type: 'window',
    postMessage(message: unknown) {
      state.messages.push(message);
    },
    async focus() {
      state.focused = true;
      return this;
    },
    async navigate(href: string) {
      state.navigations.push(href);
      return this;
    },
  };
}

type TestEvent = {
  data?: { json(): unknown } | null;
  notification?: { data: unknown; close(): void };
  waitUntil(promise: Promise<unknown>): void;
};

function worker(
  clients: ReturnType<typeof windowClient>[] = [],
  failClientLookup = false,
  lifecycleWait: { installation?: Promise<void>; activation?: Promise<void> } = {},
) {
  const handlers = new Map<string, (event: TestEvent) => void>();
  const notifications: {
    title: string;
    options: { body: string; tag: string; data: unknown; renotify: boolean };
  }[] = [];
  const opened: string[] = [];
  const queries: unknown[] = [];
  const lifecycle = { skippedWaiting: 0, claimedClients: 0 };
  runInNewContext(source, {
    URL,
    self: {
      location: { origin },
      addEventListener(type: string, handler: (event: TestEvent) => void) {
        handlers.set(type, handler);
      },
      async skipWaiting() {
        lifecycle.skippedWaiting++;
        await lifecycleWait.installation;
      },
      registration: {
        async showNotification(title: string, options: (typeof notifications)[number]['options']) {
          if (options.renotify && !options.tag)
            throw new TypeError('Renotify requires a nonempty tag');
          notifications.push({ title, options });
        },
      },
      clients: {
        async claim() {
          lifecycle.claimedClients++;
          await lifecycleWait.activation;
        },
        async matchAll(query: unknown) {
          queries.push(query);
          if (failClientLookup) throw new Error('Window lookup unavailable');
          return clients;
        },
        async openWindow(url: string) {
          opened.push(url);
          return null;
        },
      },
    },
  });
  async function dispatch(type: string, detail: Omit<TestEvent, 'waitUntil'>) {
    const pending: Promise<unknown>[] = [];
    const handler = handlers.get(type);
    if (!handler) throw new Error(`Missing ${type} handler`);
    handler({ ...detail, waitUntil: (promise) => pending.push(Promise.resolve(promise)) });
    await Promise.all(pending);
  }
  return {
    notifications,
    opened,
    queries,
    lifecycle,
    install: () => dispatch('install', {}),
    activate: () => dispatch('activate', {}),
    push: (payload: unknown) => dispatch('push', { data: { json: () => payload } }),
    unreadablePush: () =>
      dispatch('push', {
        data: {
          json: () => {
            throw new Error('Invalid JSON');
          },
        },
      }),
    async click(data: unknown) {
      let closed = false;
      await dispatch('notificationclick', {
        notification: {
          data,
          close: () => {
            closed = true;
          },
        },
      });
      return { closed };
    },
  };
}

describe('To Doo Service Worker reminders', () => {
  it('keeps installation alive until the new push worker has skipped waiting', async () => {
    let releaseInstallation = () => {};
    const installation = new Promise<void>((resolve) => {
      releaseInstallation = resolve;
    });
    const sw = worker([], false, { installation });
    let finished = false;
    let failure: unknown;
    const installing = sw.install().then(
      () => {
        finished = true;
      },
      (cause) => {
        failure = cause;
        finished = true;
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(sw.lifecycle.skippedWaiting).toBe(1);
    expect(finished).toBe(false);
    releaseInstallation();
    await installing;
    expect(failure).toBeUndefined();
    expect(finished).toBe(true);
  });

  it('keeps activation alive until existing windows use the new safe notification worker', async () => {
    let releaseActivation = () => {};
    const activation = new Promise<void>((resolve) => {
      releaseActivation = resolve;
    });
    const note = windowClient(`${origin}/?note=unsaved-note`);
    const sw = worker([note], false, { activation });
    let finished = false;
    let failure: unknown;
    const activating = sw.activate().then(
      () => {
        finished = true;
      },
      (cause) => {
        failure = cause;
        finished = true;
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(sw.lifecycle.claimedClients).toBe(1);
    expect(finished).toBe(false);
    expect(note.state.navigations).toEqual([]);
    releaseActivation();
    await activating;
    expect(failure).toBeUndefined();
    expect(finished).toBe(true);
  });

  it('displays a system notification without any open window and retains the delivery generation', async () => {
    const sw = worker();
    await sw.push({
      title: '喝水',
      body: '该喝水了',
      tag: 'reminder-1',
      eventId: 'reminder-1',
      generation: 0,
      url: notificationsPath,
    });
    expect(sw.notifications).toEqual([
      {
        title: '喝水',
        options: expect.objectContaining({
          body: '该喝水了',
          tag: 'reminder-1',
          renotify: false,
          data: { eventId: 'reminder-1', generation: 0, url: notificationsPath },
        }),
      },
    ]);
    expect(sw.opened).toEqual([]);
  });

  it('requests a new alert for a snoozed delivery while replacing the same event notification', async () => {
    const sw = worker();
    await sw.push({ tag: 'event-1', eventId: 'event-1', generation: 0 });
    await sw.push({ tag: 'event-1', eventId: 'event-1', generation: 1 });
    expect(
      sw.notifications.map(({ options }) => ({ tag: options.tag, renotify: options.renotify })),
    ).toEqual([
      { tag: 'event-1', renotify: false },
      { tag: 'event-1', renotify: true },
    ]);
    expect(sw.notifications[1]?.options.data).toMatchObject({ eventId: 'event-1', generation: 1 });
  });

  it.each([undefined, null, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, '1'])(
    'does not request a replacement alert for invalid delivery generation %j',
    async (generation) => {
      const sw = worker();
      await sw.push({ tag: 'event-1', eventId: 'event-1', generation });
      expect(sw.notifications[0]?.options.renotify).toBe(false);
    },
  );

  it('keeps a nonempty tag so a snoozed delivery with an empty payload tag can still be displayed', async () => {
    const sw = worker();
    await sw.push({ tag: '', eventId: 'event-1', generation: 2 });
    expect(sw.notifications).toHaveLength(1);
    expect(sw.notifications[0]?.options.tag).not.toBe('');
    expect(sw.notifications[0]?.options.renotify).toBe(true);
  });

  it('still displays the system notification while asking existing workspaces to refresh cards', async () => {
    const note = windowClient(`${origin}/?note=unsaved-note`);
    const todo = windowClient(`${origin}/?view=apps&app=to-doo`);
    const sw = worker([note, todo]);
    await sw.push({ eventId: 'reminder-1', generation: 0 });
    expect(sw.notifications).toHaveLength(1);
    expect(note.state.messages).toEqual([{ type: 'dooknow-to-doo-reminder-update' }]);
    expect(todo.state.messages).toEqual([{ type: 'dooknow-to-doo-reminder-update' }]);
    expect(note.state.navigations).toEqual([]);
  });

  it('keeps background notification delivery working when window discovery fails', async () => {
    const sw = worker([], true);
    await sw.push({ eventId: 'reminder-1' });
    expect(sw.notifications).toHaveLength(1);
  });

  it.each([null, [], 'text', 42, { title: 4, body: null }].map((payload) => [payload]))(
    'uses a generic notification for malformed payload %j',
    async (payload) => {
      const sw = worker();
      await sw.push(payload);
      expect(sw.notifications[0]).toEqual({
        title: 'To Doo 有一项提醒',
        options: expect.objectContaining({
          body: '打开 To Doo 查看',
          data: { eventId: null, generation: null, url: notificationsPath },
        }),
      });
    },
  );

  it('uses a generic notification for unreadable JSON', async () => {
    const sw = worker();
    await sw.unreadablePush();
    expect(sw.notifications[0]?.title).toBe('To Doo 有一项提醒');
  });

  it('cleans notification data before storing it for a later click', async () => {
    const sw = worker();
    await sw.push({ eventId: '../api/secrets', generation: -2, url: '/api/backup' });
    expect(sw.notifications[0]?.options.data).toEqual({
      eventId: null,
      generation: null,
      url: notificationsPath,
    });
  });

  it('opens the reminder in a live workspace without navigating away from an unsaved editor', async () => {
    const note = windowClient(`${origin}/?note=unsaved-note#L3`);
    const sw = worker([note]);
    const click = await sw.click({ eventId: 'event_1-2', url: `${notificationsPath}&task=task-1` });
    expect(click.closed).toBe(true);
    expect(note.state.messages).toEqual([
      {
        type: 'dooknow-to-doo-open-reminder',
        eventId: 'event_1-2',
        url: `${notificationsPath}&task=task-1`,
      },
    ]);
    expect(note.state.focused).toBe(true);
    expect(note.state.navigations).toEqual([]);
    expect(sw.opened).toEqual([]);
    expect(sw.queries).toEqual([{ type: 'window', includeUncontrolled: true }]);
  });

  it('skips public and unrelated clients and selects an actual workspace', async () => {
    const excluded = [
      windowClient(`${origin}/blog`),
      windowClient(`${origin}/s/public-token`),
      windowClient(`${origin}/oauth/consent`),
      windowClient(`${origin}/login`),
      windowClient('https://other.example/?note=private-note'),
      windowClient('not a URL'),
    ];
    const workspace = windowClient(`${origin}/?view=apps&app=blog`);
    const sw = worker([...excluded, workspace]);
    await sw.click({ eventId: 'event-1', url: notificationsPath });
    expect(workspace.state.focused).toBe(true);
    expect(workspace.state.messages).toHaveLength(1);
    for (const client of excluded)
      expect(client.state).toMatchObject({ focused: false, messages: [], navigations: [] });
    expect(sw.opened).toEqual([]);
  });

  it('opens a safe cold-start URL with the event ID when only public windows exist', async () => {
    const blog = windowClient(`${origin}/blog/article`);
    const sw = worker([blog]);
    await sw.click({ eventId: 'event-1', url: `${origin}${notificationsPath}&task=task-1` });
    expect(sw.opened).toEqual([`${origin}${notificationsPath}&task=task-1&reminder=event-1`]);
    expect(blog.state.messages).toEqual([]);
    expect(blog.state.navigations).toEqual([]);
  });

  it.each([
    'https://attacker.example/?view=apps&app=to-doo',
    '//attacker.example/?view=apps&app=to-doo',
    '/api/backup?view=apps&app=to-doo',
    '/oauth/consent?view=apps&app=to-doo',
    '/blog?view=apps&app=to-doo',
    '/?view=settings&app=to-doo',
    '/?view=apps&app=blog',
    'javascript:alert(1)',
    { toString: () => '/?view=apps&app=to-doo' },
  ])('falls back to the notification center for an untrusted click URL %j', async (url) => {
    const sw = worker();
    await sw.click({ eventId: 'event-1', url });
    expect(sw.opened).toEqual([`${origin}${notificationsPath}&reminder=event-1`]);
  });

  it.each([undefined, null, '', '../secrets', 'event id', 'a'.repeat(129), 99])(
    'falls back to the notification center for invalid event ID %j',
    async (eventId) => {
      const sw = worker();
      await sw.click({
        eventId,
        url: '/?view=apps&app=to-doo&appSection=tasks&task=task-1&reminder=injected',
      });
      expect(sw.opened).toEqual([`${origin}${notificationsPath}`]);
    },
  );

  it('sends a safe center fallback to an existing workspace for a malformed notification', async () => {
    const note = windowClient(`${origin}/?note=unsaved-note`);
    const sw = worker([note]);
    await sw.click(null);
    expect(note.state.messages).toEqual([
      { type: 'dooknow-to-doo-open-reminder', eventId: null, url: notificationsPath },
    ]);
    expect(note.state.navigations).toEqual([]);
  });

  it('removes unrelated sensitive query fields and stale reminder IDs from valid workspace URLs', async () => {
    const sw = worker();
    await sw.click({
      eventId: 'event-1',
      url: `${notificationsPath}&task=task-1&note=private-note&token=secret&reminder=stale#private-fragment`,
    });
    expect(sw.opened).toEqual([`${origin}${notificationsPath}&task=task-1&reminder=event-1`]);
  });
});
