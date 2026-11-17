import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

test('list range checkboxes keep parent, child and inbox scopes independent', async ({ page }) => {
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&taskFilter=all');
  await expect(
    page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true }),
  ).toBeVisible();
  let writes = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/to-doo/commands')) writes++;
  });
  // Exercise the reusable control independently of any one page's filtering behavior.
  await page.evaluate(async () => {
    const runtimePath = '/plugin-runtime.ts';
    const multiPath = '/components/to-doo/ToDooListTreeMultiSelect.vue';
    const singlePath = '/components/to-doo/ToDooListTreeSelect.vue';
    const { createApp, h, ref } = await import(runtimePath);
    const Multi = (await import(multiPath)).default;
    const Single = (await import(singlePath)).default;
    const original = document.getElementById('app');
    if (original) original.style.display = 'none';
    const host = document.createElement('div');
    host.id = 'list-control-inspection';
    host.style.cssText = 'padding:24px;max-width:390px;box-sizing:border-box';
    document.body.appendChild(host);
    const selected = ref([] as string[]),
      destination = ref(null as string | null);
    const lists = [
      { id: 'work', name: '工作', icon: 'folder', color: '#4566c6' },
      { id: 'reading', name: '阅读', parentId: 'work', icon: '📚', color: '#4f8c7a' },
    ];
    const model = {
      state: { busy: false, pendingMutation: null },
      taskLists: () => lists,
      ensureListCatalog: async () => {},
      saveEntity: async () => {
        throw Error('Selection must not create a list');
      },
    };
    createApp({
      render: () =>
        h('main', { style: 'display:grid;gap:24px' }, [
          h(Multi, {
            model,
            modelValue: selected.value,
            includeInbox: true,
            'aria-label': '清单范围',
            'onUpdate:modelValue': (value: string[]) => {
              selected.value = value;
            },
          }),
          h('output', { 'data-testid': 'selected-scopes' }, JSON.stringify(selected.value)),
          h(Single, {
            lists,
            modelValue: destination.value,
            allowCreate: false,
            nullLabel: '不关联',
            'aria-label': '只读清单选择',
            'onUpdate:modelValue': (value: string | null) => {
              destination.value = value;
            },
          }),
          h('output', { 'data-testid': 'selected-destination' }, JSON.stringify(destination.value)),
        ]),
    }).mount(host);
  });
  const input = page.getByRole('combobox', { name: '清单范围', exact: true });
  const select = input.locator(
    'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " ant-select ")][1]',
  );
  await select.locator('.ant-select-selector').click();
  const popup = page.locator('.todo-list-tree-multi-popup:visible');
  const row = (id: string) =>
    popup
      .locator(`[data-list-id="${id}"]`)
      .locator(
        'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " ant-select-tree-treenode ")][1]',
      );
  const parent = row('work').locator('.ant-select-tree-checkbox');
  const child = row('reading').locator('.ant-select-tree-checkbox');
  await parent.click();
  await expect(page.getByTestId('selected-scopes')).toHaveText('["work"]');
  await expect(child).not.toHaveClass(/ant-select-tree-checkbox-checked/);
  await child.click();
  await expect(page.getByTestId('selected-scopes')).toHaveText('["work","reading"]');
  await parent.click();
  await expect(page.getByTestId('selected-scopes')).toHaveText('["reading"]');
  await expect(select.locator('.todo-list-tree-tag .todo-list-icon')).toHaveText('📚');
  const inbox = popup
    .locator('.ant-select-tree-treenode')
    .filter({ hasText: '收集箱' })
    .locator('.ant-select-tree-checkbox');
  await inbox.click();
  await expect(page.getByTestId('selected-scopes')).toHaveText('["reading","inbox"]');
  await input.fill('工作 阅读');
  await expect(popup.locator('[data-list-id="reading"]')).toBeVisible();
  await input.press('Escape');
  await expect(popup).toBeHidden();
  const single = page.getByRole('combobox', { name: '只读清单选择', exact: true });
  await single
    .locator(
      'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " ant-select ")][1]',
    )
    .locator('.ant-select-selector')
    .click();
  const readOnlyPopup = page.locator('.todo-list-tree-popup:visible');
  await expect(readOnlyPopup.getByText('不关联', { exact: true })).toBeVisible();
  await expect(readOnlyPopup.locator('.todo-list-tree-add')).toHaveCount(0);
  await expect(readOnlyPopup.locator('.todo-list-tree-footer')).toHaveCount(0);
  await readOnlyPopup.locator('[data-list-id="reading"] .todo-list-tree-node-name').click();
  await expect(page.getByTestId('selected-destination')).toHaveText('"reading"');
  expect(writes).toBe(0);
});
