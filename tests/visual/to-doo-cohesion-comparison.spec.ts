import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../support/browser-test';
import {
  authenticateVisualContext,
  seedToDooVisual,
  VISUAL_NOW,
  VISUAL_ORIGIN,
} from '../support/to-doo-visual-fixture';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const phase = process.env.DOOKNOW_UI_COMPARE_PHASE || 'before';
if (!['before', 'after'].includes(phase)) throw Error('Expected before or after comparison phase');
const output = resolve(root, 'docs/design/to-doo/cohesion-2026-11-01', phase);
const cases = [
  { id: '01-overview', section: 'overview', label: '目标总览', ready: '.todo-goals' },
  {
    id: '02-calendar-month',
    section: 'calendar',
    label: '月日历',
    ready: '.todo-month:visible, .todo-mobile-agenda:visible',
    query: { calendarView: 'month', date: '2026-10-30' },
  },
  {
    id: '03-calendar-week',
    section: 'calendar',
    label: '周日历',
    ready: '.todo-week:visible, .todo-mobile-agenda:visible',
    query: { calendarView: 'week', date: '2026-10-30' },
  },
  {
    id: '04-timeline',
    section: 'timeline',
    label: '时间线',
    ready: '.todo-timeline',
    query: { date: '2026-10-30' },
  },
  { id: '05-matrix', section: 'matrix', label: '四象限', ready: '.todo-quadrants' },
  { id: '06-focus', section: 'focus', label: '专注', ready: '.todo-focus-workspace' },
  { id: '07-anniversaries', section: 'anniversaries', label: '纪念日', ready: '.todo-anniversary' },
  { id: '08-statistics', section: 'stats', label: '统计与复盘', ready: '.todo-review-statistics' },
  {
    id: '09-notifications',
    section: 'notifications',
    label: '通知中心',
    ready: '.todo-notification-tabs',
    tab: '全部',
  },
  { id: '10-settings', section: 'settings', label: '设置', ready: '.todo-settings' },
  {
    id: '11-recovery',
    section: 'settings',
    label: '数据与恢复',
    ready: '.todo-settings',
    tab: '数据与恢复',
  },
] as const;

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ baseURL: VISUAL_ORIGIN });
  try {
    await authenticateVisualContext(context);
    await seedToDooVisual(await context.newPage());
  } finally {
    await context.close();
  }
  await mkdir(output, { recursive: true });
});
test.beforeEach(async ({ context, page }) => {
  await authenticateVisualContext(context);
  await page.clock.install({ time: new Date(VISUAL_NOW) });
});

for (const device of [
  { id: 'desktop', width: 1440, height: 1000, theme: 'light' },
  { id: 'phone', width: 390, height: 844, theme: 'dark' },
] as const)
  for (const entry of cases)
    test(`capture ${phase} ${device.id} ${entry.id}`, async ({ page }) => {
      await page.setViewportSize({ width: device.width, height: device.height });
      const screenshots: Record<string, unknown>[] = [];
      const query = new URLSearchParams({
        view: 'apps',
        app: 'to-doo',
        appSection: entry.section,
        taskFilter: 'all',
        ...('query' in entry ? entry.query : {}),
      });
      await page.goto('/?' + query);
      const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
      await expect(app).toBeVisible();
      await expect(app.locator('.todo-main')).toHaveAttribute('aria-busy', 'false');
      await expect(app.locator(entry.ready).first()).toBeVisible();
      await page.evaluate(async (selected) => {
        const modulePath = '/preferences.ts';
        const preferences = await import(modulePath);
        preferences.setEditorPreferences({ theme: selected });
        await document.fonts.ready;
      }, device.theme);
      await expect(page.locator('html')).toHaveAttribute('data-theme', device.theme);
      if ('tab' in entry) await app.getByRole('tab', { name: entry.tab, exact: true }).click();
      if (entry.section === 'focus')
        await expect(app.locator('.todo-focus-history-item')).toHaveCount(3);
      if (entry.section === 'notifications')
        await expect(app.locator('.todo-notification')).toHaveCount(2);
      if (entry.id === '11-recovery')
        await expect(app.getByText('正在读取成果进度…', { exact: true })).not.toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      expect(overflow, entry.label + ': horizontal overflow').toBeLessThanOrEqual(1);
      await page.mouse.move(1, 1);
      await page.evaluate(
        () =>
          new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done())),
          ),
      );
      const file = device.id + '-' + entry.id + '.png';
      await page.screenshot({
        path: resolve(output, file),
        fullPage: false,
        animations: 'disabled',
        scale: 'css',
      });
      screenshots.push({ ...device, id: entry.id, label: entry.label, file, overflow });
      await writeFile(
        resolve(output, device.id + '-' + entry.id + '.json'),
        JSON.stringify({ phase, fixedTime: VISUAL_NOW, screenshots }, null, 2),
      );
    });
