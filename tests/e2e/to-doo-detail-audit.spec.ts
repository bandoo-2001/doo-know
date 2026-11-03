import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { test, expect } from '../support/browser-test';
import { expandToDooGroup, fillToDooDate, selectToDooOption } from '../support/to-doo-ant-controls';

async function command(page: Page, action: string, payload: Record<string, unknown>) {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const response = await page.request.post('/api/to-doo/commands', {
    headers: { origin: String(test.info().project.use.baseURL), 'x-csrf-token': csrf.token },
    data: { requestId: crypto.randomUUID(), action, payload },
  });
  expect(response.ok()).toBe(true);
  return response.json();
}

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

test('moving a task to another list clears its old section and saves successfully', async ({
  page,
}, info) => {
  const suffix = info.project.name + '-' + crypto.randomUUID();
  const lists = [];
  for (const name of ['旧清单 ', '新清单 '])
    lists.push(
      await command(page, 'save_entity', {
        kind: 'list',
        entity: { name: name + suffix, kind: 'list' },
      }),
    );
  const section = await command(page, 'save_entity', {
    kind: 'section',
    entity: { listId: lists[0].ids[0], name: '旧章节 ' + suffix },
  });
  const result = await command(page, 'create_task', {
    title: '移动章节任务 ' + suffix,
    listId: lists[0].ids[0],
    sectionId: section.ids[0],
  });
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&taskFilter=all&task=' + result.ids[0]);
  const detail = page.getByRole('complementary', { name: '任务详情' });
  await selectToDooOption(detail, '所属目标或清单', '新清单 ' + suffix);
  await detail.getByRole('button', { name: '保存任务', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'To Doo 行动工作空间' }).getByRole('status'),
  ).toContainText('任务已保存');
  const state = await (await page.request.get('/api/to-doo/state?taskIds=' + result.ids[0])).json();
  expect(state.tasks.find((t: any) => t.id === result.ids[0])).toMatchObject({
    listId: lists[1].ids[0],
    sectionId: null,
  });
});

test('invalid typed deadline prevents saving an unrelated title change', async ({ page }, info) => {
  const title = '日期验证 ' + info.project.name + '-' + crypto.randomUUID();
  const result = await command(page, 'create_task', { title, due: { date: '2026-11-12' } });
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&taskFilter=all&task=' + result.ids[0]);
  const detail = page.getByRole('complementary', { name: '任务详情' });
  const writes: unknown[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/to-doo/commands'))
      writes.push(request.postDataJSON());
  });
  await detail.getByLabel('任务标题', { exact: true }).fill(title + ' 已改');
  await detail.getByRole('button', { name: '编辑截止日期', exact: true }).click();
  const date = detail.getByLabel('截止日期', { exact: true });
  await date.click();
  await date.fill('2026-99-99');
  await date.press('Tab');
  await detail.getByRole('button', { name: '保存任务', exact: true }).click();
  await expect(detail).toContainText('请检查');
  expect(writes).toEqual([]);
  await expect(detail).toContainText('未保存的更改');
  await fillToDooDate(date, '2026-11-13');
  await detail.getByRole('button', { name: '保存任务', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'To Doo 行动工作空间' }).getByRole('status'),
  ).toContainText('任务已保存');
});

test('input composition does not submit a task through the save shortcut', async ({
  page,
}, info) => {
  const title = '中文输入 ' + info.project.name + '-' + crypto.randomUUID();
  const result = await command(page, 'create_task', { title });
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&taskFilter=all&task=' + result.ids[0]);
  const detail = page.getByRole('complementary', { name: '任务详情' });
  const input = detail.getByLabel('任务标题', { exact: true });
  await input.fill(title + ' 草稿');
  const writes: unknown[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/to-doo/commands'))
      writes.push(request.postDataJSON());
  });
  await input.dispatchEvent('keydown', {
    key: 'Enter',
    code: 'Enter',
    ctrlKey: true,
    isComposing: true,
  });
  await expect(detail).toContainText('未保存的更改');
  expect(writes).toEqual([]);
  await input.press('Control+Enter');
  await expect(
    page.getByRole('region', { name: 'To Doo 行动工作空间' }).getByRole('status'),
  ).toContainText('任务已保存');
});

