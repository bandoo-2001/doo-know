import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';

test.use({ sourceEditorPreference: true });

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

test('note capture keeps footer actions reachable and submits its associated form once without losing input', async ({
  page,
}, info) => {
  const title = '核对资料任务的固定操作区';
  const description = '这份资料的长说明应当独立滚动，并在选择清单或提交失败后保留。\n'.repeat(100);
  const submissions: any[] = [];
  let releaseSubmission: (() => void) | undefined;
  await page.route('**/api/to-doo/commands', async (route) => {
    submissions.push(route.request().postDataJSON());
    await new Promise<void>((resolve) => {
      releaseSubmission = resolve;
    });
    await route.fulfill({ status: 409, json: { error: '示例提交未保存，输入仍保留。' } });
  });
  await page.route('**/api/to-doo/state?**', async (route) => {
    if (new URL(route.request().url()).searchParams.get('kind') !== 'list') return route.continue();
    const response = await route.fetch();
    const snapshot = await response.json();
    snapshot.lists = [
      { id: 'capture-footer-list', name: '资料目录', color: '#647be8', icon: '📚', parentId: null },
    ];
    await route.fulfill({ response, json: snapshot });
  });
  const sizes =
    info.project.name === 'desktop'
      ? [{ width: 1920, height: 1080 }]
      : [
          { width: 390, height: 844 },
          { width: 320, height: 568 },
        ];
  await page.setViewportSize(sizes[0]);
  // Open the fixture's existing note through the real UI without writing a note or task.
  const tree = await (await page.request.get('/api/tree')).json();
  const walk = (entries: any[]): any[] =>
    entries.flatMap((entry) => (entry.type === 'folder' ? walk(entry.children || []) : [entry]));
  const note = walk(tree).find((entry) => entry.name === '入门指南.md');
  expect(note?.id).toBeTruthy();
  await page.goto('/?note=' + encodeURIComponent(note.id));
  await expect(page.locator('.cm-content')).toBeVisible();
  await page.getByRole('button', { name: '更多操作', exact: true }).click();
  await page.getByRole('button', { name: '创建关联任务', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '从资料创建任务', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: '任务标题', exact: true }).fill(title);
  await dialog.getByRole('textbox', { name: '行动说明', exact: true }).fill(description);
  const form = dialog.locator('form.to-doo-capture-form');
  const footer = dialog.locator('.ant-modal-footer');
  const submit = footer.locator('button[type="submit"]');
  const cancel = footer.getByRole('button', { name: '取消', exact: true });
  expect(await submit.evaluate((element: HTMLButtonElement) => element.form?.id)).toBe(
    await form.getAttribute('id'),
  );
  await expect(form.getByRole('button')).toHaveCount(0);
  for (const size of sizes) {
    await page.setViewportSize(size);
    await dialog.locator('.ant-modal').evaluate(async (element) => {
      for (let frame = 0; frame < 3; frame++)
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await Promise.all(
        element
          .getAnimations({ subtree: true })
          .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
          .map((animation) => animation.finished.catch(() => {})),
      );
    });
    const metrics = await dialog.locator('.ant-modal-content').evaluate((element) => {
      const box = element.getBoundingClientRect(),
        body = element.querySelector<HTMLElement>('.ant-modal-body')!;
      const footer = element
        .querySelector<HTMLElement>('.ant-modal-footer')!
        .getBoundingClientRect();
      return {
        top: box.top,
        bottom: box.bottom,
        left: box.left,
        right: box.right,
        width: innerWidth,
        height: innerHeight,
        bodyBottom: body.getBoundingClientRect().bottom,
        footerTop: footer.top,
        overflowX: body.scrollWidth - body.clientWidth,
      };
    });
    expect(metrics.top).toBeGreaterThanOrEqual(0);
    expect(metrics.top).toBe(size.width > 600 ? 40 : 12);
    expect(metrics.bottom).toBeLessThanOrEqual(metrics.height);
    expect(metrics.left).toBeGreaterThanOrEqual(0);
    expect(metrics.right).toBeLessThanOrEqual(metrics.width);
    expect(metrics.footerTop).toBeGreaterThanOrEqual(metrics.bodyBottom - 1);
    expect(metrics.overflowX).toBeLessThanOrEqual(1);
    await expect(submit).toBeInViewport();
    await expect(cancel).toBeInViewport();
    await dialog.locator('.ant-modal-body').evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(submit).toBeInViewport();
    await page.screenshot({
      path: info.outputPath('capture-task-footer-' + size.width + '.png'),
      animations: 'disabled',
    });
  }
  const list = dialog.getByRole('combobox', { name: '目标或清单', exact: true });
  await list
    .locator(
      'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " ant-select ")][1]',
    )
    .locator('.ant-select-selector')
    .click();
  const popup = page.locator('.todo-list-tree-popup:visible');
  await expect(popup.locator('[data-list-id="capture-footer-list"] .todo-list-icon')).toHaveText(
    '📚',
  );
  await list.press('Escape');
  await expect(popup).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: '任务标题', exact: true })).toHaveValue(title);
  await expect(dialog.getByRole('textbox', { name: '行动说明', exact: true })).toHaveValue(
    description,
  );
  const titleInput = dialog.getByRole('textbox', { name: '任务标题', exact: true });
  await titleInput.fill('');
  await expect(submit).toBeDisabled();
  await titleInput.fill(title);
  try {
    await submit.click();
    await expect.poll(() => submissions.length).toBe(1);
    await expect(submit).toBeDisabled();
    await expect(cancel).toBeDisabled();
    await expect(titleInput).toBeDisabled();
    await expect(dialog.getByRole('textbox', { name: '行动说明', exact: true })).toBeDisabled();
    await expect(dialog.locator('.ant-modal-close')).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
  } finally {
    releaseSubmission?.();
  }
  await expect(dialog.getByRole('alert')).toContainText('示例提交未保存，输入仍保留。');
  await expect(titleInput).toBeEnabled();
  await expect(titleInput).toHaveValue(title);
  await expect(dialog.getByRole('textbox', { name: '行动说明', exact: true })).toHaveValue(
    description,
  );
  expect(submissions).toHaveLength(1);
  expect(submissions[0]).toMatchObject({
    action: 'create_task',
    payload: { title, description, listId: null },
  });
  await expect(submit).toBeInViewport();
  await expect(cancel).toBeInViewport();
  await cancel.click();
  await expect(dialog).toBeHidden();
});
