import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import type { ToDooCommandResult, ToDooSettings } from '../../shared/to-doo-contracts';
import { test, expect } from '../support/browser-test';
import {
  expandToDooGroup,
  expectToDooSelection,
  fillToDooDate,
  selectToDooOption,
} from '../support/to-doo-ant-controls';
import {
  completeToDooDetailProperty,
  openToDooDetailProperty,
} from '../support/to-doo-detail-controls';
import { readToDooTaskContext } from '../support/to-doo-task-fixture';

test.use({ timezoneId: 'Asia/Tokyo' });

async function readSettings(page: Page): Promise<ToDooSettings> {
  const response = await page.request.get('/api/to-doo/settings');
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

test('fixed-zone and fixed-time deadlines respond differently to a display zone change', async ({
  page,
  context,
}, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  async function command(
    action: string,
    payload: Record<string, unknown>,
  ): Promise<ToDooCommandResult> {
    const csrf = await (await page.request.get('/api/security/csrf')).json();
    const response = await page.request.post('/api/to-doo/commands', {
      headers: { origin: String(info.project.use.baseURL), 'x-csrf-token': csrf.token },
      data: { requestId: crypto.randomUUID(), action, payload },
    });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  }
  async function setDisplayZone(timeZone: string, quietHours?: ToDooSettings['quietHours']) {
    const settings = await readSettings(page);
    if (
      settings.timeZone === timeZone &&
      (quietHours === undefined ||
        JSON.stringify(settings.quietHours) === JSON.stringify(quietHours))
    )
      return;
    await command('save_entity', {
      kind: 'settings',
      entity: {
        ...settings,
        timeZone,
        quietHours: quietHours === undefined ? settings.quietHours : quietHours,
      },
      expectedRevision: settings.revision,
    });
  }

  const original = await readSettings(page);
  await setDisplayZone('UTC');
  try {
    const suffix = crypto.randomUUID().slice(0, 8);
    const {
      ids: [listId],
    } = await command('save_entity', {
      kind: 'list',
      entity: { name: '任务时区 ' + suffix, kind: 'list' },
    });
    const tasksPage = '/?view=apps&app=to-doo&appSection=tasks&list=' + listId;
    const date = new Date().getUTCFullYear() + 1 + '-04-19';
    const time = '09:30';
    const detail = page.getByRole('complementary', { name: '任务详情', exact: true });
    const save = detail.getByRole('button', { name: '保存任务', exact: true });
    const closeDetail = detail.getByRole('button', { name: '关闭任务详情', exact: true });
    const taskButton = (title: string) => page.getByRole('button', { name: title, exact: true });
    const deadline = (title: string) =>
      page
        .locator('.todo-task-row')
        .filter({ has: taskButton(title) })
        .locator('.todo-task-deadline');
    const expectDeadline = async (title: string, clock: string) => {
      await expect(deadline(title)).toHaveAttribute('aria-label', `截止 ${date} ${clock}`);
      await expect(deadline(title).getByText(clock, { exact: true })).toBeVisible();
    };
    const modeLabel = '截止时间方式';
    const zoneLabel = '截止时区';
    const shanghai = 'Asia/Shanghai';
    const tokyo = 'Asia/Tokyo';
    const create = async (title: string, mode: '固定时区' | '固定时间') => {
      await page.getByRole('button', { name: '新建任务', exact: true }).click();
      await detail.getByRole('textbox', { name: '任务标题', exact: true }).fill(title);
      await expandToDooGroup(detail, '更多选项');
      await fillToDooDate(detail.getByLabel('截止日期', { exact: true }), date);
      await expect(detail.getByRole('combobox', { name: modeLabel, exact: true })).toBeHidden();
      await fillToDooDate(detail.getByLabel('截止时间', { exact: true }), time);
      await selectToDooOption(detail, modeLabel, mode);
      const zone = detail.getByLabel(zoneLabel, { exact: true });
      if (mode === '固定时区') await zone.fill(shanghai);
      else await expect(zone).toBeHidden();
      const created = page.waitForResponse(
        (response) =>
          response.url().endsWith('/api/to-doo/commands') &&
          response.request().postDataJSON()?.action === 'create_task',
      );
      await detail.getByRole('button', { name: '创建任务', exact: true }).click();
      const response = await created;
      expect(response.ok(), await response.text()).toBe(true);
      await expect(taskButton(title)).toBeVisible();
      if (await detail.isVisible()) await closeDetail.click();
      return ((await response.json()) as ToDooCommandResult).ids[0];
    };
    const fixedTitle = '固定时区 ' + suffix;
    const floatingTitle = '固定时间 ' + suffix;
    const legacyTitle = '已有截止时间 ' + suffix;
    const legacyDue = { date, time, timeZone: shanghai };
    const {
      ids: [legacyId],
    } = await command('create_task', {
      listId,
      title: legacyTitle,
      due: legacyDue,
    });
    await page.goto(tasksPage);
    const fixedId = await create(fixedTitle, '固定时区');
    const floatingId = await create(floatingTitle, '固定时间');
    const taskIds = [fixedId, floatingId, legacyId];
    const readDeadlines = async () => {
      const { occurrences } = await readToDooTaskContext(page, taskIds);
      return taskIds.map((id) => occurrences.find((item) => item.taskId === id)?.due);
    };
    const before = await readDeadlines();
    expect(before).toMatchObject([
      { date, time, timeZone: shanghai },
      { date, time, timeMode: 'floating' },
      legacyDue,
    ]);
    expect(before[0]?.timeMode ?? 'fixed').toBe('fixed');
    expect(before[2]?.timeMode).toBeUndefined();
    await expectDeadline(fixedTitle, '01:30');
    await expectDeadline(floatingTitle, '09:30');
    await expectDeadline(legacyTitle, '01:30');

    await page.goto('/?view=apps&app=to-doo&appSection=settings');
    const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
    await expandToDooGroup(app, '日期与提醒');
    const displayZone = app.getByLabel('显示时区', { exact: true });
    await expect(displayZone).toHaveValue('UTC');
    await app.getByRole('button', { name: '使用此设备时区', exact: true }).click();
    await expect(displayZone).toHaveValue(tokyo);
    await app.getByRole('button', { name: '保存偏好', exact: true }).click();
    await expect.poll(async () => (await readSettings(page)).timeZone).toBe(tokyo);

    await page.goto(tasksPage);
    await expectDeadline(fixedTitle, '10:30');
    await expectDeadline(floatingTitle, '09:30');
    await expectDeadline(legacyTitle, '10:30');
    expect(await readDeadlines()).toEqual(before);

    await taskButton(fixedTitle).click();
    let editor = await openToDooDetailProperty(page, 'due');
    await expectToDooSelection(editor, modeLabel, '固定时区');
    await expect(editor.getByLabel(zoneLabel, { exact: true })).toHaveValue(shanghai);
    await expect(editor.getByLabel('截止时间', { exact: true })).toHaveValue(time);
    await completeToDooDetailProperty(page);
    await expect(save).toBeDisabled();
    await closeDetail.click();

    await taskButton(floatingTitle).click();
    editor = await openToDooDetailProperty(page, 'due');
    await expectToDooSelection(editor, modeLabel, '固定时间');
    await expect(editor.getByLabel('截止时间', { exact: true })).toHaveValue(time);
    await selectToDooOption(editor, modeLabel, '固定时区');
    await editor.getByLabel(zoneLabel, { exact: true }).fill('UTC');
    await completeToDooDetailProperty(page);
    await save.click();
    await expect(save).toBeDisabled();
    await closeDetail.click();
    await expectDeadline(floatingTitle, '18:30');
    const converted = (await readDeadlines())[1];
    expect(converted).toMatchObject({ date, time, timeZone: 'UTC' });
    expect(converted?.timeMode ?? 'fixed').toBe('fixed');

    await taskButton(floatingTitle).click();
    editor = await openToDooDetailProperty(page, 'due');
    await expectToDooSelection(editor, modeLabel, '固定时区');
    await expect(editor.getByLabel(zoneLabel, { exact: true })).toHaveValue('UTC');
    await expect(editor.getByLabel('截止时间', { exact: true })).toHaveValue(time);
  } finally {
    await setDisplayZone(original.timeZone, original.quietHours);
  }
});
