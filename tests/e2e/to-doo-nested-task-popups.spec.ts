import { readFile } from 'node:fs/promises';
import type { Locator } from '@playwright/test';
import { toDooEntitySchemas } from '../../shared/to-doo-contracts';
import { test, expect } from '../support/browser-test';

test.beforeEach(async ({ context, page }, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  if (info.project.name === 'desktop') await page.setViewportSize({ width: 1920, height: 1080 });
});

async function settleDialog(dialog: Locator) {
  await expect(dialog).toBeVisible();
  const surface = dialog.locator('.ant-modal');
  await surface.evaluate(async (element) => {
    for (let frame = 0; frame < 3; frame++)
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await Promise.all(
      element
        .getAnimations({ subtree: true })
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
  await expect(surface).toHaveCSS('transform', 'none');
  await expect(surface).toHaveCSS('opacity', '1');
}

async function scrollableModal(dialog: Locator) {
  const metrics = await dialog.locator('.ant-modal-content').evaluate((element) => {
    const box = element.getBoundingClientRect();
    const body = element.querySelector<HTMLElement>('.ant-modal-body')!;
    return {
      top: box.top,
      bottom: box.bottom,
      left: box.left,
      right: box.right,
      width: innerWidth,
      height: innerHeight,
      overflowX: body.scrollWidth - body.clientWidth,
      bodyHeight: body.clientHeight,
      scrollHeight: body.scrollHeight,
      bodyOverflow: getComputedStyle(body).overflowY,
    };
  });
  expect(metrics.top).toBeGreaterThanOrEqual(0);
  expect(metrics.bottom).toBeLessThanOrEqual(metrics.height);
  expect(metrics.left).toBeGreaterThanOrEqual(0);
  expect(metrics.right).toBeLessThanOrEqual(metrics.width);
  expect(metrics.overflowX).toBeLessThanOrEqual(1);
  expect(metrics.bodyOverflow).toBe('auto');
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.bodyHeight + 100);
}

test('advanced filters keep actions visible while long draft conditions scroll independently', async ({
  page,
}, info) => {
  let writes = 0;
  await page.route('**/api/to-doo/commands', async (route) => {
    writes++;
    await route.abort();
  });
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&taskFilter=all');
  const open = async () => {
    await page.getByRole('button', { name: '筛选', exact: true }).click();
    await page.getByRole('button', { name: '更多筛选条件', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '高级筛选', exact: true });
    await settleDialog(dialog);
    return dialog;
  };
  const dialog = await open();
  for (let i = 0; i < 20; i++)
    await dialog.getByRole('button', { name: '＋ 添加条件', exact: true }).click();
  await expect(dialog.locator('.todo-condition-controls')).toHaveCount(20);
  await scrollableModal(dialog);
  const footer = dialog.locator('.ant-modal-footer');
  const apply = footer.getByRole('button', { name: '应用条件组', exact: true });
  const cancel = footer.getByRole('button', { name: '取消', exact: true });
  await expect(apply).toBeInViewport();
  await expect(cancel).toBeInViewport();
  await dialog.locator('.ant-modal-body').evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(apply).toBeInViewport();
  await page.screenshot({
    path: info.outputPath('advanced-filter-footer.png'),
    animations: 'disabled',
  });
  await cancel.click();
  await expect(dialog).toBeHidden();
  const reopened = await open();
  await expect(reopened.locator('.todo-condition-controls')).toHaveCount(0);
  await reopened.locator('.ant-modal-close').click();
  expect(writes).toBe(0);
});

test('template picker wraps long names, scrolls long lists, and keeps its nested editor separate', async ({
  page,
}, info) => {
  const names = Array.from(
    { length: 40 },
    (_, i) => `复用模板 ${i} · ${'很长的模板名称'.repeat(15)}`,
  );
  let writes = 0;
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      writes++;
      await route.abort();
      return;
    }
    if (new URL(request.url()).pathname !== '/api/to-doo/state') {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    const snapshot = await response.json();
    snapshot.templates = names.map((name, i) =>
      toDooEntitySchemas.template.parse({
        id: 'nested-popup-template-' + i,
        name,
        tasks: [],
        revision: 'nested-popup-regression',
        createdAt: '2026-11-16T00:00:00Z',
        updatedAt: '2026-11-16T00:00:00Z',
      }),
    );
    await route.fulfill({ response, json: snapshot });
  });
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&taskFilter=all');
  await page.getByRole('button', { name: '任务显示与管理', exact: true }).click();
  await page
    .locator('.todo-task-management-options .ant-menu-submenu-title')
    .filter({ hasText: '模板' })
    .click();
  await page.getByRole('menuitem', { name: '从模板新建', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '从模板新建', exact: true });
  await settleDialog(dialog);
  await expect(dialog.locator('.todo-template-option')).toHaveCount(40);
  await scrollableModal(dialog);
  const lastRow = dialog.locator('.todo-template-option').last();
  await lastRow.scrollIntoViewIfNeeded();
  const name = lastRow.getByRole('button', { name: names[39], exact: true });
  const edit = lastRow.getByRole('button', { name: '编辑模板 ' + names[39], exact: true });
  await expect(name).toBeVisible();
  await expect(edit).toBeInViewport();
  const rowMetrics = await lastRow.evaluate((element) => {
    const name = element.querySelector<HTMLElement>('.todo-template-option-name')!;
    const edit = element.querySelector<HTMLElement>('.todo-icon-button')!;
    const nameBox = name.getBoundingClientRect(),
      editBox = edit.getBoundingClientRect();
    return {
      overflowX: name.scrollWidth - name.clientWidth,
      nameHeight: nameBox.height,
      lineHeight: parseFloat(getComputedStyle(name).lineHeight),
      centers: Math.abs(nameBox.y + nameBox.height / 2 - editBox.y - editBox.height / 2),
      overlap: nameBox.right - editBox.left,
    };
  });
  expect(rowMetrics.overflowX).toBeLessThanOrEqual(1);
  expect(rowMetrics.nameHeight).toBeGreaterThan(rowMetrics.lineHeight * 2);
  expect(rowMetrics.centers).toBeLessThanOrEqual(1);
  expect(rowMetrics.overlap).toBeLessThan(0);
  await expect(edit.locator('svg')).toHaveCount(1);
  await page.screenshot({
    path: info.outputPath('template-picker-long-names.png'),
    animations: 'disabled',
  });
  await edit.click();
  const editor = page.getByRole('dialog', { name: '编辑任务模板', exact: true });
  await settleDialog(editor);
  await editor.getByRole('button', { name: '关闭编辑', exact: true }).click();
  await expect(editor).toBeHidden();
  await expect(dialog).toBeVisible();
  expect(writes).toBe(0);
});
