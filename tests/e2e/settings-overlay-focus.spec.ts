import { readFile } from 'node:fs/promises';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../support/browser-test';

test.use({ actionTimeout: 7000 });

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

async function finishTransitions(page: Page) {
  await page.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => {
          const end = animation.effect?.getComputedTiming().endTime;
          return (
            animation.playState === 'running' && typeof end === 'number' && Number.isFinite(end)
          );
        })
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
}

async function expectFocusInside(dialog: Locator) {
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
}

for (const viewport of [
  { width: 320, height: 740 },
  { width: 390, height: 844 },
  { width: 1440, height: 1000 },
]) {
  test.describe(`${viewport.width}px settings overlay focus`, () => {
    test.use({ viewport });

    // A surface the focus trap cannot recognize steals real keyboard input,
    // even though locator.fill() can still set the input's value.
    test('password modal accepts keyboard input, traps both Tab directions and returns focus after discarding', async ({
      page,
    }) => {
      let changes = 0;
      page.on('request', (request) => {
        if (
          request.method() === 'POST' &&
          new URL(request.url()).pathname === '/api/auth/change-password'
        )
          changes++;
      });
      await page.goto('/?view=settings&section=account');
      const open = page.getByRole('button', { name: '修改密码', exact: true });
      await open.click();
      const dialog = page.getByRole('dialog', { name: '修改密码', exact: true });
      await expect(dialog).toBeVisible();
      await finishTransitions(page);
      const current = dialog.getByLabel('当前密码', { exact: true });
      const next = dialog.getByLabel('新密码', { exact: true });
      const confirmation = dialog.getByLabel('确认新密码', { exact: true });
      await expect.soft(current).toBeFocused({ timeout: 1000 });
      await current.click();
      await page.keyboard.type('fixture-current');
      await expect(current).toHaveValue('fixture-current');
      await expect(current).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(next).toBeFocused();
      await page.keyboard.type('fixture-next');
      await expect(next).toHaveValue('fixture-next');
      await page.keyboard.press('Tab');
      await expect(confirmation).toBeFocused();
      await page.keyboard.type('fixture-next');
      await expect(confirmation).toHaveValue('fixture-next');
      await page.keyboard.press('Shift+Tab');
      await expect(next).toBeFocused();

      const close = dialog.getByRole('button', { name: '关闭修改密码', exact: true });
      const submit = dialog.getByRole('button', { name: '更新密码', exact: true });
      await submit.focus();
      await page.keyboard.press('Tab');
      await expectFocusInside(dialog);
      await close.focus();
      await page.keyboard.press('Shift+Tab');
      await expectFocusInside(dialog);
      await open.focus();
      await expectFocusInside(dialog);

      await page.keyboard.press('Escape');
      const discard = dialog.getByRole('alert').filter({ hasText: '有未保存的更改' });
      await expect(discard).toBeVisible();
      await expect(dialog).toBeVisible();
      await discard.getByRole('button', { name: '继续编辑', exact: true }).click();
      await current.click();
      await page.keyboard.press('End');
      await page.keyboard.type('-kept');
      await expect(current).toHaveValue('fixture-current-kept');
      await page.keyboard.press('Escape');
      await discard.getByRole('button', { name: '放弃更改', exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(open).toBeFocused();
      await open.click();
      await finishTransitions(page);
      for (const field of [current, next, confirmation]) await expect(field).toHaveValue('');
      await expect(current).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(open).toBeFocused();
      expect(changes).toBe(0);
    });

    test('busy modal ignores Escape and mask dismissal until the rejected request settles', async ({
      page,
    }) => {
      // Hold only the account mutation boundary: this exercises the real busy
      // UI without sending a password change to the fixture account.
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route('**/api/auth/change-password', async (route) => {
        await held;
        await route.fulfill({ status: 400, json: { message: 'Disposable rejected request' } });
      });
      try {
        await page.goto('/?view=settings&section=account');
        const open = page.getByRole('button', { name: '修改密码', exact: true });
        await open.click();
        const dialog = page.getByRole('dialog', { name: '修改密码', exact: true });
        await expect(dialog).toBeVisible();
        await finishTransitions(page);
        await dialog.getByLabel('当前密码', { exact: true }).fill('disposable-current');
        await dialog.getByLabel('新密码', { exact: true }).fill('Disposable-Unapplied-Password-1!');
        await dialog
          .getByLabel('确认新密码', { exact: true })
          .fill('Disposable-Unapplied-Password-1!');
        await dialog.getByRole('button', { name: '更新密码', exact: true }).click();
        await expect(dialog).toHaveAttribute('aria-busy', 'true');
        await expect(
          dialog.getByRole('button', { name: '关闭修改密码', exact: true }),
        ).toBeDisabled();
        await expect(dialog.getByLabel('当前密码', { exact: true })).toBeDisabled();
        await page.keyboard.press('Escape');
        await expect(dialog).toBeVisible();
        await page.mouse.click(1, 1);
        await expect(dialog).toBeVisible();
        await expect(dialog).toHaveAttribute('aria-busy', 'true');
        await expect(dialog.locator('.settings-discard-prompt')).toHaveCount(0);
        release();
        await expect(dialog).toHaveAttribute('aria-busy', 'false');
        await page.keyboard.press('Escape');
        await dialog.getByRole('button', { name: '放弃更改', exact: true }).click();
        await expect(dialog).toBeHidden();
        await expect(open).toBeFocused();
      } finally {
        release();
      }
    });

    test('import drawer keeps Ant select popup and keyboard focus inside its surface', async ({
      page,
    }) => {
      await page.goto('/?view=settings&section=library');
      const open = page.getByRole('button', { name: '批量导入', exact: true });
      await open.click();
      const dialog = page.getByRole('dialog', { name: '批量导入', exact: true });
      await expect(dialog).toBeVisible();
      await finishTransitions(page);
      const destination = dialog.getByLabel('导入到知识库目录', { exact: true });
      await destination.click();
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.type('00-Inbox');
      await expect(destination).toHaveValue('00-Inbox');
      await expect(destination).toBeFocused();
      const collision = dialog.getByRole('combobox', { name: '遇到同名文件', exact: true });
      await dialog.getByTitle('跳过已有文件', { exact: true }).click();
      const option = dialog.getByTitle('自动使用新文件名', { exact: true });
      await expect(option).toBeVisible();
      await expectFocusInside(dialog);
      await option.click();
      await expect(
        dialog.locator('.ant-select-selection-item').filter({ hasText: '自动使用新文件名' }),
      ).toBeVisible();
      await collision.focus();
      await page.keyboard.press('Tab');
      await expectFocusInside(dialog);
      await page.keyboard.press('Shift+Tab');
      await expect(collision).toBeFocused();
      await page.keyboard.press('Escape');
      await dialog.getByRole('button', { name: '放弃更改', exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(open).toBeFocused();
    });

    test('Git drawer keeps keyboard focus and its draft through credential modal cancellation', async ({
      page,
    }) => {
      let mutations = 0;
      page.on('request', (request) => {
        if (
          request.method() === 'POST' &&
          /\/api\/platform\/git\/(credentials|jobs)$/.test(new URL(request.url()).pathname)
        )
          mutations++;
      });
      await page.goto('/?view=settings&section=library');
      const panel = page.getByRole('region', { name: '云端同步面板', exact: true });
      const open = panel.getByRole('button', { name: /^(管理同步|关联云端仓库)$/ });
      await expect(
        panel.getByRole('button', { name: '刷新同步状态', exact: true }),
      ).not.toHaveClass(/ant-btn-loading/);
      await open.click();
      const drawer = page.getByRole('dialog', { name: '管理云端同步', exact: true });
      await expect(drawer).toBeVisible();
      await finishTransitions(page);
      const url = drawer.getByLabel('仓库克隆地址', { exact: true });
      await expect(url).toBeFocused();
      await page.keyboard.type('https://github.com/disposable-fixture/focus.git');
      await expect(url).toHaveValue('https://github.com/disposable-fixture/focus.git');
      await page.keyboard.press('Tab');
      const branch = drawer.getByLabel('云端分支（选填）', { exact: true });
      await expect(branch).toBeFocused();
      await page.keyboard.type('focus-draft');
      await expect(branch).toHaveValue('focus-draft');
      await page.keyboard.press('Shift+Tab');
      await expect(url).toBeFocused();
      const drawerClose = drawer.getByRole('button', { name: '关闭管理云端同步', exact: true });
      await drawerClose.focus();
      await page.keyboard.press('Shift+Tab');
      await expectFocusInside(drawer);
      await page.keyboard.press('Tab');
      await expectFocusInside(drawer);

      await drawer.getByRole('button', { name: '添加凭据', exact: true }).click();
      const credential = page.getByRole('dialog', { name: '添加凭据', exact: true });
      await expect(credential).toBeVisible();
      await finishTransitions(page);
      const name = credential.getByLabel('凭据名称', { exact: true });
      await expect(name).toBeFocused();
      await page.keyboard.type('Unsaved keyboard fixture');
      await expect(name).toHaveValue('Unsaved keyboard fixture');
      const token = credential.getByLabel('访问令牌', { exact: true });
      await token.click();
      await page.keyboard.type('disposable-unapplied-token');
      await expect(token).toHaveValue('disposable-unapplied-token');
      await credential.getByRole('button', { name: '取消编辑凭据', exact: true }).click();
      await credential.getByRole('button', { name: '放弃修改', exact: true }).click();
      await expect(drawer).toBeVisible();
      await finishTransitions(page);
      await expect(url).toHaveValue('https://github.com/disposable-fixture/focus.git');
      await expect(branch).toHaveValue('focus-draft');
      await url.click();
      await page.keyboard.press('End');
      await page.keyboard.type('-kept');
      await expect(url).toHaveValue('https://github.com/disposable-fixture/focus.git-kept');
      await expectFocusInside(drawer);
      await drawerClose.click();
      await drawer.getByRole('button', { name: '放弃更改', exact: true }).click();
      await expect(drawer).toBeHidden();
      await expect(open).toBeFocused();
      expect(mutations).toBe(0);
    });
  });
}
