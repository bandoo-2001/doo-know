import { readFile } from 'node:fs/promises';
import { toDooEntitySchemas } from '../../shared/to-doo-contracts';
import { test, expect } from '../support/browser-test';

const date = '2032-05-03';
const longTitle = '外部事件长标题'.repeat(30);
const longDescription = '需要完整保留的多行日程说明。\n'.repeat(120) + 'W'.repeat(5000);

test.beforeEach(async ({ context, page }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.clock.setFixedTime(new Date(date + 'T12:00:00Z'));
});

test('external event details keep long content scrollable, Close reachable, and times in the display zone', async ({
  page,
}, info) => {
  let writes = 0;
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      writes++;
      await route.abort();
      return;
    }
    if (!new URL(request.url()).pathname.startsWith('/api/to-doo/state')) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    const snapshot = await response.json();
    const event = (id: string, title: string, values: Record<string, unknown> = {}) =>
      toDooEntitySchemas.calendarEvent.parse({
        id,
        uid: id,
        title,
        revision: 'external-detail-regression',
        createdAt: date + 'T00:00:00Z',
        updatedAt: date + 'T00:00:00Z',
        readOnly: true,
        start: { date, time: '11:00', timeZone: 'Asia/Shanghai' },
        end: { date, time: '04:00', timeZone: 'UTC' },
        ...values,
      });
    snapshot.settings = { ...snapshot.settings, timeZone: 'UTC' };
    snapshot.calendarEvents = [
      event('external-details-long', longTitle, { description: longDescription }),
      event('external-details-mixed', '混合时区的一小时事件'),
      ...[true, false].map((allDay) =>
        event(
          'external-details-date-' + allDay,
          allDay ? '保留日期的全天事件' : '保留日期的无时间事件',
          {
            allDay,
            start: { date, time: null, timeZone: 'Pacific/Kiritimati' },
            end: { date: '2032-05-04', time: null, timeZone: 'America/Adak' },
          },
        ),
      ),
    ];
    await route.fulfill({ response, json: snapshot });
  });
  if (info.project.name === 'desktop') await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/?view=apps&app=to-doo&appSection=calendar&calendarView=month&date=' + date);
  const openEvent = async (title: string) => {
    await page.locator('button:visible').filter({ hasText: title }).first().click();
    const dialog = page.getByRole('dialog', { name: '外部日历事件', exact: true });
    await expect(dialog).toBeVisible();
    await dialog.evaluate(async (element) => {
      // Vue schedules the enter animation across frames after mounting the dialog.
      for (let frame = 0; frame < 3; frame++)
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await Promise.all(
        element
          .getAnimations({ subtree: true })
          .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
          .map((animation) => animation.finished.catch(() => {})),
      );
    });
    await expect(dialog).toHaveCSS('opacity', '1');
    await expect(dialog).toHaveCSS('transform', 'none');
    return dialog;
  };
  for (const theme of ['light', 'dark']) {
    await page.evaluate(async (theme) => {
      const modulePath = '/preferences.ts';
      const preferences = await import(modulePath);
      preferences.setEditorPreferences({ theme });
    }, theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const dialog = await openEvent(longTitle);
    await expect(dialog.getByRole('heading', { name: longTitle, exact: true })).toBeVisible();
    const body = dialog.locator('.ant-modal-body');
    const close = dialog.getByRole('button', { name: '关闭', exact: true });
    const metrics = await dialog.locator('.ant-modal-content').evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const body = element.querySelector<HTMLElement>('.ant-modal-body')!;
      const footer = element.querySelector<HTMLElement>('.ant-modal-footer')!;
      return {
        top: bounds.top,
        bottom: bounds.bottom,
        left: bounds.left,
        right: bounds.right,
        height: innerHeight,
        width: innerWidth,
        bodyHeight: body.clientHeight,
        scrollHeight: body.scrollHeight,
        overflowX: body.scrollWidth - body.clientWidth,
        footerTop: footer.getBoundingClientRect().top,
        bodyBottom: body.getBoundingClientRect().bottom,
      };
    });
    expect(metrics.top).toBeGreaterThanOrEqual(0);
    expect(metrics.bottom).toBeLessThanOrEqual(metrics.height);
    expect(metrics.left).toBeGreaterThanOrEqual(0);
    expect(metrics.right).toBeLessThanOrEqual(metrics.width);
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.bodyHeight + 100);
    expect(metrics.overflowX).toBeLessThanOrEqual(1);
    expect(metrics.footerTop).toBeGreaterThanOrEqual(metrics.bodyBottom - 1);
    await expect(close).toBeInViewport();
    await body.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(
      dialog.getByText('外部只读来源，变更需在原日历完成', { exact: true }),
    ).toBeVisible();
    await expect(close).toBeInViewport();
    await page.screenshot({
      path: info.outputPath('external-details-' + theme + '.png'),
      animations: 'disabled',
    });
    await close.click();
    await expect(dialog).toBeHidden();
  }
  const mixed = await openEvent('混合时区的一小时事件');
  await expect(mixed).toContainText('开始：2032-05-03 03:00');
  await expect(mixed).toContainText('结束：2032-05-03 04:00');
  await expect(mixed).toContainText('显示时区：UTC');
  await expect(mixed).not.toContainText('Asia/Shanghai');
  await mixed.getByRole('button', { name: '关闭', exact: true }).click();
  for (const title of ['保留日期的全天事件', '保留日期的无时间事件']) {
    const dialog = await openEvent(title);
    const suffix = title.includes('全天') ? ' 全天' : '';
    await expect(dialog).toContainText('开始：2032-05-03' + suffix);
    await expect(dialog).toContainText('结束：2032-05-04' + suffix);
    if (!suffix) await expect(dialog).not.toContainText('全天');
    await expect(dialog).not.toContainText('显示时区：');
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  }
  expect(writes).toBe(0);
});
