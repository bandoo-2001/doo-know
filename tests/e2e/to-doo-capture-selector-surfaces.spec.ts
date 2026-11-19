import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});
test('the note capture dialog retains its title and description when its list tree dismisses first', async ({ page }) => {
  await page.goto('/?view=apps&app=to-doo&appSection=tasks');
  await expect(page.locator('.to-doo-workspace')).toBeVisible();
  let writes = 0;
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/to-doo/commands')) writes++; });
  await page.evaluate(async () => {
    const runtimePath = '/plugin-runtime.ts';
    const capturePath = '/components/to-doo/ToDooCaptureDialog.vue';
    const selectorPath = '/components/to-doo/ToDooListTreeSelect.vue';
    const { createApp, h, ref } = await import(runtimePath);
    const Capture = (await import(capturePath)).default;
    const Selector = (await import(selectorPath)).default;
    const original = document.getElementById('app');
    if (original) original.style.display = 'none';
    const host = document.createElement('div'); document.body.appendChild(host);
    const open = ref(true), selected = ref(null as string | null);
    createApp({ render: () => h(Capture, { open: open.value, busy: false, 'onUpdate:open': (value: boolean) => open.value = value }, {
      default: () => h('form', { onSubmit: (event: Event) => event.preventDefault() }, [
        h('label', ['任务标题', h('input', { 'aria-label': '任务标题', value: '保留资料中的任务' })]),
        h('label', ['目标或清单', h(Selector, { lists: [
          { id: 'reading', name: '阅读', icon: '📚', color: '#4f8c7a' },
        ], allowCreate: false, modelValue: selected.value, 'aria-label': '目标或清单',
          'onUpdate:modelValue': (value: string | null) => selected.value = value })]),
        h('label', ['行动说明', h('textarea', { 'aria-label': '行动说明', value: '这段说明不能因关闭选择器而丢失。' })]),
      ]),
    }) }).mount(host);
  });
  const dialog = page.getByRole('dialog', { name: '从资料创建任务', exact: true });
  const input = dialog.getByRole('combobox', { name: '目标或清单', exact: true });
  const selector = input.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " ant-select ")][1]');
  await selector.locator('.ant-select-selector').click();
  const popup = page.locator('.todo-list-tree-popup:visible');
  await expect(popup.locator('[data-list-id="reading"] .todo-list-icon')).toHaveText('📚');
  await input.press('Escape');
  await expect(popup).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('任务标题', { exact: true })).toHaveValue('保留资料中的任务');
  await expect(dialog.getByLabel('行动说明', { exact: true })).toHaveValue('这段说明不能因关闭选择器而丢失。');
  expect(writes).toBe(0);
});