test('optional detail fields stay folded and remain editable when requested', async ({
  page,
}, info) => {
  if (info.project.name === 'desktop') await page.setViewportSize({ width: 1873, height: 978 });
  const initial = await (await page.request.get('/api/to-doo/state')).json();
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: initial.settings.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const result = await command(page, 'create_task', {
    title: '整理下周计划',
    plan: { date: today, time: '09:00', timeZone: initial.settings.timeZone },
  });
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&taskFilter=all&task=' + result.ids[0]);
  const detail = page.getByRole('complementary', { name: '任务详情' });
  await expect(detail.getByRole('button', { name: '编辑截止日期', exact: true })).not.toBeVisible();
  await expect(detail.getByLabel('截止日期', { exact: true })).not.toBeVisible();
  await expect(detail.getByRole('combobox', { name: '重要程度', exact: true })).not.toBeVisible();
  await expect(detail.getByRole('combobox', { name: '重复', exact: true })).not.toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('detail-compact.png'), fullPage: true });
  await detail.screenshot({ path: info.outputPath('detail-reader.png'), animations: 'disabled' });
  await detail.getByRole('button', { name: '添加属性', exact: true }).click();
  await page.getByRole('button', { name: '设置日期', exact: true }).click();
  await expect(detail.getByLabel('截止日期', { exact: true })).toBeVisible();
  await expandToDooGroup(detail, '四象限归类');
  await expect(detail.getByRole('combobox', { name: '重要程度', exact: true })).toBeVisible();
  await selectToDooOption(detail, '重要程度', '重要');
  await expandToDooGroup(detail, '重复规则');
  await selectToDooOption(detail, '重复', '每天');
  await expect(detail.getByLabel('开始日期', { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('detail-expanded.png'), fullPage: true });
});

test('320px dark detail keeps its fields and footer inside the screen', async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 844 });
  const result = await command(page, 'create_task', {
    title: '窄屏深色任务详情 ' + info.project.name,
  });
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&taskFilter=all&task=' + result.ids[0]);
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  const detail = page.getByRole('complementary', { name: '任务详情' });
  await expect(detail.getByLabel('任务标题', { exact: true })).toBeVisible();
  await expect(detail.getByRole('button', { name: '保存任务', exact: true })).not.toBeVisible();
  const selectedContrast = await detail
    .locator('.ant-select-selection-item')
    .first()
    .evaluate((item) => {
      const luminance = (color: string) => {
        const channels = color
          .match(/[\d.]+/g)!
          .slice(0, 3)
          .map((x) => {
            const channel = Number(x) / 255;
            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
          });
        return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
      };
      const foreground = luminance(getComputedStyle(item).color);
      const background = luminance(
        getComputedStyle(item.closest('.ant-select-selector')!).backgroundColor,
      );
      return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
    });
  expect(selectedContrast).toBeGreaterThanOrEqual(4.5);
  await detail
    .getByLabel('任务标题', { exact: true })
    .fill('窄屏深色任务详情 已修改 ' + info.project.name);
  for (const label of ['保存任务', '标记完成', '更多操作']) {
    const button = detail.getByRole('button', { name: label, exact: true });
    await expect(button).toBeInViewport();
    const box = (await button.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(320);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('detail-320-dark.png'), fullPage: true });
  await expandToDooGroup(detail, '更多选项：标签、提醒、依赖与来源');
  await expect(detail.getByRole('combobox', { name: '标签', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('narrow task detail contains keyboard focus and Escape keeps its draft', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const title = '键盘详情 ' + info.project.name + '-' + crypto.randomUUID();
  const result = await command(page, 'create_task', { title });
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&taskFilter=all');
  const open = page.getByRole('button', { name: title, exact: true });
  await open.click();
  const dialog = page.getByRole('dialog', { name: '任务编辑', exact: true });
  await expect(dialog).toBeVisible();
  const detail = dialog.getByRole('complementary', { name: '任务详情' });
  await expect(detail.getByLabel('任务标题', { exact: true })).toBeFocused();
  await detail.getByLabel('任务标题', { exact: true }).fill(title + ' 草稿');
  const last = detail.getByRole('button', { name: '更多操作', exact: true });
  await last.focus();
  await page.keyboard.press('Tab');
  await expect(detail.getByRole('button', { name: '关闭任务详情', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(last).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(open).toBeFocused();
  await open.click();
  await expect(detail.getByLabel('任务标题', { exact: true })).toHaveValue(title + ' 草稿');
});
