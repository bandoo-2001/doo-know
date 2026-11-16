import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';

test('owner pairs a watch, sees its task completion and can revoke access', async ({
  page,
  context,
  playwright,
  baseURL,
}) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const watch = await playwright.request.newContext({ baseURL });
  try {
    const csrf = await (await page.request.get('/api/security/csrf')).json();
    const headers = { origin: baseURL!, 'x-csrf-token': csrf.token };
    async function create(action: string, payload: object) {
      const result = await page.request.post('/api/to-doo/commands', {
        headers,
        data: { requestId: crypto.randomUUID(), action, payload },
      });
      expect(result.ok()).toBe(true);
      return (await result.json()).ids[0] as string;
    }
    const listId = await create('save_entity', { kind: 'list', entity: { name: '手表测试清单' } });
    const taskId = await create('create_task', { listId, title: '在手表上完成' });
    const base = '/api/to-doo/watch/v1';
    const pairing = await watch.post(base + '/pair/start', { data: {} });
    expect(pairing.ok()).toBe(true);
    const { userCode, deviceCode } = await pairing.json();

    await page.goto('/?view=apps&app=to-doo&appSection=settings');
    await page.getByRole('tab', { name: '提醒与连接' }).click();
    const panel = page.getByRole('region', { name: '手表配对', exact: true });
    await panel.getByLabel('手表配对码').fill(userCode);
    await panel.getByRole('button', { name: '授权手表' }).click();
    await expect(panel.getByRole('status')).toContainText('已授权');
    const claim = await watch.post(base + '/pair/claim', { data: { deviceCode } });
    const { status, token } = await claim.json();
    expect(status).toBe('paired');
    const deviceHeaders = { authorization: 'Bearer ' + token };
    const snapshot = await watch.get(base + '/state', {
      params: { listId },
      headers: deviceHeaders,
    });
    expect(snapshot.ok()).toBe(true);
    const { tasks } = await snapshot.json();
    expect(tasks).toHaveLength(1);
    const command = await watch.post(base + '/command', {
      headers: deviceHeaders,
      data: {
        requestId: crypto.randomUUID(),
        action: 'set_occurrence_status',
        payload: { id: tasks[0].id, expectedRevision: tasks[0].revision, status: 'done' },
      },
    });
    expect(command.ok()).toBe(true);
    const webState = await (
      await page.request.get('/api/to-doo/state', { params: { taskIds: taskId } })
    ).json();
    expect(webState.occurrences[0].status).toBe('done');

    await panel.getByRole('button', { name: '解除配对' }).click();
    await page
      .getByRole('dialog', { name: '解除手表配对' })
      .getByRole('button', { name: '确认' })
      .click();
    await expect(panel.getByRole('status')).toContainText('已解除');
    expect((await watch.get(base + '/state', { headers: deviceHeaders })).status()).toBe(401);
  } finally {
    await watch.dispose();
  }
});
