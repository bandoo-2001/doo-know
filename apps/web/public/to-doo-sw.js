/* Push only: this worker never caches notes, authenticated pages, or API responses. */
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

const notificationsPath = '/?view=apps&app=to-doo&appSection=notifications';
const entityId = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null;
const record = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};

function reminderPath(value) {
  if (typeof value !== 'string') return notificationsPath;
  try {
    const target = new URL(value, self.location.origin);
    if (
      target.origin !== self.location.origin ||
      target.username ||
      target.password ||
      target.pathname !== '/' ||
      target.searchParams.getAll('view').length !== 1 ||
      target.searchParams.get('view') !== 'apps' ||
      target.searchParams.getAll('app').length !== 1 ||
      target.searchParams.get('app') !== 'to-doo'
    )
      return notificationsPath;
    const safe = new URL(notificationsPath, self.location.origin);
    for (const key of ['appSection', 'task', 'list', 'date', 'calendarView', 'taskFilter']) {
      const value = entityId(target.searchParams.get(key));
      if (value) safe.searchParams.set(key, value);
    }
    return safe.pathname + safe.search;
  } catch {
    return notificationsPath;
  }
}

function isWorkspaceClient(client) {
  try {
    const target = new URL(client.url);
    return target.origin === self.location.origin && target.pathname === '/';
  } catch {
    return false;
  }
}

async function updateWorkspaces() {
  try {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      if (!isWorkspaceClient(client)) continue;
      try {
        client.postMessage({ type: 'dooknow-to-doo-reminder-update' });
      } catch {}
    }
  } catch {}
}

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = record(event.data ? event.data.json() : {});
  } catch {
    payload = {};
  }
  const title =
    typeof payload.title === 'string' ? payload.title.slice(0, 256) : 'To Doo 有一项提醒';
  const body = typeof payload.body === 'string' ? payload.body.slice(0, 2000) : '打开 To Doo 查看';
  const tag = typeof payload.tag === 'string' && payload.tag ? payload.tag.slice(0, 200) : 'to-doo';
  const eventId = entityId(payload.eventId);
  const url = eventId ? reminderPath(payload.url) : notificationsPath;
  const generation =
    Number.isSafeInteger(payload.generation) && payload.generation >= 0 ? payload.generation : null;
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(title, {
        body,
        tag,
        data: { url, eventId, generation },
        renotify: generation !== null && generation > 0,
      }),
      updateWorkspaces(),
    ]),
  );
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = record(event.notification.data);
  const eventId = entityId(data.eventId);
  const url = eventId ? reminderPath(data.url) : notificationsPath;
  event.waitUntil(
    (async () => {
      const clients = await self.clients
        .matchAll({ type: 'window', includeUncontrolled: true })
        .catch(() => []);
      for (const client of clients) {
        if (!isWorkspaceClient(client)) continue;
        try {
          // Let the workspace protect unsaved edits before changing its internal route.
          client.postMessage({ type: 'dooknow-to-doo-open-reminder', eventId, url });
          await client.focus();
          return;
        } catch {}
      }
      const target = new URL(url, self.location.origin);
      if (eventId) target.searchParams.set('reminder', eventId);
      return self.clients.openWindow(target.href);
    })(),
  );
});
