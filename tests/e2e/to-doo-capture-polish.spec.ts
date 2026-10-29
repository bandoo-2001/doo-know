import { fillToDooDate } from '../support/to-doo-ant-controls';
import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';

test('quick capture schedules explicitly after recognizing a date and retains the chosen plan', async ({
  page,
  context,
}) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.goto('/?view=apps&app=to-doo&appSection=tasks');
  const form = page.getByRole('form', { name: '快速添加任务', exact: true });
  const input = form.getByRole('textbox', { name: '快速添加任务', exact: true });
  const title = '核对计划 ' + crypto.randomUUID();
  await input.fill('明天 ' + title);
  await expect(form.getByLabel('计划日期', { exact: true })).toBeVisible();
  await fillToDooDate(form.getByLabel('计划日期', { exact: true }), '2031-04-17');
  await expect(input).toHaveValue(title);
  await form.getByRole('button', { name: '添加任务', exact: true }).click();
  await expect(input).toHaveValue('');
  const query = new URLSearchParams({
    from: '2031-04-17',
    to: '2031-04-17',
    filter: JSON.stringify({ query: title }),
  });
  const state = await (await page.request.get('/api/to-doo/state?' + query)).json();
  const task = state.tasks.find((task: any) => task.title === title);
  expect(task).toBeTruthy();
  const occurrence = state.occurrences.find((entry: any) => entry.taskId === task.id);
  expect(
    state.timeBlocks.find((entry: any) => entry.occurrenceId === occurrence.id)?.start.date,
  ).toBe('2031-04-17');
});

test('Q focuses capture without stealing keys from text entry', async ({ page, context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.goto('/?view=apps&app=to-doo&appSection=tasks');
  const input = page.getByRole('textbox', { name: '快速添加任务', exact: true });
  await expect(input).toBeVisible();
  await input.blur();
  await page.keyboard.press('q');
  await expect(input).toBeFocused();
  const search = page.getByRole('textbox', { name: '搜索任务', exact: true });
  await search.fill('查找');
  await search.press('q');
  await expect(search).toHaveValue('查找q');
  await expect(search).toBeFocused();
  await expect(input).toHaveValue('');
});

test('clearing the contextual plan in Today survives a browser reload', async ({
  page,
  context,
}) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&taskFilter=today');
  const form = page.getByRole('form', { name: '快速添加任务', exact: true });
  const title = '明确稍后安排 ' + crypto.randomUUID();
  const input = form.getByRole('textbox', { name: '快速添加任务', exact: true });
  await input.fill(title);
  await fillToDooDate(form.getByLabel('计划日期', { exact: true }), '');
  await expect(form.getByLabel('计划日期', { exact: true })).toHaveValue('');
  await page.reload();
  await expect(input).toHaveValue(title);
  await expect(form.getByLabel('计划日期', { exact: true })).toHaveValue('');
  const submitted = page.waitForRequest(
    (request) => request.url().endsWith('/api/to-doo/commands') && request.method() === 'POST',
  );
  await form.getByRole('button', { name: '添加任务', exact: true }).click();
  expect((await submitted).postDataJSON().payload.plan).toBeNull();
  await expect(input).toHaveValue('');
});
