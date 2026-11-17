import { readFile } from 'node:fs/promises';
import type { Locator } from '@playwright/test';
import { test, expect } from '../support/browser-test';

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

async function settle(element: Locator) {
  await element.evaluate(async (node) => {
    for (let frame = 0; frame < 3; frame++)
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await Promise.all(
      node
        .getAnimations({ subtree: true })
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
  await expect(element).toHaveCSS('opacity', '1');
}

test('date and time panels fit narrow dialogs and preserve native selection and draft behavior', async ({
  page,
}, info) => {
  test.setTimeout(90000);
  const sizes =
    info.project.name === 'desktop'
      ? [{ width: 1920, height: 1080 }]
      : [
          { width: 390, height: 844 },
          { width: 320, height: 568 },
        ];
  let writes = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/to-doo/commands')) writes++;
  });
  await page.goto('/?view=apps&app=to-doo&appSection=tasks');
  await expect(page.locator('.to-doo-workspace')).toBeVisible();
  await page.evaluate(async () => {
    const runtimePath = '/plugin-runtime.ts',
      dialogPath = '/components/to-doo/ToDooCaptureDialog.vue',
      formPath = '/components/to-doo/ToDooFormLayout.vue',
      datePath = '/components/to-doo/ToDooDateField.vue';
    const { createApp, h, ref } = await import(runtimePath);
    const Dialog = (await import(dialogPath)).default,
      Form = (await import(formPath)).default,
      DateField = (await import(datePath)).default;
    const original = document.getElementById('app');
    if (original) original.style.display = 'none';
    const host = document.createElement('div');
    document.body.appendChild(host);
    const open = ref(true),
      draft = ref('保留弹窗内的任务草稿'),
      timestamp = ref('2032-05-03T09:10'),
      date = ref('2032-05-03');
    createApp({
      render: () =>
        h('div', {}, [
          h(
            Dialog,
            {
              open: open.value,
              busy: false,
              'onUpdate:open': (value: boolean) => (open.value = value),
            },
            {
              default: () =>
                h(Form, {}, () => [
                  h('label', [
                    '任务草稿',
                    h('input', {
                      'aria-label': '任务草稿',
                      value: draft.value,
                      onInput: (event: Event) =>
                        (draft.value = (event.target as HTMLInputElement).value),
                    }),
                  ]),
                  h('label', [
                    '完整日期与时间',
                    h(DateField, {
                      type: 'datetime-local',
                      'aria-label': '完整日期与时间',
                      modelValue: timestamp.value,
                      'onUpdate:modelValue': (value: string) => (timestamp.value = value),
                    }),
                  ]),
                  h('label', [
                    '单独日期',
                    h(DateField, {
                      type: 'date',
                      'aria-label': '单独日期',
                      modelValue: date.value,
                      'onUpdate:modelValue': (value: string) => (date.value = value),
                    }),
                  ]),
                ]),
            },
          ),
          h('output', { 'data-testid': 'timestamp' }, timestamp.value),
          h('output', { 'data-testid': 'date' }, date.value),
          h('output', { 'data-testid': 'draft' }, draft.value),
          h('output', { 'data-testid': 'dialog-state' }, open.value ? 'open' : 'closed'),
        ]),
    }).mount(host);
  });
  const dialog = page.getByRole('dialog', { name: '从资料创建任务', exact: true });
  await settle(dialog);
  for (const size of sizes) {
    await page.setViewportSize(size);
    for (const theme of ['light', 'dark']) {
      await page.evaluate(async (value) => {
        const path = '/preferences.ts';
        (await import(path)).setEditorPreferences({ theme: value });
      }, theme);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      const timestamp = dialog.getByRole('textbox', { name: '完整日期与时间', exact: true });
      await timestamp.click();
      const popup = page.locator('.ant-picker-dropdown:visible');
      await expect(popup).toBeVisible();
      await settle(popup);
      const panel = popup.locator('.ant-picker-panel-container');
      const calendar = popup.locator('.ant-picker-date-panel');
      const clock = popup.locator('.ant-picker-time-panel');
      const calendarBounds = (await calendar.boundingBox())!,
        clockBounds = (await clock.boundingBox())!;
      if (size.width > 600) {
        expect(Math.abs(calendarBounds.y - clockBounds.y)).toBeLessThanOrEqual(1);
        expect(clockBounds.x).toBeGreaterThanOrEqual(calendarBounds.x + calendarBounds.width - 1);
      } else {
        expect(clockBounds.y).toBeGreaterThanOrEqual(calendarBounds.y + calendarBounds.height - 1);
        expect(Math.abs(clockBounds.x - calendarBounds.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(clockBounds.width - calendarBounds.width)).toBeLessThanOrEqual(2);
        const columns = popup.locator('.ant-picker-time-panel-column');
        await expect(columns).toHaveCount(2);
        const bounds = await columns.evaluateAll((elements) =>
          elements.map((element) => {
            const box = element.getBoundingClientRect();
            return { left: box.left, right: box.right, width: box.width };
          }),
        );
        for (const column of bounds) {
          expect(column.width).toBeGreaterThan(80);
          expect(column.left).toBeGreaterThanOrEqual(0);
          expect(column.right).toBeLessThanOrEqual(size.width);
        }
        expect(bounds[1].left).toBeGreaterThanOrEqual(bounds[0].right - 1);
        expect(
          await panel.evaluate((element) => element.scrollWidth - element.clientWidth),
        ).toBeLessThanOrEqual(1);
        expect(
          await panel.evaluate((element) => element.getBoundingClientRect().height),
        ).toBeLessThanOrEqual(size.height - 23);
        if (size.height === 568)
          expect(
            await panel.evaluate((element) => element.scrollHeight - element.clientHeight),
          ).toBeGreaterThan(0);
      }
      const columns = popup.locator('.ant-picker-time-panel-column');
      const hour = columns
        .nth(0)
        .locator('.ant-picker-time-panel-cell-inner')
        .filter({ hasText: /^14$/ });
      const minute = columns
        .nth(1)
        .locator('.ant-picker-time-panel-cell-inner')
        .filter({ hasText: /^35$/ });
      await hour.scrollIntoViewIfNeeded();
      await hour.click();
      await minute.scrollIntoViewIfNeeded();
      await minute.click();
      const confirm = popup.locator('.ant-picker-ok button');
      await confirm.scrollIntoViewIfNeeded();
      await expect(confirm).toBeInViewport();
      await page.screenshot({
        path: info.outputPath('datetime-' + size.width + '-' + theme + '.png'),
        animations: 'disabled',
      });
      await confirm.click();
      await expect(popup).toBeHidden();
      await expect(page.getByTestId('timestamp')).toHaveText('2032-05-03T14:35');
      await expect(timestamp).toHaveValue('2032-05-03 14:35');
      await timestamp.click();
      await expect(popup).toBeVisible();
      await timestamp.press('Escape');
      await expect(popup).toBeHidden();
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('textbox', { name: '任务草稿', exact: true })).toHaveValue(
        '保留弹窗内的任务草稿',
      );
      const date = dialog.getByRole('textbox', { name: '单独日期', exact: true });
      await date.click();
      await expect(popup).toBeVisible();
      await settle(popup);
      const headers = popup.locator('.ant-picker-date-panel thead th');
      await expect(headers).toHaveCount(7);
      const grid = popup.locator('.ant-picker-date-panel table.ant-picker-content');
      const gridBounds = (await grid.boundingBox())!;
      for (const header of await headers.all()) {
        const cell = (await header.boundingBox())!;
        expect(cell.x).toBeGreaterThanOrEqual(gridBounds.x - 1);
        expect(cell.x + cell.width).toBeLessThanOrEqual(gridBounds.x + gridBounds.width + 1);
      }
      expect(gridBounds.x).toBeGreaterThanOrEqual(0);
      expect(gridBounds.x + gridBounds.width).toBeLessThanOrEqual(size.width);
      await popup.locator('.ant-picker-year-btn').click();
      await expect(popup.locator('.ant-picker-year-panel')).toBeVisible();
      await popup.locator('.ant-picker-year-panel [title="2033"]').click();
      await expect(popup.locator('.ant-picker-date-panel')).toBeVisible();
      await popup.locator('.ant-picker-month-btn').click();
      await expect(popup.locator('.ant-picker-month-panel')).toBeVisible();
      await popup.locator('.ant-picker-month-panel [title="2033-06"]').click();
      await expect(popup.locator('.ant-picker-date-panel')).toBeVisible();
      await popup.locator('.ant-picker-date-panel [title="2033-06-15"]').click();
      await expect(popup).toBeHidden();
      await expect(page.getByTestId('date')).toHaveText('2033-06-15');
      await expect(page.getByTestId('dialog-state')).toHaveText('open');
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
      ).toBeLessThanOrEqual(1);
    }
  }
  const timestamp = dialog.getByRole('textbox', { name: '完整日期与时间', exact: true });
  await timestamp.focus();
  await timestamp.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('dialog-state')).toHaveText('closed');
  await expect(page.getByTestId('draft')).toHaveText('保留弹窗内的任务草稿');
  expect(writes).toBe(0);
});
