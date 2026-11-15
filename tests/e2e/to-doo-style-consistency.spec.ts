import { test, expect } from '../support/browser-test';
import {
  closeToDooDirectory,
  goToToDooSection,
  openToDooDirectory,
} from '../support/to-doo-navigation';
import {
  authenticateVisualContext,
  seedToDooVisual,
  VISUAL_NOW,
  VISUAL_ORIGIN,
} from '../support/to-doo-visual-fixture';

// The normal suite verifies empty states. The fixed-clock visual run also
// populates its isolated dataset so the same checks exercise real page content.
test.beforeAll(async ({ browser }) => {
  if (process.env.DOOKNOW_E2E_FIXED_TIME !== VISUAL_NOW) return;
  const context = await browser.newContext({ baseURL: VISUAL_ORIGIN });
  try {
    await authenticateVisualContext(context);
    await seedToDooVisual(await context.newPage());
  } finally {
    await context.close();
  }
});

test.beforeEach(async ({ context, page }) => {
  await authenticateVisualContext(context);
  if (process.env.DOOKNOW_E2E_FIXED_TIME === VISUAL_NOW)
    await page.clock.install({ time: new Date(VISUAL_NOW) });
});

const sections = [
  'tasks',
  'board',
  'overview',
  'calendar',
  'timeline',
  'matrix',
  'focus',
  'habits',
  'anniversaries',
  'stats',
  'notifications',
  'settings',
] as const;

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
  { width: 320, height: 740 },
]) {
  for (const theme of ['light', 'dark'] as const) {
    test(`To Doo shares its page scale at ${viewport.width}px in ${theme}`, async ({
      page,
    }, info) => {
      test.setTimeout(240000);
      await page.setViewportSize(viewport);
      await page.goto('/?view=apps&app=to-doo&appSection=tasks&taskFilter=all');
      const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
      await expect(app).toBeVisible();
      await expect(app.locator('.todo-main')).toHaveAttribute('aria-busy', 'false');
      await page.evaluate(async (selected) => {
        const modulePath = '/preferences.ts';
        const preferences = await import(modulePath);
        preferences.setEditorPreferences({ theme: selected });
        await document.fonts.ready;
      }, theme);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

      let reference:
        | {
            titleFont: string;
            titleWeight: string;
            titleColor: string;
            actionHeight: number;
            actionFont: string;
            directoryFont: string;
            directoryTitleFont: string;
          }
        | undefined;

      for (const section of sections) {
        await goToToDooSection(page, section);
        await expect(app.locator('.todo-main')).toHaveAttribute('aria-busy', 'false');
        await expect(app.locator('.todo-content')).toBeVisible();
        await closeToDooDirectory(page);
        const heading = app.locator('.todo-page-heading');
        await expect(heading.locator('h1')).toBeVisible();
        const metrics = await heading.evaluate((element) => {
          const title = getComputedStyle(element.querySelector('h1')!);
          const action = element.querySelector<HTMLElement>('.todo-actions > .ant-btn')!;
          const actionStyle = getComputedStyle(action);
          return {
            titleFont: title.fontSize,
            titleWeight: title.fontWeight,
            titleColor: title.color,
            actionHeight: action.getBoundingClientRect().height,
            actionFont: actionStyle.fontSize,
          };
        });
        if (!reference) {
          const directory = app.locator('.todo-navigation-content').first();
          const directoryMetrics = await directory.evaluate((element) => ({
            directoryFont: getComputedStyle(element.querySelector('nav .ant-btn')!).fontSize,
            directoryTitleFont: getComputedStyle(element.querySelector('.todo-nav-label')!)
              .fontSize,
          }));
          reference = { ...metrics, ...directoryMetrics };
        }
        expect.soft(metrics.titleFont, section + ': title font').toBe(reference.titleFont);
        expect.soft(metrics.titleWeight, section + ': title weight').toBe(reference.titleWeight);
        expect.soft(metrics.titleColor, section + ': title color').toBe(reference.titleColor);
        expect
          .soft(metrics.actionHeight, section + ': main action height')
          .toBeCloseTo(reference.actionHeight, 0);
        expect.soft(metrics.actionFont, section + ': main action font').toBe(reference.actionFont);

        // Page actions and the first toolbar share one visual priority level.
        const primaryCount = await app
          .locator(
            '.todo-page-heading .ant-btn-primary:visible, .todo-content > .todo-page-toolbar .ant-btn-primary:visible',
          )
          .count();
        expect.soft(primaryCount, section + ': competing page actions').toBeLessThanOrEqual(1);

        if (section === 'calendar') {
          const directory = await openToDooDirectory(page);
          const directoryMetrics = await directory.evaluate((element) => ({
            directoryFont: getComputedStyle(element.querySelector('.ant-btn')!).fontSize,
            directoryTitleFont: getComputedStyle(element.querySelector('.todo-nav-label')!)
              .fontSize,
          }));
          expect
            .soft(directoryMetrics.directoryFont, 'calendar: directory font')
            .toBe(reference.directoryFont);
          expect
            .soft(directoryMetrics.directoryTitleFont, 'calendar: directory title')
            .toBe(reference.directoryTitleFont);
          await closeToDooDirectory(page);
        }

        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - innerWidth,
        );
        expect.soft(overflow, section + ': horizontal overflow').toBeLessThanOrEqual(1);
        const headingOverflow = await heading.evaluate(
          (element) => element.scrollWidth - element.clientWidth,
        );
        expect.soft(headingOverflow, section + ': heading overflow').toBeLessThanOrEqual(1);
        await page.mouse.move(1, 1);
        await page.screenshot({
          path: info.outputPath(`${viewport.width}-${theme}-${section}.png`),
          animations: 'disabled',
          fullPage: false,
          scale: 'css',
        });
      }
    });
  }
}

