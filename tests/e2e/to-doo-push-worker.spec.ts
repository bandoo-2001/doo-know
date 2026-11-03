import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';

// Persistent notifications require the full browser's platform services.
test.use({ channel: 'chromium' });

// Exercises native Chromium/ServiceWorker APIs. CDP injects the push transport;
// this does not assert external-provider delivery or a visible OS notification.
test('the real notification worker receives push, wakes after restart and preserves the task draft', async ({
  page,
  context,
}) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const config = JSON.parse(await readFile('.local/e2e-config.json', 'utf8'));
  await context.grantPermissions(['notifications'], { origin: config.origin });
  const session = await context.newCDPSession(page);
  let registrationId = '',
    versionId = '';
  const stopped = new Set<string>();
  session.on('ServiceWorker.workerRegistrationUpdated', (event) => {
    const registration = event.registrations.find(
      (row) => row.scopeURL === config.origin + '/' && !row.isDeleted,
    );
    if (registration) registrationId = registration.registrationId;
  });
  session.on('ServiceWorker.workerVersionUpdated', (event) => {
    for (const row of event.versions) {
      if (row.registrationId === registrationId && row.status === 'activated')
        versionId = row.versionId;
      if (row.runningStatus === 'stopped') stopped.add(row.versionId);
    }
  });
  await session.send('ServiceWorker.enable');
  await page.goto('/?view=apps&app=to-doo&appSection=tasks');
  const draft = page.getByRole('textbox', { name: '快速添加任务', exact: true });
  await draft.fill('通知到达时保留这份草稿');
  await page.evaluate(async () => {
    (window as any).__pushUpdateReceived = false;
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'dooknow-to-doo-reminder-update')
        (window as any).__pushUpdateReceived = true;
    });
    await navigator.serviceWorker.register('/to-doo-sw.js');
    await navigator.serviceWorker.ready;
  });
  await expect.poll(() => registrationId).not.toBe('');
  await expect.poll(() => versionId).not.toBe('');
  async function notifications() {
    return page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      return (await registration.getNotifications({ tag: 'isolated-worker-verification' })).map(
        (item) => ({ title: item.title, body: item.body, tag: item.tag, data: item.data }),
      );
    });
  }
  async function deliver(generation: number) {
    await session.send('ServiceWorker.deliverPushMessage', {
      origin: config.origin,
      registrationId,
      data: JSON.stringify({
        title: '隔离浏览器提醒',
        body: '传递代次 ' + generation,
        tag: 'isolated-worker-verification',
        eventId: 'fixture-push-record',
        generation,
        url: '/?view=apps&app=to-doo&appSection=notifications',
      }),
    });
  }
  try {
    await deliver(0);
    await expect.poll(notifications).toEqual([
      expect.objectContaining({
        title: '隔离浏览器提醒',
        body: '传递代次 0',
        data: expect.objectContaining({ eventId: 'fixture-push-record', generation: 0 }),
      }),
    ]);
    await expect.poll(() => page.evaluate(() => (window as any).__pushUpdateReceived)).toBe(true);
    await expect(draft).toHaveValue('通知到达时保留这份草稿');
    const previousVersion = versionId;
    stopped.delete(previousVersion);
    await session.send('ServiceWorker.stopWorker', { versionId: previousVersion });
    await expect.poll(() => stopped.has(previousVersion)).toBe(true);
    await deliver(1);
    await expect.poll(notifications).toEqual([
      expect.objectContaining({
        body: '传递代次 1',
        data: expect.objectContaining({ generation: 1 }),
      }),
    ]);
    await expect(draft).toHaveValue('通知到达时保留这份草稿');
  } finally {
    await page
      .evaluate(async () => {
        const registration = await navigator.serviceWorker.getRegistration('/to-doo-sw.js');
        if (registration) {
          for (const notification of await registration.getNotifications()) notification.close();
          await registration.unregister();
        }
      })
      .catch(() => {});
    await session.detach();
  }
});
