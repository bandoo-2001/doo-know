import { readFile } from 'node:fs/promises';
import type { Locator, Page, TestInfo } from '@playwright/test';
import { test, expect } from '../support/browser-test';
import { addDays, dateTimeInstant, localDate } from '../../packages/core/to-doo/recurrence';
import {
  isolateHabitTestReminderOverlays,
  readHabitTestEntities,
  revealHabitTestCard,
  revealHabitTestDates,
} from '../support/to-doo-habit-fixture';

const pageURL = '/?view=apps&app=to-doo&appSection=habits&appPage=today';
type SampleHabit = { id: string; name: string };

async function seedHabits(page: Page, info: TestInfo) {
  const response = await page.request.get('/api/to-doo/state?limit=200');
  expect(response.ok()).toBe(true);
  const snapshot = await response.json();
  const today = localDate(new Date(snapshot.now), snapshot.settings.timeZone);
  const yesterday = addDays(today, -1);
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const headers = { origin: String(info.project.use.baseURL), 'x-csrf-token': csrf.token };
  const suffix = info.project.name + '-' + crypto.randomUUID().slice(0, 8);
  const ordinary = { id: 'habit-workspace-simple-' + suffix, name: '晨间拉伸 · ' + suffix };
  const quantity = {
    id: 'habit-workspace-quantity-' + suffix,
    name: '阅读与摘录，把日常里值得记住的小小收获整理成自己的知识 · ' + suffix,
  };
  const weekly = { id: 'habit-workspace-weekly-' + suffix, name: '每周运动 · ' + suffix };
  const monthly = { id: 'habit-workspace-monthly-' + suffix, name: '每月读书 · ' + suffix };
  const rest = { id: 'habit-workspace-rest-' + suffix, name: '休息恢复 · ' + suffix };
  async function command(action: string, payload: Record<string, unknown>) {
    const result = await page.request.post('/api/to-doo/commands', {
      headers,
      data: { requestId: crypto.randomUUID(), action, payload },
    });
    expect(result.ok(), await result.text()).toBe(true);
  }
  for (const entity of [
    { ...ordinary, goalMode: 'checkin', target: 1, unit: '次', icon: '🧘', color: '#438674' },
    { ...quantity, goalMode: 'quantity', target: 20, unit: '页', icon: '📚', color: '#657bc5' },
    { ...rest, goalMode: 'checkin', target: 1, unit: '次', pausedDates: [today] },
    {
      ...weekly,
      frequency: 'weekly',
      goalMode: 'quantity',
      target: 3,
      unit: '次',
      icon: '🏃',
      color: '#cc8653',
    },
    {
      ...monthly,
      frequency: 'monthly',
      goalMode: 'quantity',
      target: 2,
      unit: '本',
      icon: '📘',
      color: '#8071af',
    },
  ]) {
    await command('save_entity', {
      kind: 'habit',
      entity: {
        startDate: addDays(today, -14),
        timeZone: snapshot.settings.timeZone,
        description: '隔离浏览器测试中的示例，检查不同目标与长标题的布局。',
        reminders: [],
        ...entity,
      },
    });
  }
  const records = [
    [ordinary, yesterday, 1],
    [quantity, yesterday, 3],
    [quantity, today, 5],
    [weekly, today, 3],
    [monthly, yesterday, 1],
  ] as const;
  await command('import_entities', {
    entities: records.map(([habit, date, amount], index) => ({
      kind: 'habitEntry',
      entity: {
        id: 'habit-workspace-entry-' + suffix + '-' + index,
        habitId: habit.id,
        localDate: date,
        occurredAt: dateTimeInstant({
          date,
          time: '00:00',
          timeZone: snapshot.settings.timeZone,
        }).toISOString(),
        amount,
        note: '用于查看真实月历标记与日期切换后的数量。',
      },
    })),
  });
  return { ordinary, quantity, weekly, monthly, rest, today, yesterday };
}

function card(page: Page, habit: SampleHabit) {
  return page.getByRole('article', {
    name: '习惯 ' + habit.name,
    exact: true,
    includeHidden: true,
  });
}
async function ready(page: Page) {
  await expect(page.locator('.todo-habit-cards')).toHaveAttribute('aria-busy', 'false');
}
async function selectDate(page: Page, date: string) {
  const strip = await revealHabitTestDates(page);
  const choice = strip.getByRole('button', { name: '查看 ' + date + ' 的习惯', exact: true });
  if (!(await choice.count()))
    await strip.getByRole('button', { name: '查看上一周习惯', exact: true }).click();
  await choice.click();
  await expect(choice).toHaveAttribute('aria-pressed', 'true');
  await ready(page);
}
async function returnToday(page: Page) {
  const back = page.getByRole('button', { name: '回到今天', exact: true });
  if (await back.count()) await back.click();
  await ready(page);
}
async function entries(page: Page, habit: SampleHabit) {
  return (await readHabitTestEntities(page, 'habitEntry')).filter(
    (entry) => entry.habitId === habit.id && !entry.deletedAt,
  );
}
async function openDetail(page: Page, habit: SampleHabit) {
  await revealHabitTestCard(page, habit.name);
  await card(page, habit).getByRole('button', { name: habit.name, exact: true }).click();
  const detail = page.getByRole('region', { name: '习惯详情 ' + habit.name, exact: true });
  await expect(detail).toBeVisible();
  await expect(detail.locator('.todo-habit-detail-body')).toHaveAttribute('aria-busy', 'false');
  return detail;
}
async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.evaluate(async (value) => {
    const path = '/preferences.ts';
    (await import(path)).setEditorPreferences({ theme: value });
    await document.fonts.ready;
  }, theme);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}
