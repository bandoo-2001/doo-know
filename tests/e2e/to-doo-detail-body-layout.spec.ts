import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

test('task detail aligns priority, groups shortcuts and keeps long child icons readable', async ({
  page,
}, info) => {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const command = async (payload: Record<string, unknown>) => {
    const response = await page.request.post('/api/to-doo/commands', {
      headers: { origin: String(info.project.use.baseURL), 'x-csrf-token': csrf.token },
      data: { requestId: crypto.randomUUID(), action: 'create_task', payload },
    });
    expect(response.ok(), await response.text()).toBe(true);
    return (await response.json()).ids[0] as string;
  };
  const tree = await (await page.request.get('/api/tree')).json();
  const walk = (entries: any[]): any[] =>
    entries.flatMap((entry) => (entry.type === 'folder' ? walk(entry.children || []) : [entry]));
  const note = walk(tree).find((entry) => entry.id);
  const title = '检查任务详情正文 ' + info.project.name;
  const parent = await command({
    title,
    priority: 'normal',
    description: '正文说明应与标题对齐，并保留原有输入。',
    noteRefs: [{ noteId: note.id, role: 'material', title: '资料名称'.repeat(30) }],
    reminders: [
      { id: crypto.randomUUID(), anchor: 'due', offsetMinutes: -15 },
      { id: crypto.randomUUID(), anchor: 'due', offsetMinutes: -30 },
    ],
  });
  for (let i = 0; i < 3; i++)
    await command({ parentTaskId: parent, title: 'LongChildTitle'.repeat(17) + ' ' + i });
  let writes = 0;
  await page.route('**/api/to-doo/commands', async (route) => {
    writes++;
    await route.abort();
  });
  const sizes =
    info.project.name === 'desktop'
      ? [
          { width: 1920, height: 1080 },
          { width: 1280, height: 900 },
        ]
      : [
          { width: 390, height: 844 },
          { width: 320, height: 568 },
        ];
  await page.setViewportSize(sizes[0]);
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&taskFilter=all&task=' + parent);
  const detail = page.getByRole('complementary', { name: '任务详情', exact: true });
  await expect(detail.getByRole('textbox', { name: '任务标题', exact: true })).toHaveValue(title);
  const children = detail.locator('.todo-primary-children .todo-saved-row');
  await expect(children).toHaveCount(3);
  for (const size of sizes) {
    await page.setViewportSize(size);
    const priority = detail.getByRole('button', { name: '编辑优先级', exact: true });
    await priority.scrollIntoViewIfNeeded();
    const value = priority.locator('.todo-task-value-label');
    await expect(value).toHaveCSS('display', 'flex');
    const a = (await value.locator('svg').boundingBox())!,
      b = (await value.locator('span').boundingBox())!;
    expect(Math.abs(a.y + a.height / 2 - b.y - b.height / 2)).toBeLessThanOrEqual(1);
    expect(a.x + a.width).toBeLessThanOrEqual(b.x);
    const shortcuts = detail.getByRole('group', { name: '任务快捷设置', exact: true });
    await shortcuts.scrollIntoViewIfNeeded();
    const bodyWidth = await detail.locator('.todo-detail-body').evaluate((el) => el.clientWidth);
    const buttons = await shortcuts.getByRole('button').all();
    expect(buttons).toHaveLength(4);
    const boxes = await Promise.all(buttons.map((button) => button.boundingBox()));
    if (bodyWidth <= 400) {
      expect(boxes[0]!.y).toBeCloseTo(boxes[1]!.y, 0);
      expect(boxes[2]!.y).toBeCloseTo(boxes[3]!.y, 0);
      expect(boxes[2]!.y).toBeGreaterThan(boxes[0]!.y);
      expect(boxes[0]!.x).toBeCloseTo(boxes[2]!.x, 0);
    } else for (const box of boxes) expect(box!.y).toBeCloseTo(boxes[0]!.y, 0);
    for (const child of await children.all()) {
      await child.scrollIntoViewIfNeeded();
      const icon = child.locator(':scope > svg');
      const bounds = (await icon.boundingBox())!;
      expect(bounds.width).toBeCloseTo(14, 0);
      expect(bounds.height).toBeCloseTo(14, 0);
      expect(await child.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(
        1,
      );
    }
    const resource = detail.locator('.todo-primary-resources .todo-link');
    await resource.scrollIntoViewIfNeeded();
    await expect(resource.locator('svg')).toHaveCount(2);
    await expect(resource).not.toContainText('↗');
    expect(
      await detail.locator('.todo-detail-body').evaluate((el) => el.scrollWidth - el.clientWidth),
    ).toBeLessThanOrEqual(1);
    await expect(detail.getByRole('button', { name: '关闭', exact: true })).toBeInViewport();
    await expect(detail.getByRole('button', { name: '保存任务', exact: true })).toBeDisabled();
    await page.screenshot({
      path: info.outputPath('detail-body-' + size.width + '.png'),
      animations: 'disabled',
    });
  }
  expect(writes).toBe(0);
});
