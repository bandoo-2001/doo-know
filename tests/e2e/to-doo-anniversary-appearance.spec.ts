import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test, expect } from '../support/browser-test';

const evidence = resolve('docs/design/to-doo/two-level-implementation-2026-11-04/regression-screenshots/card-polish');
test.beforeEach(async ({ page, context }, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.setViewportSize({ width: info.project.name === 'mobile' ? 390 : 1440, height: 900 });
  await mkdir(evidence, { recursive: true });
});

test('card appearance previews live, saves, survives reload and can be edited independently', async ({
  page,
}, info) => {
  await page.goto('/?view=apps&app=to-doo&appSection=anniversaries');
  await page
    .getByRole('button', { name: /新建纪念日/ })
    .first()
    .click();
  const editor = page.getByRole('dialog', { name: '新建纪念日', exact: true });
  const name = '山野相逢 ' + crypto.randomUUID().slice(0, 4);
  await editor.getByLabel('名称', { exact: true }).fill(name);
  await editor.getByRole('button', { name: '远山', exact: true }).click();
  await editor.getByRole('button', { name: '青苔', exact: true }).click();
  const preview = editor.getByRole('article', { name: '卡片预览', exact: true });
  await expect(preview).toHaveAttribute('data-card-style', 'landscape');
  await expect(preview).toHaveAttribute('data-card-palette', 'sage');
  await expect(preview).toContainText(name);
  await page.screenshot({
    path: resolve(evidence, `${info.project.name}-appearance-editor.png`),
    fullPage: true,
  });
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(editor).not.toBeVisible();
  const card = page.getByRole('article', { name: '纪念日 ' + name, exact: true });
  await expect(card).toHaveAttribute('data-card-palette', 'sage');
  await page.reload();
  await expect(card).toHaveAttribute('data-card-style', 'landscape');
  const snapshot = await (
    await page.request.get('/api/to-doo/state?kind=anniversary&limit=200')
  ).json();
  expect(snapshot.anniversaries.find((a: any) => a.name === name)).toMatchObject({
    appearance: { style: 'landscape', palette: 'sage' },
  });
  await card.getByRole('button', { name: '编辑 ' + name, exact: true }).click();
  const edit = page.getByRole('dialog', { name: '编辑纪念日', exact: true });
  await expect(edit.getByRole('button', { name: '远山', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(edit.getByRole('button', { name: '青苔', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await edit.getByRole('button', { name: '星轨', exact: true }).click();
  await edit.getByRole('button', { name: '暮紫', exact: true }).click();
  await edit.getByRole('button', { name: '保存', exact: true }).click();
  await expect(edit).not.toBeVisible();
  await expect(card).toHaveAttribute('data-card-style', 'orbit');
  await page.reload();
  await expect(card).toHaveAttribute('data-card-palette', 'lavender');
});

test('legacy and artistic cards fit small screens with their dates and details in both themes', async ({
  page,
}, info) => {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const existing = await (
    await page.request.get('/api/to-doo/state?kind=anniversary&limit=200')
  ).json();
  const sample = [
    ['花开有时', 'bloom', 'rose'],
    ['山野散步', 'landscape', 'sage'],
    ['相遇在星光之下', 'orbit', 'lavender'],
    ['为平凡的一天留白', 'minimal', 'amber'],
    ['旧日记里的一个很长很长的名字，仍然值得好好记住', null, null],
  ];
  for (const [name, style, palette] of sample) {
    // Desktop and mobile share this isolated dataset; reuse the same showcase cards.
    const id = 'appearance-sample-' + (style || 'legacy');
    if (existing.anniversaries.some((entry: any) => entry.id === id)) continue;
    const response = await page.request.post('/api/to-doo/commands', {
      headers: { origin: String(info.project.use.baseURL), 'x-csrf-token': csrf.token },
      data: {
        requestId: crypto.randomUUID(),
        action: 'save_entity',
        payload: {
          kind: 'anniversary',
          entity: {
            id,
            name,
            date: '2027-03-21',
            category: '生活纪念',
            description: '把值得记住的日子，留在时间里。',
            ...(style ? { appearance: { style, palette } } : {}),
          },
        },
      },
    });
    expect(response.ok(), await response.text()).toBe(true);
  }
  await page.goto('/?view=apps&app=to-doo&appSection=anniversaries');
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate(async (theme) => {
      const modulePath = '/preferences.ts';
      (await import(modulePath)).setEditorPreferences({ theme });
      await document.fonts.ready;
    }, theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.getByRole('heading', { name: '花开有时', exact: true })).toBeVisible();
    await page.screenshot({
      path: resolve(evidence, `${info.project.name}-anniversaries-${theme}.png`),
      fullPage: true,
    });
    if (info.project.name === 'mobile') await page.setViewportSize({ width: 320, height: 844 });
    for (const [name] of sample) {
      const card = page.getByRole('article', { name: '纪念日 ' + name, exact: true });
      await expect(card).toContainText('2027-03-21');
      const bounds = await card.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(
        info.project.name === 'mobile' ? 320 : 1440,
      );
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  const legacy = page.getByRole('article', { name: '纪念日 ' + sample[4][0], exact: true });
  await legacy.getByText('查看详情', { exact: true }).click();
  await expect(legacy).toContainText('把值得记住的日子，留在时间里。');
});
