import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';
import { fillToDooDate } from '../support/to-doo-ant-controls';

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

test('saving a review retains the applied interval when the following refresh fails', async ({
  page,
}, info) => {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const headers = {
    origin: `http://127.0.0.1:${process.env.DOOKNOW_E2E_WEB_PORT || 4179}`,
    'x-csrf-token': csrf.token,
  };
  const created = await page.request.post('/api/to-doo/commands', {
    headers,
    data: {
      requestId: crypto.randomUUID(),
      action: 'create_task',
      payload: { title: '本期之外的完成' },
    },
  });
  expect(created.ok()).toBe(true);
  const initial = await created.json(),
    occurrence = initial.snapshot.occurrences.find((row: any) => row.taskId === initial.ids[0]);
  const completed = await page.request.post('/api/to-doo/commands', {
    headers,
    data: {
      requestId: crypto.randomUUID(),
      action: 'set_occurrence_status',
      payload: { id: occurrence.id, expectedRevision: occurrence.revision, status: 'done' },
    },
  });
  expect(completed.ok()).toBe(true);
  const globalCompleted = (await completed.json()).snapshot.statistics.completed;
  const today = new Intl.DateTimeFormat('sv-SE', {
    timeZone: initial.snapshot.settings.timeZone,
  }).format(new Date());
  const shift = (days: number) =>
    new Date(Date.parse(today + 'T12:00:00Z') + days * 86400000).toISOString().slice(0, 10);
  const from = shift(-30),
    to = shift(-20);
  const reference = await page.request.get(
    '/api/to-doo/state?view=stats&from=' + from + '&to=' + to,
  );
  expect(reference.ok()).toBe(true);
  const expectedCompleted = (await reference.json()).statistics.completed;
  // Other browser cases may have completed records in this interval. The new
  // completion is outside it, so replacing the applied period with global totals
  // must still be detectable even when the interval's real count is nonzero.
  expect(expectedCompleted).toBeLessThan(globalCompleted);
  await page.goto('/?view=apps&app=to-doo&appSection=stats');
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
  await app.getByText('自定义', { exact: true }).click();
  await fillToDooDate(app.getByRole('textbox', { name: '统计开始日期', exact: true }), from);
  await fillToDooDate(app.getByRole('textbox', { name: '统计结束日期', exact: true }), to);
  await app.getByRole('button', { name: '查看区间', exact: true }).click();
  const metric = app
    .getByRole('group', { name: '区间统计' })
    .locator('.ant-statistic')
    .filter({ hasText: '完成行动' })
    .locator('.ant-statistic-content-value');
  await expect(metric).toHaveText(String(expectedCompleted));
  await app.getByRole('button', { name: '＋ 写一篇复盘', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '新建复盘', exact: true });
  const name = '区间保持 ' + info.project.name;
  await editor.getByLabel('名称', { exact: true }).fill(name);
  await editor.getByLabel('复盘内容', { exact: true }).fill('保存后的统计仍应属于刚刚选择的区间。');
  let failed = false;
  await page.route('**/api/to-doo/state?*', (route) => {
    if (!failed && new URL(route.request().url()).searchParams.get('view') === 'stats') {
      failed = true;
      return route.fulfill({ status: 503, json: { error: '统计刷新暂不可用，请重试' } });
    }
    return route.continue();
  });
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(editor).not.toBeVisible();
  await expect(app.getByRole('alert')).toContainText('统计刷新暂不可用');
  await expect(metric).toHaveText(String(expectedCompleted));
  await expect(app.locator('.todo-completion-chart')).toHaveAttribute(
    'aria-label',
    new RegExp(from + ' — ' + to),
  );
  await app.getByRole('button', { name: '刷新 To Doo', exact: true }).click();
  await expect(app.getByRole('alert')).not.toBeVisible();
  await expect(metric).toHaveText(String(expectedCompleted));
  await expect(app.getByRole('button').filter({ hasText: name })).toBeVisible();
});
