import { test, expect } from '../support/browser-test';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { closeSidebar, showSidebar } from '../support/settings-navigation';
import type { Locator, Page } from '@playwright/test';

async function scrollDown(
  page: Page,
  target: Locator,
  touch: boolean,
  start?: { x: number; y: number },
) {
  const box = (await target.boundingBox())!;
  const x = Math.round(start?.x ?? box.x + box.width - 24);
  const y = Math.round(start?.y ?? box.y + box.height - 40);
  if (touch) {
    const session = await page.context().newCDPSession(page);
    try {
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x, y, id: 1 }],
      });
      // Deliver an actual finger swipe over several frames, not a scrollTop assignment.
      for (let step = 1; step <= 8; step++) {
        await session.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x, y: y - step * 30, id: 1 }],
        });
        await page.waitForTimeout(20);
      }
      // Pause before lifting the finger so inertia does not leak into the next navigation.
      await page.waitForTimeout(100);
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } finally {
      await session.detach();
    }
  } else {
    await page.mouse.move(x, y);
    await page.mouse.wheel(0, 1600);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
  }
}

test.beforeEach(async ({ page, context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.setViewportSize({
    width: test.info().project.name === 'mobile' ? 390 : 1000,
    height: 420,
  });
});

test('all settings sections scroll with actual wheel or touch input and keep content inside the workspace', async ({
  page,
}, info) => {
  test.setTimeout(90000);
  for (const section of ['editor', 'library', 'search', 'backup', 'plugins', 'account', 'about']) {
    await test.step(section, async () => {
      await page.goto('/?view=settings&section=' + section);
      // The initial empty-workspace heading can appear before the requested route is restored.
      await expect(page.locator('.settings-workspace h1')).toBeVisible();
      await closeSidebar(page);
      const root = page.locator('.main-content');
      await expect(root.locator('h1')).toBeVisible();
      if (section === 'backup') {
        for (const name of ['刷新备份记录', '刷新任务'])
          await expect(root.getByRole('button', { name, exact: true })).not.toHaveClass(
            /ant-btn-loading/,
          );
      }
      if (section === 'plugins') {
        await expect(root.getByRole('button', { name: '刷新插件状态', exact: true })).toBeEnabled();
        if (await root.locator('.plugin-empty').isVisible()) {
          const add = root.getByRole('tab', { name: '添加插件', exact: true });
          if (info.project.name === 'mobile') await add.tap();
          else await add.click();
        }
        await expect(root.locator('.plugin-card').first()).toBeVisible();
      }
      await expect(async () => {
        const bounds = (await root.boundingBox())!;
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(421);
      }).toPass({ timeout: 3000 });
      const hasOverflow = await root.evaluate((el) => el.scrollHeight > el.clientHeight + 2);
      if (!hasOverflow) {
        // Empty sections can fit entirely; there must be no clipped outer-page content.
        expect(
          await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1),
        ).toBe(true);
        return;
      }
      if (section === 'plugins' && info.project.name === 'mobile') {
        const nav = (await root.locator('.ant-tabs-nav-wrap').boundingBox())!;
        await scrollDown(page, root, true, { x: nav.x + nav.width / 2, y: nav.y + nav.height / 2 });
      } else await scrollDown(page, root, info.project.name === 'mobile');
      await expect.poll(() => root.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
      for (let attempt = 0; attempt < 48; attempt++) {
        if (await root.evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 2))
          break;
        await scrollDown(page, root, info.project.name === 'mobile');
      }
      await expect(async () => {
        if (await root.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop > 2))
          await scrollDown(page, root, info.project.name === 'mobile');
        expect(
          await root.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop),
        ).toBeLessThanOrEqual(2);
      }).toPass({ timeout: 5000 });
      expect(
        await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1),
      ).toBe(true);
    });
  }
  if (info.project.name === 'mobile')
    await expect(page.getByRole('button', { name: '打开侧栏', exact: true })).toBeInViewport();
  await showSidebar(page);
  await page
    .getByRole('navigation', { name: '设置分类', exact: true })
    .getByRole('button', { name: '通用与编辑', exact: true })
    .click();
  await expect(page.locator('.settings-workspace h1')).toHaveText('编辑器与外观');
  await expect.poll(() => page.locator('.main-content').evaluate((el) => el.scrollTop)).toBe(0);
});

test('trash contents scroll using actual wheel or touch gestures', async ({ page }, info) => {
  // Use the real create/delete APIs so the trash view exercises its usual cards and controls.
  await page.goto('/');
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const headers = { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token };
  const prefix = 'scroll-trash-' + crypto.randomUUID();
  for (let index = 0; index < 8; index++) {
    const created = await page.request.post('/api/notes', {
      headers,
      data: {
        folderPath: '00-Inbox',
        fileName: `${prefix}-${index}.md`,
        content: '# Scroll fixture',
        requestId: crypto.randomUUID(),
      },
    });
    expect(created.status()).toBe(201);
    const note = await created.json();
    const deleted = await page.request.delete('/api/notes/' + note.id, {
      headers,
      data: {
        noteId: note.id,
        expectedModifiedAt: note.modifiedAt,
        requestId: crypto.randomUUID(),
      },
    });
    expect(deleted.ok()).toBe(true);
  }
  await page.goto('/?view=trash');
  await closeSidebar(page);
  const root = page.locator('.main-content');
  await expect(page.locator('.trash-workspace')).toBeVisible();
  await expect(root.locator('.trash-item').filter({ hasText: prefix })).toHaveCount(8);
  await scrollDown(page, root, info.project.name === 'mobile');
  await expect.poll(() => root.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1)).toBe(
    true,
  );
});

test('folder contents retain independent wheel and touch scrolling', async ({ page }, info) => {
  const { knowledgeRoot } = JSON.parse(await readFile('.local/e2e-config.json', 'utf8'));
  const names = Array.from(
    { length: 32 },
    (_, index) => `scroll-folder-${crypto.randomUUID()}-${index}.md`,
  );
  try {
    await Promise.all(
      names.map((name) => writeFile(join(knowledgeRoot, '00-Inbox', name), '# Folder scroll')),
    );
    await page.goto('/?folder=00-Inbox');
    await closeSidebar(page);
    const root = page.locator('.folder-view');
    await expect(root).toBeVisible();
    await scrollDown(page, root, info.project.name === 'mobile');
    await expect.poll(() => root.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1),
    ).toBe(true);
  } finally {
    await Promise.all(
      names.map((name) => rm(join(knowledgeRoot, '00-Inbox', name), { force: true })),
    );
  }
});
