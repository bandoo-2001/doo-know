import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from '../support/browser-test';
import { selectToDooOption } from '../support/to-doo-ant-controls';

const evidence = resolve('docs/design/to-doo/audit-fixes-2026-11-03/life');
test.beforeEach(async ({ page, context }, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.clock.install({ time: new Date('2026-11-03T12:00:00Z') });
  await page.setViewportSize({ width: info.project.name === 'mobile' ? 390 : 1440, height: 900 });
  await mkdir(evidence, { recursive: true });
});
async function command(page: Page, action: string, payload: Record<string, unknown>) {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const response = await page.request.post('/api/to-doo/commands', {
    headers: { origin: String(test.info().project.use.baseURL), 'x-csrf-token': csrf.token },
    data: { requestId: crypto.randomUUID(), action, payload },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.evaluate(async (selected) => {
    const modulePath = '/preferences.ts';
    const preferences = await import(modulePath);
    preferences.setEditorPreferences({ theme: selected });
    await document.fonts.ready;
  }, theme);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}
async function capture(page: Page, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: resolve(evidence, test.info().project.name + '-' + name + '.png'),
    fullPage: true,
    animations: 'disabled',
  });
}

test('quantity history retains 45/20 and correction removes only one of three saved entries', async ({
  page,
}, info) => {
  const id = 'audit-life-' + crypto.randomUUID();
  const name = '阅读的积累';
  await command(page, 'save_entity', {
    kind: 'habit',
    entity: {
      id,
      name,
      startDate: '2026-11-01',
      timeZone: 'UTC',
      target: 20,
      unit: '页',
      goalMode: 'quantity',
    },
  });
  const ordinaryId = id + '-check';
  await command(page, 'save_entity', {
    kind: 'habit',
    entity: {
      id: ordinaryId,
      name: '每天散步',
      startDate: '2026-11-01',
      timeZone: 'UTC',
      goalMode: 'checkin',
    },
  });
  await command(page, 'import_entities', {
    entities: [10, 15, 20].map((amount, i) => ({
      kind: 'habitEntry',
      entity: {
        id: id + '-' + i,
        habitId: id,
        localDate: '2026-11-03',
        occurredAt: `2026-11-03T0${i + 1}:00:00Z`,
        amount,
        note: '第' + (i + 1) + '次阅读',
      },
    })),
  });
  await page.goto('/?view=apps&app=to-doo&appSection=habits');
  const card = page.getByRole('article', { name: '习惯 ' + name, exact: true });
  await expect(card).toContainText('今天 45 / 20 页');
  await expect(
    page.getByRole('article', { name: '习惯 每天散步', exact: true }).getByRole('spinbutton'),
  ).toHaveCount(0);
  if (info.project.name === 'mobile') {
    const box = await card.boundingBox();
    expect(box!.height).toBeLessThan(235);
  }
  await capture(page, 'habits-light');
  await setTheme(page, 'dark');
  await capture(page, 'habits-dark');
  await page.getByText('历史', { exact: true }).click();
  const day = page.getByRole('button', {
    name: name + ' 2026-11-03 打卡，当前 45 页',
    exact: true,
  });
  await expect(day).toContainText('45');
  await expect(day).toContainText('✓');
  await day.click();
  const dialog = page.getByRole('dialog', { name: '记录习惯数量', exact: true });
  await expect(dialog).toContainText('已累计 45 / 20 页');
  await expect(dialog.locator('[data-habit-entry-id]')).toHaveCount(3);
  await capture(page, 'habit-entries');
  await dialog
    .locator('[data-habit-entry-id="' + id + '-0"]')
    .getByRole('button', { name: '撤销此条', exact: true })
    .click();
  const confirmation = page.getByRole('dialog', { name: '撤销单条习惯记录', exact: true });
  await confirmation.getByRole('button', { name: '确认', exact: true }).click();
  await expect(dialog.locator('[data-habit-entry-id]')).toHaveCount(2);
  await expect(dialog).toContainText('已累计 35 / 20 页');
  const state = await (
    await page.request.get(
      '/api/to-doo/state?' +
        new URLSearchParams({
          kind: 'habitEntry',
          ids: [0, 1, 2].map((i) => id + '-' + i).join(','),
        }),
    )
  ).json();
  expect(
    state.habitEntries
      .filter((e: any) => e.habitId === id)
      .map((e: any) => e.amount)
      .sort(),
  ).toEqual([15, 20]);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(
    page.getByRole('button', { name: name + ' 2026-11-03 打卡，当前 35 页', exact: true }),
  ).toContainText('35');
});

