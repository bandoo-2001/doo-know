import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';
import { addDays, localDate } from '../../packages/core/to-doo/recurrence';
import {
  isolateHabitTestReminderOverlays,
  readHabitTestEntities,
} from '../support/to-doo-habit-fixture';

test('a detail calendar records an exact date across workspace midnight without resetting it to habit today', async ({
  page,
  context,
}, info) => {
  test.setTimeout(120_000);
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await isolateHabitTestReminderOverlays(context);
  await page.setViewportSize(
    info.project.name === 'mobile' ? { width: 320, height: 844 } : { width: 1920, height: 1080 },
  );
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const headers = { origin: String(info.project.use.baseURL), 'x-csrf-token': csrf.token };
  async function snapshot() {
    const response = await page.request.get('/api/to-doo/state?kinds=settings,habit&limit=1000');
    expect(response.ok()).toBe(true);
    return response.json();
  }
  async function command(payload: Record<string, unknown>) {
    const response = await page.request.post('/api/to-doo/commands', {
      headers,
      data: { requestId: crypto.randomUUID(), action: 'save_entity', payload },
    });
    expect(response.ok(), await response.text()).toBe(true);
  }
  const before = await snapshot();
  const originalZone = before.settings.timeZone;
  // The temporary fixture's two zones are 26 hours apart, so this remains a
  // real boundary case regardless of the machine's clock time when tests run.
  await command({
    kind: 'settings',
    entity: { ...before.settings, timeZone: 'Etc/GMT+12' },
    expectedRevision: before.settings.revision,
  });
  try {
    const state = await snapshot();
    const workspaceToday = localDate(new Date(state.now), state.settings.timeZone);
    const habitToday = localDate(new Date(state.now), 'Pacific/Kiritimati');
    expect(habitToday > workspaceToday).toBe(true);
    const id = 'habit-timezone-audit-' + info.project.name + '-' + crypto.randomUUID().slice(0, 8);
    const name = '跨时区阅读 · ' + id;
    await command({
      kind: 'habit',
      entity: {
        id,
        name,
        startDate: addDays(workspaceToday, -7),
        timeZone: 'Pacific/Kiritimati',
        goalMode: 'quantity',
        target: 20,
        unit: '页',
        reminders: [],
      },
    });
    await page.clock.install({ time: new Date(state.now) });
    await page.goto('/?view=apps&app=to-doo&appSection=habits&appPage=today');
    await expect(page.locator('.todo-habit-cards')).toHaveAttribute('aria-busy', 'false');
    const card = page.getByRole('article', { name: '习惯 ' + name, exact: true });
    await expect(card).toContainText(habitToday);
    await card.getByRole('button', { name, exact: true }).click();
    const detail = page.getByRole('region', { name: '习惯详情 ' + name, exact: true });
    await expect(detail.locator('.todo-habit-detail-body')).toHaveAttribute('aria-busy', 'false');
    const calendar = detail.locator('.todo-habit-detail-calendar-disclosure');
    await calendar.locator(':scope > summary').click();
    const choose = (date: string) =>
      calendar.getByRole('button', { name: new RegExp('^' + date + ' · ') });
    await choose(workspaceToday).click();
    await expect(choose(workspaceToday)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.todo-habit-cards')).toHaveAttribute('aria-busy', 'false');
    await detail.getByRole('button', { name: '记录这一天', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '记录习惯数量', exact: true });
    await expect(dialog).toContainText(workspaceToday);
    await dialog.getByRole('spinbutton', { name: '习惯数量', exact: true }).fill('3');
    await dialog.getByRole('button', { name: '记录', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('.todo-habit-cards')).toHaveAttribute('aria-busy', 'false');
    await expect(card).toContainText(workspaceToday);
    await expect(card.locator('.todo-habit-day-amount')).toContainText(/3\s*\/\s*20/);

    // The habit's own today is ahead of the workspace date and must still be
    // selectable in its calendar, rather than being rejected by the global day.
    await choose(habitToday).click();
    await expect(choose(habitToday)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.todo-habit-cards')).toHaveAttribute('aria-busy', 'false');
    await detail.getByRole('button', { name: '记录这一天', exact: true }).click();
    await expect(dialog).toContainText(habitToday);
    await dialog.getByRole('spinbutton', { name: '习惯数量', exact: true }).fill('5');
    await dialog.getByRole('button', { name: '记录', exact: true }).click();
    await expect(dialog).toBeHidden();
    const records = (await readHabitTestEntities(page, 'habitEntry')).filter(
      (entry) => entry.habitId === id && !entry.deletedAt,
    );
    expect(
      records
        .map((entry) => ({ date: entry.localDate, amount: entry.amount }))
        .sort((a, b) => a.date.localeCompare(b.date)),
    ).toEqual([
      { date: workspaceToday, amount: 3 },
      { date: habitToday, amount: 5 },
    ]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1);
    await page.screenshot({
      path: info.outputPath('habit-timezone-exact-day.png'),
      animations: 'disabled',
    });
  } finally {
    const current = await snapshot();
    await command({
      kind: 'settings',
      entity: { ...current.settings, timeZone: originalZone },
      expectedRevision: current.settings.revision,
    });
  }
});