async function expectSafeRows(page: Page, habits: SampleHabit[]) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  for (const habit of habits) {
    const overlaps = await card(page, habit).evaluate((element) => {
      const selectors = [
        '.todo-habit-card-heading',
        '.todo-habit-card-progress',
        '.todo-habit-card-record',
        '.todo-habit-card-menu',
      ];
      const regions = selectors.map((selector) => ({
        selector,
        box: element.querySelector(selector)!.getBoundingClientRect(),
      }));
      const pairs: string[] = [];
      for (let i = 0; i < regions.length; i++)
        for (let j = i + 1; j < regions.length; j++) {
          const a = regions[i]!,
            b = regions[j]!;
          if (
            Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left) > 1 &&
            Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top) > 1
          )
            pairs.push(a.selector + ' overlaps ' + b.selector);
        }
      const icon = element.querySelector('.todo-habit-card-icon')!.getBoundingClientRect();
      const identity = element.querySelector('.todo-habit-card-identity')!.getBoundingClientRect();
      if (icon.right > identity.left + 1) pairs.push('icon overlaps identity');
      return pairs;
    });
    expect(overlaps, habit.name).toEqual([]);
  }
}
async function expectDetailInViewport(page: Page, detail: Locator) {
  const bounds = (await detail.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual((await page.viewportSize())!.width + 1);
  await expect(detail.getByRole('button', { name: '关闭习惯详情', exact: true })).toBeInViewport();
}

test('habit workspace keeps daily recording, selected dates and monthly details coherent at desktop and phone widths', async ({
  page,
  context,
}, info) => {
  test.setTimeout(120_000);
  await isolateHabitTestReminderOverlays(context);
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.setViewportSize(
    info.project.name === 'mobile' ? { width: 390, height: 844 } : { width: 1920, height: 1080 },
  );
  const fixture = await seedHabits(page, info);
  await page.goto(pageURL);
  await ready(page);
  const dateBrowser = page.locator('.todo-habit-date-browser');
  await expect(dateBrowser).not.toHaveAttribute('open', '');
  await expect(dateBrowser.locator(':scope > summary')).toHaveAccessibleName('查看其他日期');
  await expect(card(page, fixture.weekly)).toBeHidden();
  await expect(card(page, fixture.rest)).toBeHidden();
  await expect(
    page
      .getByRole('region', { name: '今天的日常行动', exact: true })
      .getByRole('article', { name: '习惯 ' + fixture.quantity.name, exact: true }),
  ).toBeVisible();
  const periodGoals = page.getByRole('region', { name: '这周与这个月', exact: true });
  await expect(
    periodGoals.getByRole('article', { name: '习惯 ' + fixture.monthly.name, exact: true }),
  ).toBeVisible();
  await expect(card(page, fixture.monthly).locator('.todo-habit-day-amount')).toHaveCount(0);
  await expect(card(page, fixture.monthly).locator('.todo-habit-plan-caption')).toHaveAttribute(
    'title',
    /还差 1 本/,
  );
  const strip = await revealHabitTestDates(page);
  await expect(
    strip.getByRole('button', { name: '查看 ' + fixture.today + ' 的习惯', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');

  const checkin = card(page, fixture.ordinary).getByRole('button', {
    name: '打卡 ' + fixture.ordinary.name,
    exact: true,
  });
  await expect(checkin).toBeEnabled();
  await checkin.click();
  await ready(page);
  await expect(checkin).toBeDisabled();
  await expect(checkin).toHaveClass(/is-complete/);
  const ordinaryEntries = await entries(page, fixture.ordinary);
  expect(
    ordinaryEntries.filter((entry: { localDate: string }) => entry.localDate === fixture.today),
  ).toHaveLength(1);

  const quantityInput = card(page, fixture.quantity).getByRole('spinbutton', {
    name: '记录数量 ' + fixture.quantity.name,
    exact: true,
  });
  await quantityInput.fill('4');
  await selectDate(page, fixture.yesterday);
  await quantityInput.fill('7');
  await returnToday(page);
  await expect(quantityInput).toHaveValue('4');
  await selectDate(page, fixture.yesterday);
  await expect(quantityInput).toHaveValue('7');
  await card(page, fixture.quantity)
    .getByRole('button', { name: '记录数量 ' + fixture.quantity.name, exact: true })
    .click();
  await ready(page);
  await expect(card(page, fixture.quantity).locator('.todo-habit-day-amount')).toHaveText(
    /10\s*\/\s*20\s*页/,
  );
  const quantityEntries = await entries(page, fixture.quantity);
  expect(
    quantityEntries
      .filter((entry: { localDate: string }) => entry.localDate === fixture.yesterday)
      .map((entry: { amount: number }) => entry.amount)
      .sort((a: number, b: number) => a - b),
  ).toEqual([3, 7]);
  expect(
    quantityEntries
      .filter((entry: { localDate: string }) => entry.localDate === fixture.today)
      .map((entry: { amount: number }) => entry.amount),
  ).toEqual([5]);
  await returnToday(page);
  await expect(quantityInput).toHaveValue('4');

  for (const habit of [fixture.ordinary, fixture.quantity, fixture.weekly, fixture.monthly])
    await revealHabitTestCard(page, habit.name);
  const detail = await openDetail(page, fixture.weekly);
  await expect(detail.locator('.todo-habit-detail-trend-day')).toHaveCount(14);
  await expect(detail.locator('.todo-habit-detail-trend-day.is-recorded')).toHaveCount(1);
  const calendarDisclosure = detail.locator('.todo-habit-detail-calendar-disclosure');
  const statisticsDisclosure = detail.locator('.todo-habit-detail-statistics');
  await expect(calendarDisclosure).not.toHaveAttribute('open', '');
  await expect(statisticsDisclosure).not.toHaveAttribute('open', '');
  await calendarDisclosure.locator(':scope > summary').click();
  await statisticsDisclosure.locator(':scope > summary').click();
  await expect(page.locator('.todo-habit-workspace')).toHaveClass(/has-detail/);
  const monthMetric = detail
    .locator('.todo-habit-detail-metrics > div')
    .filter({ has: page.locator('dt', { hasText: '本月打卡' }) });
  await expect(monthMetric.locator('dd')).toHaveText(/1\s*天/);
  await expect(detail.locator('.todo-habit-detail-calendar-grid .is-recorded')).toHaveCount(1);
  await expect(detail.locator('.todo-habit-detail-calendar-grid .is-achieved')).toHaveCount(0);
  await expect(detail).toContainText('月历只标记实际记录的日期');
  await expect(
    detail.getByRole('button', { name: addDays(fixture.today, 1) + ' · 未来日期', exact: true }),
  ).toBeDisabled();
  // Dates remain in a user-controlled disclosure; reopen explicitly before checking future guards.
  await detail.getByRole('button', { name: '关闭习惯详情', exact: true }).click();
  await revealHabitTestDates(page);
  for (const day of await strip.locator('.todo-habit-week-days > button').all()) {
    const label = await day.getAttribute('aria-label');
    if (label!.slice(3, 13) > fixture.today) await expect(day).toBeDisabled();
  }
  await openDetail(page, fixture.weekly);
  for (const width of info.project.name === 'mobile' ? [390, 320] : [1920]) {
    await page.setViewportSize({ width, height: width < 400 ? 844 : 1080 });
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await expectSafeRows(page, [
        fixture.ordinary,
        fixture.quantity,
        fixture.weekly,
        fixture.monthly,
      ]);
      await expectDetailInViewport(page, detail);
      if (width > 400) {
        const main = (await page.locator('.todo-habit-workspace-main').boundingBox())!;
        const panel = (await page.locator('.todo-habit-detail-slot').boundingBox())!;
        expect(panel.x).toBeGreaterThanOrEqual(main.x + main.width + 8);
      } else
        await expect(page.getByRole('button', { name: '收起习惯详情', exact: true })).toBeVisible();
      await page.screenshot({
        path: info.outputPath(`habit-workspace-${width}-${theme}.png`),
        animations: 'disabled',
      });
    }
  }
  await detail.getByRole('button', { name: '关闭习惯详情', exact: true }).click();
  await expect(detail).toBeHidden();
  const monthlyDetail = await openDetail(page, fixture.monthly);
  await expect(monthlyDetail.locator('.todo-habit-detail-period-progress')).toContainText(
    /\/\s*2\s*本/,
  );
  await monthlyDetail.getByRole('button', { name: '关闭习惯详情', exact: true }).click();

  await page
    .getByRole('button', { name: /新建习惯/ })
    .first()
    .click();
  const editor = page.getByRole('dialog', { name: '新建习惯', exact: true });
  await expect(editor.getByLabel('名称', { exact: true })).toBeVisible();
  await expect(editor.getByRole('combobox', { name: '频率', exact: true })).toBeVisible();
  await expect(editor.getByRole('combobox', { name: '目标', exact: true })).toBeVisible();
  await expect(editor.getByLabel('开始日期', { exact: true })).toBeVisible();
  await editor.getByRole('button', { name: '选择习惯图标', exact: true }).click();
  await expect(page.getByRole('group', { name: '选择习惯图标', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(editor).toBeVisible();
  await expect(page.getByRole('group', { name: '选择习惯图标', exact: true })).toBeHidden();
  await expect(editor.getByRole('button', { name: '保存', exact: true })).toBeInViewport();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  await page.screenshot({
    path: info.outputPath('habit-compact-create-form.png'),
    animations: 'disabled',
  });
  await editor.getByRole('button', { name: '取消', exact: true }).click();
  await expect(editor).toBeHidden();
});
