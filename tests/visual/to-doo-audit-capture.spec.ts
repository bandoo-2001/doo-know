import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { test, expect } from '../support/browser-test';
import {
  authenticateVisualContext,
  seedToDooVisual,
  VISUAL_NOW,
  VISUAL_ORIGIN,
} from '../support/to-doo-visual-fixture';
import { expandToDooGroup } from '../support/to-doo-ant-controls';
import { openToDooFocusHistory } from '../support/to-doo-navigation';

const phase = process.env.DOOKNOW_AUDIT_PHASE || 'after';
if (!['before', 'after'].includes(phase)) throw Error('Expected audit phase before or after');
const output = resolve('docs/design/to-doo/audit-fixes-2026-11-03', phase);
const scenes = [
  ['overview', 'overview'],
  ['tasks', 'tasks'],
  ['board', 'board'],
  ['matrix', 'matrix'],
  ['calendar-month', 'calendar'],
  ['calendar-week', 'calendar'],
  ['timeline', 'timeline'],
  ['focus', 'focus'],
  ['habits', 'habits'],
  ['anniversaries', 'anniversaries'],
  ['stats', 'stats'],
  ['notifications', 'notifications'],
  ['settings', 'settings'],
  ['settings-connections', 'settings'],
  ['settings-data', 'settings'],
  ['task-detail', 'tasks'],
  ['task-dialog', 'tasks'],
  ['habit-dialog', 'habits'],
  ['schedule-dialog', 'calendar'],
  ['anniversary-dialog', 'anniversaries'],
  ['review-dialog', 'stats'],
  ['outcome-dialog', 'tasks'],
] as const;
let seed: Awaited<ReturnType<typeof seedToDooVisual>>;
test.beforeAll(async ({ browser }) => {
  await mkdir(output, { recursive: true });
  const context = await browser.newContext({ baseURL: VISUAL_ORIGIN });
  try {
    await authenticateVisualContext(context);
    seed = await seedToDooVisual(await context.newPage());
  } finally {
    await context.close();
  }
});
test.beforeEach(async ({ context, page }) => {
  test.setTimeout(45000);
  await authenticateVisualContext(context);
  await page.clock.install({ time: new Date(VISUAL_NOW) });
});
const devices = [
  { id: 'desktop', width: 1440, height: 1000, theme: 'light' },
  { id: 'phone', width: 390, height: 844, theme: 'dark' },
] as const;
for (const device of devices) {
  for (const [id, section] of scenes)
    test(`audit ${phase} ${device.id} ${id}`, async ({ page }) => {
      const captures: Record<string, unknown>[] = [];
      await page.setViewportSize({ width: device.width, height: device.height });
      const params = new URLSearchParams({
        view: 'apps',
        app: 'to-doo',
        appSection: section,
        taskFilter: 'all',
        date: '2026-10-30',
      });
      if (id === 'calendar-week') params.set('calendarView', 'week');
      if (id === 'calendar-month' || id === 'schedule-dialog') params.set('calendarView', 'month');
      if (id === 'task-detail' || id === 'outcome-dialog') {
        params.set('task', seed.taskId);
        params.set('occurrence', seed.occurrenceId);
      }
      await page.goto('/?' + params);
      const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
      await expect(app).toBeVisible();
      await expect(app.locator('.todo-main')).toHaveAttribute('aria-busy', 'false');
      await page.evaluate(async (theme) => {
        const modulePath = '/preferences.ts';
        const preferences = await import(modulePath);
        preferences.setEditorPreferences({ theme });
        await document.fonts.ready;
      }, device.theme);
      if (id === 'focus') await openToDooFocusHistory(page);
      if (id === 'settings') await expandToDooGroup(app, '日期与提醒');
      if (id === 'settings-connections')
        await app.getByRole('tab', { name: '提醒与连接', exact: true }).click();
      if (id === 'settings-data')
        await app.getByRole('tab', { name: '数据与恢复', exact: true }).click();
      const actions: Record<string, string> = {
        'task-dialog': '新建任务',
        'habit-dialog': '＋ 新建习惯',
        'schedule-dialog': '＋ 时间安排',
        'anniversary-dialog': '＋ 新建纪念日',
        'review-dialog': '＋ 写一篇复盘',
      };
      if (actions[id]) await app.getByRole('button', { name: actions[id], exact: true }).click();
      if (id === 'outcome-dialog') {
        const detail = app.getByRole('complementary', { name: '任务详情', exact: true });
        await expect(detail).toBeVisible();
        await expandToDooGroup(detail, '完成标准与成果');
        await detail.getByRole('button', { name: '创建成果笔记并关联', exact: true }).click();
      }
      if (id.endsWith('-dialog') && id !== 'task-dialog')
        await expect(page.getByRole('dialog').last()).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      expect(overflow, id + ' outer page overflow').toBeLessThanOrEqual(1);
      await page.mouse.move(1, 1);
      const file = `${device.id}-${id}.png`;
      await page.screenshot({
        path: resolve(output, file),
        animations: 'disabled',
        fullPage: false,
      });
      captures.push({
        id,
        file,
        overflow,
        device: device.id,
        width: device.width,
        height: device.height,
        theme: device.theme,
      });
      await writeFile(
        resolve(output, `${device.id}-${id}.json`),
        JSON.stringify(
          {
            fixedTime: VISUAL_NOW,
            head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
            captures,
          },
          null,
          2,
        ) + '\n',
      );
    });
}
