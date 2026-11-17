import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { test, expect } from '../support/browser-test';

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});
async function fixture(page: Page) {
  const snapshot = await (await page.request.get('/api/to-doo/state?limit=1')).json();
  const zone = snapshot.settings.timeZone;
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: zone }).format(new Date(snapshot.now));
  const tomorrow = new Date(Date.parse(today + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
  const year = Number(today.slice(0, 4));
  const suffix = crypto.randomUUID().slice(0, 7);
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const command = async (action: string, payload: any) => {
    const response = await page.request.post('/api/to-doo/commands', {
      headers: { origin: String(test.info().project.use.baseURL), 'x-csrf-token': csrf.token },
      data: { requestId: crypto.randomUUID(), action, payload },
    });
    expect(response.ok(), await response.text()).toBe(true);
    return (await response.json()).ids[0] as string;
  };
  const list = await command('save_entity', { kind: 'list', entity: { name: '紧凑日期 ' + suffix } });
  const names = { same: '同日范围 ' + suffix, cross: '跨日范围 ' + suffix, single: '单侧日期 ' + suffix,
    equal: '相同时间 ' + suffix, long: '跨年日期 ' + suffix };
  const point = (date: string, time: string | null) => ({ date, time, timeZone: zone });
  await command('create_task', { listId: list, title: names.same, plan: point(today, '10:00'), due: point(today, '17:30') });
  await command('create_task', { listId: list, title: names.cross, plan: point(today, '10:00'), due: point(tomorrow, '17:30') });
  await command('create_task', { listId: list, title: names.single, due: point(today, '17:30') });
  await command('create_task', { listId: list, title: names.equal, plan: point(today, '10:00'), due: point(today, '10:00') });
  await command('create_task', { listId: list, title: names.long, plan: point((year + 1) + '-12-30', '10:00'), due: point((year + 2) + '-01-02', '17:30') });
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&list=' + list);
  await expect(page.getByRole('button', { name: names.same, exact: true })).toBeVisible();
  return { names, today, tomorrow };
}
test('task dates use a compact dash range while keeping the endpoint meaning', async ({ page }, info) => {
  if (info.project.name === 'desktop') await page.setViewportSize({ width: 1920, height: 1080 });
  const { names, today, tomorrow } = await fixture(page);
  const row = (name: string) => page.locator('.todo-task-row').filter({ has: page.getByRole('button', { name, exact: true }) });
  const text = async (name: string) => ((await row(name).locator('.todo-task-dates').textContent()) || '').replace(/\s/g, '');
  expect(await text(names.same)).toBe('今天10:00–17:30');
  expect(await text(names.cross)).toBe('计划今天10:00截止明天17:30');
  expect(await text(names.single)).toBe('截止今天17:30');
  await expect(row(names.equal).locator('.todo-task-date')).toHaveCount(1);
  await expect(row(names.equal).locator('.todo-task-date-separator')).toHaveCount(0);
  await expect(row(names.same).locator('.todo-task-dates')).toHaveAttribute('aria-label', `计划 ${today} 10:00；截止 ${today} 17:30`);
  await expect(row(names.cross).locator('.todo-task-deadline')).toHaveAttribute('aria-label', `截止 ${tomorrow} 17:30`);
  const sameSeparator = row(names.same).locator('.todo-task-date-separator');
  const line = (await sameSeparator.boundingBox())!;
  const time = (await row(names.same).locator('.todo-task-deadline .todo-task-date-value').boundingBox())!;
  expect(line.width).toBeLessThanOrEqual(8);
  expect(line.height).toBeLessThanOrEqual(1.5);
  expect(Math.abs(line.y + line.height / 2 - time.y - time.height / 2)).toBeLessThanOrEqual(1);
  const long = row(names.long);
  await expect(long.locator('.todo-task-date-separator')).toHaveCount(0);
  const overflow = await long.evaluate(element => element.scrollWidth - element.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('compact-task-date-range.png'), animations: 'disabled' });
});
