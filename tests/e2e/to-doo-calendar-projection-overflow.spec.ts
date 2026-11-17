import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';
import type { ToDooCommandResult, ToDooSnapshot } from '../../shared/to-doo-contracts';

test('a calendar-created task remains visible and clickable beyond 520 long-ID executions', async ({ page, context }, info) => {
  test.setTimeout(180_000);
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.setViewportSize(info.project.name === 'mobile'
    ? { width: 390, height: 844 } : { width: 1920, height: 1080 });
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const headers = { origin: String(info.project.use.baseURL), 'x-csrf-token': csrf.token };
  async function command(action: string, payload: Record<string, unknown>) {
    const response = await page.request.post('/api/to-doo/commands', {
      headers, data: { requestId: crypto.randomUUID(), action, payload }, timeout: 90_000,
    });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json() as Promise<ToDooCommandResult>;
  }
  const prefix = 'calendar-projection-' + crypto.randomUUID().slice(0, 8);
  const seed = await command('create_task', { title: prefix + ' seed' });
  const seedState = await (await page.request.get('/api/to-doo/state?taskIds=' + seed.ids[0])).json() as ToDooSnapshot;
  const task = seedState.tasks.find(row => row.id === seed.ids[0])!;
  const occurrence = seedState.occurrences.find(row => row.taskId === task.id)!;
  const id = (kind: string, index: number) => (prefix + '-' + kind + '-' + index + '-').padEnd(128, 'x');
  await command('import_entities', { entities: Array.from({ length: 519 }, (_, i) => [
    { kind: 'task', entity: { ...task, id: id('task', i), title: prefix + ' background ' + i } },
    { kind: 'occurrence', entity: { ...occurrence, id: id('occ', i), taskId: id('task', i) } },
  ]).flat() });
  const metadataReads: string[] = [];
  const metadataStatuses: number[] = [];
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.pathname === '/api/to-doo/state' && url.searchParams.has('ids')) {
      metadataReads.push(response.url());
      metadataStatuses.push(response.status());
    }
  });
  const date = '2030-05-17', title = '日历投影可见 ' + prefix;
  await page.goto('/?view=apps&app=to-doo&appSection=calendar&calendarView=month&date=' + date);
  await expect(page.locator('.todo-main')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  const detail = page.getByRole('complementary', { name: '任务详情', exact: true });
  await expect(detail.getByLabel('计划日期', { exact: true })).toHaveValue(date);
  await detail.getByLabel('任务标题', { exact: true }).fill(title);
  const created = page.waitForResponse(response => response.request().method() === 'POST' &&
    new URL(response.url()).pathname === '/api/to-doo/commands' &&
    response.request().postDataJSON().action === 'create_task' &&
    response.request().postDataJSON().payload.title === title);
  await detail.getByRole('button', { name: '创建任务', exact: true }).click();
  const createdResponse = await created;
  expect(createdResponse.ok(), await createdResponse.text()).toBe(true);
  const receipt = await createdResponse.json() as ToDooCommandResult;
  const taskId = receipt.changed.find(row => row.kind === 'task')!.id;
  await expect(detail.getByRole('button', { name: '保存任务', exact: true })).toBeDisabled();
  await detail.getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await expect(detail).toBeHidden();
  await page.reload();
  await expect(page.locator('.todo-main')).toHaveAttribute('aria-busy', 'false');
  const day = info.project.name === 'mobile'
    ? page.locator('.todo-agenda-day[data-date="' + date + '"]')
    : page.getByRole('group', { name: date + ' 日程', exact: true });
  const card = day.getByRole('button', { name: new RegExp(title) }).first();
  await expect(card).toBeVisible();
  await card.click();
  await expect(detail.getByLabel('任务标题', { exact: true })).toHaveValue(title);
  await expect(detail.getByRole('button', { name: '编辑计划日期', exact: true })).toBeEnabled();
  expect(metadataReads.length).toBeGreaterThan(2);
  expect(metadataStatuses.every(status => status === 200)).toBe(true);
  for (const url of metadataReads) {
    const parsed = new URL(url);
    expect(parsed.href.length).toBeLessThanOrEqual(8192);
    expect(parsed.searchParams.get('ids')!.length).toBeLessThanOrEqual(8192);
  }
  const stored = await (await page.request.get('/api/to-doo/state?taskIds=' + taskId)).json() as ToDooSnapshot;
  const saved = stored.occurrences.find(row => row.taskId === taskId)!;
  expect(stored.tasks.find(row => row.id === taskId)?.title).toBe(title);
  expect(stored.timeBlocks.some(row => row.occurrenceId === saved.id && row.start.date === date)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: info.outputPath('calendar-projection-after-overflow.png'), animations: 'disabled' });
});
