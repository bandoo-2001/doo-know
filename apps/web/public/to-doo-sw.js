/* Push only: this worker never caches notes, authenticated pages, or API responses. */
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  const title =
    typeof payload.title === 'string' ? payload.title.slice(0, 256) : 'To Doo 有一项提醒';
  const body = typeof payload.body === 'string' ? payload.body.slice(0, 2000) : '打开 To Doo 查看';
  const tag = typeof payload.tag === 'string' ? payload.tag.slice(0, 200) : 'to-doo';
  let url = '/?view=apps&app=to-doo&appSection=notifications';
  try {
    const target = new URL(payload.url, self.location.origin);
    if (
      target.origin === self.location.origin &&
      target.pathname === '/' &&
      target.searchParams.get('view') === 'apps' &&
      target.searchParams.get('app') === 'to-doo'
    )
      url = target.pathname + target.search;
  } catch {}
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      data: { url, eventId: typeof payload.eventId === 'string' ? payload.eventId : null },
      renotify: false,
    }),
  );
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path =
    (event.notification.data && event.notification.data.url) ||
    '/?view=apps&app=to-doo&appSection=notifications';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clients) => {
      const target = new URL(path, self.location.origin);
      if (target.origin !== self.location.origin) return;
      for (const client of clients)
        if (new URL(client.url).origin === self.location.origin) {
          await client.navigate(target.href);
          return client.focus();
        }
      return self.clients.openWindow(target.href);
    }),
  );
});
