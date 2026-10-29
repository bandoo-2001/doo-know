import { readFile } from 'node:fs/promises';
import type { Locator } from '@playwright/test';
import { test, expect } from '../support/browser-test';
import { closeSidebar } from '../support/settings-navigation';

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

async function expectUnobscured(control: Locator) {
  await expect(control).toBeInViewport({ ratio: 1 });
  await expect
    .poll(() =>
      control.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return !!hit && element.contains(hit);
      }),
    )
    .toBe(true);
}

test('editor preferences stay saveable while scrolling and survive reload', async ({
  page,
}, info) => {
  await page.goto('/?view=settings&section=editor');
  await expect(page.getByRole('heading', { name: '编辑与阅读', exact: true })).toBeVisible();
  await closeSidebar(page);
  const save = page.getByRole('button', { name: '保存偏好', exact: true });
  await page.screenshot({ path: info.outputPath('editor-initial.png'), animations: 'disabled' });
  await expectUnobscured(save);
  await expect(page.getByRole('region', { name: '编辑器显示预览', exact: true })).toBeHidden();

  const size = page.getByRole('combobox', { name: '文字大小', exact: true });
  const sizePicker = page.locator('.ant-select').filter({ has: size });
  await size.scrollIntoViewIfNeeded();
  await sizePicker.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await expect
    .poll(() => page.locator('.main-content').evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0);
  await expectUnobscured(sizePicker);
  await expectUnobscured(save);
  await page.screenshot({ path: info.outputPath('editor-scrolled.png'), animations: 'disabled' });
  await sizePicker.click();
  await page.locator('.ant-select-dropdown:visible').getByText('18 px', { exact: true }).click();
  await expectUnobscured(save);
  await save.click();
  await expect(page.getByRole('status').filter({ hasText: '编辑器偏好已保存' })).toBeVisible();
  await page.reload();
  await expect(
    page.locator('.ant-select').filter({ has: size }).locator('.ant-select-selection-item'),
  ).toHaveText('18 px');
  await page
    .locator('summary')
    .filter({ hasText: /^显示预览$/ })
    .click();
  await expect(page.getByRole('region', { name: '编辑器显示预览', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: '外观', exact: true }).focus();
  for (let step = 0; step < 6; step++) {
    await expectUnobscured(
      page.locator(
        '#editor-preferences-form .ant-select:focus-within, #editor-preferences-form .ant-switch:focus',
      ),
    );
    await page.keyboard.press('Shift+Tab');
  }
});

test('storage categories keep their amounts and file counts in a compact readable section', async ({
  page,
}, info) => {
  const mobile = info.project.name === 'mobile';
  await page.setViewportSize({ width: mobile ? 390 : 1280, height: mobile ? 844 : 720 });
  await page.goto('/?view=settings&section=library');
  const storage = page.getByRole('region', { name: '存储占用', exact: true });
  await expect(storage).toBeVisible();
  await closeSidebar(page);
  for (const category of [
    '笔记原文',
    '附件与其他文件',
    '历史版本',
    '回收站',
    '搜索索引',
    '检索模型',
    '升级备份',
  ]) {
    const label = storage.getByText(category, { exact: true });
    const row = label.locator('..');
    await expect(row).toContainText(/\d+(?:\.\d+)? (?:B|KiB|MiB|GiB|TiB)/);
    await expect(row).toContainText(/\d+ 个文件/);
    await row.scrollIntoViewIfNeeded();
    await expectUnobscured(label);
    expect(await row.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), category).toBe(true);
  }
  await storage.getByText('笔记原文', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('library-storage.png'), animations: 'disabled' });
  await expect
    .poll(async () => (await storage.boundingBox())!.height)
    .toBeLessThanOrEqual(mobile ? 500 : 450);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
    .toBe(true);
});

test('import and export cards stay readable at intermediate widths and open their workflows', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1100, height: 720 });
  await page.goto('/?view=settings&section=library');
  await expect(page.locator('.settings-workspace')).toBeVisible();
  await closeSidebar(page);
  const grid = page.locator('.transfer-action-grid');
  await grid.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('library-transfer.png'), animations: 'disabled' });
  for (const name of ['批量导入', '导出资料']) {
    const card = grid
      .locator('.settings-action-card')
      .filter({ has: page.getByRole('button', { name, exact: true }) });
    await expect
      .poll(() =>
        card.evaluate((element) => {
          const copy = element.querySelector('.settings-action-copy')!;
          const description = copy.querySelector('p')!;
          const button = element.querySelector('button')!;
          const cardBox = element.getBoundingClientRect();
          const copyBox = copy.getBoundingClientRect();
          const buttonBox = button.getBoundingClientRect();
          return {
            readable:
              description.getBoundingClientRect().width >= 180 ||
              buttonBox.top >= copyBox.bottom - 1,
            contained: [copy, description, button].every((child) => {
              const box = child.getBoundingClientRect();
              return (
                box.left >= cardBox.left &&
                box.right <= cardBox.right + 1 &&
                box.top >= cardBox.top &&
                box.bottom <= cardBox.bottom + 1 &&
                child.scrollWidth <= child.clientWidth + 1
              );
            }),
          };
        }),
      )
      .toEqual({ readable: true, contained: true });
    await card.getByRole('button', { name, exact: true }).click();
    const dialog = page.getByRole('dialog', { name, exact: true });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByLabel(name === '批量导入' ? '选择文件' : '导出范围', { exact: true }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  }
  await expect
    .poll(() =>
      page.locator('.settings-workspace').evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    )
    .toBe(true);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
    .toBe(true);
});