test('anniversaries show today and original past date, with bounded desktop card widths', async ({
  page,
}, info) => {
  for (const [id, name, date, countMode] of [
    ['today-a', '就是今天的纪念', '2026-11-03', 'exclude_today'],
    ['today-b', '包含今天的纪念', '2026-11-03', 'include_today'],
    ['past', '已经发生的日子', '2026-11-01', 'exclude_today'],
  ]) {
    await command(page, 'save_entity', {
      kind: 'anniversary',
      entity: { id: id + '-' + crypto.randomUUID(), name, date, countMode, repeatYearly: false },
    });
  }
  await page.goto('/?view=apps&app=to-doo&appSection=anniversaries');
  for (const name of ['就是今天的纪念', '包含今天的纪念']) {
    const card = page
      .locator('.todo-anniversary')
      .filter({ has: page.getByRole('heading', { name, exact: true }) });
    await expect(card).toContainText('就是今天');
    if (info.project.name === 'desktop')
      expect((await card.boundingBox())!.width).toBeLessThanOrEqual(342);
  }
  const past = page
    .locator('.todo-anniversary')
    .filter({ has: page.getByRole('heading', { name: '已经发生的日子', exact: true }) });
  await expect(past).toContainText('公历日期：2026-11-01');
  await expect(past).not.toContainText('下次');
  await capture(page, 'anniversaries-light');
  await setTheme(page, 'dark');
  await capture(page, 'anniversaries-dark');
});

test('lunar year month day validates actual leap months, saves the original payload and protects unsaved close', async ({
  page,
}) => {
  await page.goto('/?view=apps&app=to-doo&appSection=anniversaries');
  await page
    .getByRole('button', { name: /新建纪念日/ })
    .first()
    .click();
  const editor = page.getByRole('dialog', { name: '新建纪念日', exact: true });
  const name = '农历二月三十 ' + crypto.randomUUID().slice(0, 6);
  await editor.getByLabel('名称', { exact: true }).fill(name);
  await selectToDooOption(editor, '历法', '农历');
  await editor.getByRole('spinbutton', { name: '农历年', exact: true }).fill('2024');
  await selectToDooOption(editor, '农历月', '二月');
  await editor.getByRole('spinbutton', { name: '农历日', exact: true }).fill('30');
  await editor.getByRole('checkbox', { name: '农历闰月', exact: true }).check();
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(editor).toBeVisible();
  await expect(editor).toContainText('请检查农历日期与闰月');
  await editor.getByRole('checkbox', { name: '农历闰月', exact: true }).uncheck();
  await capture(page, 'lunar-dialog-light');
  await setTheme(page, 'dark');
  await capture(page, 'lunar-dialog-dark');
  await editor.getByRole('button', { name: '关闭编辑', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: '确认操作', exact: true });
  await expect(confirm).toContainText('放弃这些输入');
  await confirm.getByRole('button', { name: '取消', exact: true }).click();
  await expect(editor.getByRole('spinbutton', { name: '农历日', exact: true })).toHaveValue('30');
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(editor).not.toBeVisible();
  const state = await (
    await page.request.get('/api/to-doo/state?kind=anniversary&limit=200')
  ).json();
  expect(state.anniversaries.find((a: any) => a.name === name)).toMatchObject({
    date: '2024-02-30',
    calendar: 'lunar',
    lunarLeapMonth: false,
  });
  const card = page
    .locator('.todo-anniversary')
    .filter({ has: page.getByRole('heading', { name, exact: true }) });
  await card.getByRole('button', { name: '编辑 ' + name, exact: true }).click();
  const reopened = page.getByRole('dialog', { name: '编辑纪念日', exact: true });
  await expect(reopened.getByRole('spinbutton', { name: '农历年', exact: true })).toHaveValue(
    '2024',
  );
  await expect(reopened.getByRole('spinbutton', { name: '农历日', exact: true })).toHaveValue('30');
});

test('anniversary cards remain inside the 320px viewport without document overflow', async ({
  page,
}) => {
  await command(page, 'save_entity', {
    kind: 'anniversary',
    entity: {
      id: 'narrow-' + crypto.randomUUID(),
      name: '窄屏纪念日',
      date: '2026-11-03',
      repeatYearly: false,
    },
  });
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('/?view=apps&app=to-doo&appSection=anniversaries');
  const card = page
    .locator('.todo-anniversary')
    .filter({ has: page.getByRole('heading', { name: '窄屏纪念日', exact: true }) });
  await expect(card).toBeVisible();
  const box = await card.boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(320);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await capture(page, 'anniversary-320');
});
