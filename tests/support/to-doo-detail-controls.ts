import { expect, type Page } from '@playwright/test';
import { fillToDooDate } from './to-doo-ant-controls';

const titles = {
  list: '所属清单', plan: '时间安排', due: '截止日期', priority: '优先级',
  repeat: '重复规则', reminders: '任务提醒', resources: '关联资料',
  classification: '四象限归类', results: '完成标准与成果', properties: '其他属性',
  history: '操作历史', attachments: '任务附件', records: '推进记录',
} as const;
export type ToDooDetailProperty = keyof typeof titles;

/** Navigate the same visible property entries used by mouse, keyboard and touch users. */
export async function openToDooDetailProperty(page: Page, panel: ToDooDetailProperty) {
  const modal = page.getByRole('dialog', { name: titles[panel], exact: true });
  if (await modal.isVisible()) return modal;
  const detail = page.getByRole('complementary', { name: '任务详情', exact: true });
  if (panel === 'list') await detail.locator('.todo-detail-context').getByRole('button').click();
  else {
    const direct: Partial<Record<ToDooDetailProperty, string>> = {
      plan: '编辑计划日期', due: '编辑截止日期', priority: '编辑优先级',
      repeat: '编辑重复规则', reminders: '编辑任务提醒', resources: '编辑关联资料',
    };
    if (direct[panel]) await detail.getByRole('button', { name: direct[panel], exact: true }).click();
    else {
      await detail.getByRole('button', { name: '更多任务属性', exact: true }).click();
      await page.getByRole('menuitem', { name: titles[panel], exact: true }).click();
    }
  }
  await expect(modal).toBeVisible();
  return modal;
}

/** Applying a field only changes the detail draft; callers explicitly save the task later. */
export async function completeToDooDetailProperty(page: Page) {
  const modal = page.locator('.todo-property-modal').getByRole('dialog');
  await modal.getByRole('button', { name: '完成设置', exact: true }).click();
  await expect(modal).not.toBeVisible();
}

export async function openToDooDetailPlan(page: Page, addIfEmpty = false) {
  const modal = await openToDooDetailProperty(page, 'plan');
  if (addIfEmpty && !await modal.locator('.todo-plan-editor').count())
    await modal.getByRole('button', { name: '＋ 添加一段时间', exact: true }).click();
  return modal;
}

export async function setToDooDetailPlanDate(page: Page, value: string) {
  const modal = await openToDooDetailPlan(page, !!value);
  await expect(modal.locator('.todo-plan-editor')).toHaveCount(1);
  if (value) await fillToDooDate(modal.getByLabel('日期', { exact: true }), value);
  else await modal.getByRole('button', { name: '移除这段安排', exact: true }).click();
  await completeToDooDetailProperty(page);
}