test('calendar page actions retain their selected date and task creation', async ({
  page,
}, info) => {
  test.setTimeout(90000);
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: 844 });
    for (const section of ['calendar', 'timeline']) {
      await page.goto(
        '/?view=apps&app=to-doo&appSection=' + section + '&calendarView=week&date=2030-01-15',
      );
      const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
      await expect(app.locator('.todo-main')).toHaveAttribute('aria-busy', 'false');
      await app
        .locator('.todo-calendar-toolbar')
        .getByRole('button', { name: '＋ 预留时间', exact: true })
        .click();
      const editor = page.getByRole('dialog', { name: '新建时间安排', exact: true });
      await expect(editor).toBeVisible();
      await expect(editor.getByLabel('日期', { exact: true })).toHaveValue('2030-01-15');
      await editor.getByRole('button', { name: '取消', exact: true }).click();
      await expect(editor).not.toBeVisible();

      await app
        .locator('.todo-page-heading')
        .getByRole('button', { name: '新建任务', exact: true })
        .click();
      const task = app.getByRole('complementary', { name: '任务详情', exact: true });
      await expect(task).toBeVisible();
      await expect(task.getByLabel('任务标题', { exact: true })).toHaveValue('');
      await expect(task.getByLabel('计划日期', { exact: true })).toHaveValue('2030-01-15');
      await task.getByRole('button', { name: '关闭任务详情', exact: true }).click();
      await expect(task).not.toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
      ).toBeLessThanOrEqual(1);
      await page.screenshot({
        path: info.outputPath(`${width}-${section}-week.png`),
        animations: 'disabled',
      });
    }
  }
});

test('compact task density reduces row height without shrinking task text', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const title = '紧凑密度仍保持清晰的任务标题';
  const listId = 'style-density-goal-' + crypto.randomUUID();
  const goalResponse = await page.request.post('/api/to-doo/commands', {
    headers: { origin: String(info.project.use.baseURL), 'x-csrf-token': csrf.token },
    data: {
      requestId: crypto.randomUUID(),
      action: 'save_entity',
      payload: { kind: 'list', entity: { id: listId, name: '紧凑目标卡片布局', kind: 'goal' } },
    },
  });
  expect(goalResponse.ok()).toBe(true);
  const response = await page.request.post('/api/to-doo/commands', {
    headers: { origin: String(info.project.use.baseURL), 'x-csrf-token': csrf.token },
    data: {
      requestId: crypto.randomUUID(),
      action: 'create_task',
      payload: { id: 'style-density-' + crypto.randomUUID(), title, listId },
    },
  });
  expect(response.ok()).toBe(true);
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&taskFilter=all');
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
  const row = app.locator('.todo-task-row').filter({ hasText: title }).last();
  await expect(row).toBeVisible();
  const measure = () =>
    row.evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      font: getComputedStyle(element.querySelector('.todo-task-name')!).fontSize,
    }));
  const comfortable = await measure();
  await app.getByRole('button', { name: '显示选项', exact: true }).click();
  const density = page.locator('.todo-ant-density');
  await density.getByText('紧凑', { exact: true }).click();
  await expect(app).toHaveClass(/todo-compact/);
  const compact = await measure();
  expect(compact.height).toBeLessThan(comfortable.height);
  expect(compact.font).toBe(comfortable.font);
  await app.getByRole('button', { name: '显示选项', exact: true }).click();
  await page.screenshot({
    path: info.outputPath('1440-compact-tasks.png'),
    animations: 'disabled',
  });
  await goToToDooSection(page, 'overview');
  const goal = app.locator('.todo-goal').filter({ hasText: '紧凑目标卡片布局' });
  await expect(goal).toBeVisible();
  const card = await goal.evaluate((element) => ({
    width: element.getBoundingClientRect().width,
    body: element.querySelector('.ant-card-body')!.getBoundingClientRect().width,
    overflow: element.scrollWidth - element.clientWidth,
  }));
  expect(card.body).toBeGreaterThan(card.width * 0.95);
  expect(card.overflow).toBeLessThanOrEqual(1);
  await page.screenshot({
    path: info.outputPath('1440-compact-overview.png'),
    animations: 'disabled',
  });
  await goToToDooSection(page, 'tasks');
  await app.getByRole('button', { name: '显示选项', exact: true }).click();
  await density.getByText('舒展', { exact: true }).click();
  await expect(app).not.toHaveClass(/todo-compact/);
  expect((await measure()).height).toBeCloseTo(comfortable.height, 0);
});
