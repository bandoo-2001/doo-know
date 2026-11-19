import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});
test('linked resources wrap long titles and reminder removal aligns with its select', async ({
  page,
}, info) => {
  await page.setViewportSize({
    width: info.project.name === 'mobile' ? 320 : 1920,
    height: info.project.name === 'mobile' ? 844 : 1080,
  });
  await page.goto('/?view=apps&app=to-doo&appSection=tasks');
  await expect(page.locator('.to-doo-workspace')).toBeVisible();
  let writes = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/to-doo/commands')) writes++;
  });
  await page.evaluate(async () => {
    const runtimePath = '/plugin-runtime.ts',
      dialogPath = '/components/to-doo/ToDooCaptureDialog.vue',
      formPath = '/components/to-doo/ToDooFormLayout.vue',
      notePath = '/components/to-doo/ToDooNotes.vue',
      reminderPath = '/components/to-doo/ToDooReminders.vue';
    const { createApp, h, ref } = await import(runtimePath);
    const Dialog = (await import(dialogPath)).default,
      Form = (await import(formPath)).default,
      Notes = (await import(notePath)).default,
      Reminders = (await import(reminderPath)).default;
    const original = document.getElementById('app');
    if (original) original.style.display = 'none';
    const host = document.createElement('div');
    document.body.appendChild(host);
    const tree = [1, 2, 3].map((index) => ({
      type: 'file',
      id: 'note-' + index,
      name: '关联资料标题与阅读摘录'.repeat(8) + index + '.md',
      path: '参考资料/' + '较长的目录名与完整路径'.repeat(8) + index + '.md',
    }));
    const links = ref([{ noteId: tree[0].id, title: tree[0].name, role: 'material' }]);
    const rules = ref([{ id: 'rule', anchor: 'due', offsetMinutes: -15, allDayTime: '09:00' }]);
    createApp({
      render: () =>
        h(
          Dialog,
          { open: true, busy: false },
          {
            default: () =>
              h(Form, {}, () => [
                h(Notes, {
                  modelValue: links.value,
                  tree,
                  'onUpdate:modelValue': (value: any) => (links.value = value),
                }),
                h(Reminders, {
                  modelValue: rules.value,
                  dateBased: false,
                  'onUpdate:modelValue': (value: any) => (rules.value = value),
                }),
              ]),
          },
        ),
    }).mount(host);
  });
  const dialog = page.getByRole('dialog', { name: '从资料创建任务', exact: true });
  const linked = dialog.locator('.todo-note-name');
  await expect(linked).toBeVisible();
  expect(
    await linked.evaluate((element) => element.scrollHeight - element.clientHeight),
  ).toBeLessThanOrEqual(1);
  await expect(linked.locator('.todo-note-open-icon')).toBeVisible();
  await dialog.getByRole('button', { name: '关联资料', exact: true }).click();
  const choices = dialog.locator('.todo-note-picker .ant-btn');
  await expect(choices).toHaveCount(2);
  for (const choice of await choices.all())
    expect(
      await choice.evaluate((element) => element.scrollHeight - element.clientHeight),
    ).toBeLessThanOrEqual(1);
  const row = dialog.locator('.todo-reminder-editor');
  const select = row.locator('.ant-select');
  const remove = row.getByRole('button', { name: '移除这一条提醒', exact: true });
  await remove.scrollIntoViewIfNeeded();
  const a = (await select.boundingBox())!,
    b = (await remove.boundingBox())!;
  expect(Math.abs(a.y + a.height / 2 - b.y - b.height / 2)).toBeLessThanOrEqual(1);
  await expect(remove.locator('svg')).toBeVisible();
  await page.screenshot({
    path: info.outputPath('common-controls-details.png'),
    animations: 'disabled',
  });
  expect(writes).toBe(0);
});
