import { readFile } from 'node:fs/promises';
import { expect, test } from '../support/browser-test';
import type { ToDooCommandResult } from '../../shared/to-doo-contracts';

test('task tools stay reachable beside long titles, and capture hints follow the input mode', async ({ page, context }, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const desktop = info.project.name === 'desktop';
  await page.setViewportSize(desktop ? { width: 1440, height: 900 } : { width: 390, height: 844 });
  const listName = '新品上线 · 产品设计与交付';
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  async function command(action: string, payload: Record<string, unknown>) {
    const response = await page.request.post('/api/to-doo/commands', {
      headers: { origin: String(info.project.use.baseURL), 'x-csrf-token': csrf.token },
      data: { action, requestId: crypto.randomUUID(), payload },
    });
    expect(response.ok(), await response.text()).toBe(true);
    return ((await response.json()) as ToDooCommandResult).ids[0]!;
  }
  const list = await command('save_entity', { kind: 'list', entity: { name: listName, color: '#467e72', kind: 'list' } });
  const title = '整理首轮访谈，确认首页的信息层级';
  await command('create_task', { listId: list, title, priority: 'high', description: '对照访谈笔记，整理用户进入首页后最先想做的三件事。' });
  for (const task of ['复核移动端的交互细节', '更新产品说明中的界面截图', '整理周五评审的反馈']) {
    await command('create_task', { listId: list, title: task });
  }
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&list=' + list);
  const main = page.locator('.todo-main');
  const heading = main.getByRole('heading', { name: listName, exact: true });
  await expect(heading).toBeVisible();
  await expect(main.locator('.todo-task-scope-icon')).toHaveCSS('--scope-color', '#467e72');
  const hint = main.locator('.todo-capture-shortcut');
  if (desktop) {
    await expect(hint).toBeVisible();
    await page.keyboard.press('q');
    await expect(main.getByRole('textbox', { name: '快速添加任务' })).toBeFocused();
    await expect(hint).toBeHidden();
    await heading.click();
  } else {
    await expect(hint).toBeHidden();
  }
  const row = main.getByRole('button', { name: title, exact: true });
  await expect(row).toBeVisible();
  for (const button of ['搜索任务', '筛选', '任务显示与管理']) {
    await expect(main.getByRole('button', { name: button, exact: true })).toBeInViewport();
  }
  await row.click();
  const reader = page.getByRole('complementary', { name: '任务详情', exact: true });
  await expect(reader.getByRole('textbox', { name: '任务标题' })).toHaveValue(title);
  const save = reader.getByRole('button', { name: '保存任务', exact: true });
  await expect(save).toBeDisabled();
  await expect(hint).toBeHidden();
  for (const theme of ['light', 'dark']) {
    await page.evaluate(async theme => {
      const path = '/preferences.ts';
      (await import(path)).setEditorPreferences({ theme });
      await document.fonts.ready;
    }, theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(save).toBeInViewport();
    await page.screenshot({ path: info.outputPath('reader-' + theme + '.png'), animations: 'disabled' });
  }
  await reader.getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await page.setViewportSize({ width: 320, height: 640 });
  const more = main.getByRole('button', { name: '任务显示与管理', exact: true });
  await expect(heading).toBeInViewport();
  await expect(more).toBeInViewport();
  await expect(main.locator('.todo-filter-toggle .todo-tool-label')).toBeHidden();
  expect(await main.evaluate(el => el.scrollWidth)).toBeLessThanOrEqual(320);
  await more.click();
  await expect(page.getByLabel('任务密度', { exact: true })).toBeVisible();
});
