import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

test('new task weekly choices stay inline, wrap on small screens, and retain their draft selection', async ({
  page,
}, info) => {
  let writes = 0;
  await page.route('**/api/to-doo/commands', async (route) => {
    writes++;
    await route.abort();
  });
  const sizes =
    info.project.name === 'desktop'
      ? [{ width: 1920, height: 1080 }]
      : [
          { width: 390, height: 844 },
          { width: 320, height: 568 },
        ];
  await page.setViewportSize(sizes[0]);
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&taskFilter=inbox');
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  const detail = page.getByRole('complementary', { name: '任务详情', exact: true });
  const title = '检查新建任务的每周选项和草稿';
  const description = '这段输入需要在调整重复选项和关闭侧栏后保留。\n'.repeat(12);
  await expect(detail.getByRole('button', { name: '创建任务', exact: true })).toBeDisabled();
  await detail.getByRole('textbox', { name: '任务标题', exact: true }).fill(title);
  await detail.getByRole('textbox', { name: '任务说明', exact: true }).fill(description);
  await detail.locator('.ant-collapse-header').filter({ hasText: '更多选项' }).click();
  const repeat = detail.getByRole('combobox', { name: '重复', exact: true });
  await repeat
    .locator(
      'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " ant-select ")][1]',
    )
    .locator('.ant-select-selector')
    .click();
  await page
    .locator('.ant-select-dropdown:visible .ant-select-item-option')
    .filter({ hasText: '每周' })
    .click();
  const weekdays = detail.getByRole('group', { name: '重复星期', exact: true });
  await expect(weekdays.getByRole('checkbox')).toHaveCount(7);
  for (const day of ['周日', '周一', '周二', '周三', '周四', '周五', '周六'])
    await weekdays.getByRole('checkbox', { name: day, exact: true }).uncheck();
  await weekdays.getByRole('checkbox', { name: '周一', exact: true }).check();
  await weekdays.getByRole('checkbox', { name: '周三', exact: true }).check();
  for (const size of sizes) {
    await page.setViewportSize(size);
    await weekdays.scrollIntoViewIfNeeded();
    const metrics = await weekdays.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const labels = [...element.querySelectorAll<HTMLElement>(':scope > .ant-checkbox-wrapper')];
      return {
        left: bounds.left,
        right: bounds.right,
        width: innerWidth,
        overflowX: element.scrollWidth - element.clientWidth,
        labels: labels.map((label) => {
          const checkbox = label.querySelector('.ant-checkbox-inner')!.getBoundingClientRect();
          const text = label.querySelector(':scope > span:last-child')!.getBoundingClientRect();
          const box = label.getBoundingClientRect();
          return {
            centerGap: Math.abs(checkbox.top + checkbox.height / 2 - text.top - text.height / 2),
            height: box.height,
            flexDirection: getComputedStyle(label).flexDirection,
          };
        }),
      };
    });
    expect(metrics.left).toBeGreaterThanOrEqual(0);
    expect(metrics.right).toBeLessThanOrEqual(metrics.width);
    expect(metrics.overflowX).toBeLessThanOrEqual(1);
    for (const label of metrics.labels) {
      expect(label.flexDirection).toBe('row');
      expect(label.centerGap).toBeLessThanOrEqual(1);
      expect(label.height).toBeGreaterThanOrEqual(36);
    }
    await expect(weekdays.getByRole('checkbox', { name: '周一', exact: true })).toBeChecked();
    await expect(weekdays.getByRole('checkbox', { name: '周三', exact: true })).toBeChecked();
    await expect(detail.getByRole('button', { name: '取消', exact: true })).toBeInViewport();
    await expect(detail.getByRole('button', { name: '创建任务', exact: true })).toBeInViewport();
    await expect(detail.getByRole('button', { name: '创建任务', exact: true })).toBeEnabled();
    await page.screenshot({
      path: info.outputPath('weekly-options-' + size.width + '.png'),
      animations: 'disabled',
    });
  }
  await detail.getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await expect(detail).toBeHidden();
  await page.getByRole('button', { name: '任务草稿', exact: true }).click();
  await page.getByRole('menuitem').filter({ hasText: title }).click();
  await expect(detail.getByRole('textbox', { name: '任务标题', exact: true })).toHaveValue(title);
  await expect(detail.getByRole('textbox', { name: '任务说明', exact: true })).toHaveValue(
    description,
  );
  await detail.locator('.ant-collapse-header').filter({ hasText: '更多选项' }).click();
  await expect(weekdays.getByRole('checkbox', { name: '周一', exact: true })).toBeChecked();
  await expect(weekdays.getByRole('checkbox', { name: '周三', exact: true })).toBeChecked();
  await expect(weekdays.getByRole('checkbox', { name: '周二', exact: true })).not.toBeChecked();
  expect(writes).toBe(0);
});
