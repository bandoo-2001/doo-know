import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';

test('share management distinguishes expired links and shows their permission and validity', async ({
  page,
  context,
}) => {
  const cookies = process.env.DOOKNOW_SHARE_E2E_COOKIES || '.local/e2e-cookies.json';
  await context.addCookies(JSON.parse(await readFile(cookies, 'utf8')));
  const items = [
    {
      id: 'expired-share',
      title: 'Expired shared document',
      relativePath: '00-Inbox/expired.md',
      enabled: false,
      state: 'expired',
      permission: 'edit',
      expiresAt: '2020-01-02T03:04:05.000Z',
      url: null,
    },
    {
      id: 'permanent-share',
      title: 'Permanent shared document',
      relativePath: '00-Inbox/permanent.md',
      enabled: true,
      state: 'active',
      permission: 'view',
      expiresAt: null,
      url: '/s/permanent-fixture',
    },
    {
      id: 'revoked-share',
      title: 'Revoked shared document',
      relativePath: '00-Inbox/revoked.md',
      enabled: false,
      state: 'revoked',
      permission: 'view',
      expiresAt: null,
      url: null,
    },
  ];
  await page.route('**/api/manage/shares**', (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const inactive = new URL(route.request().url()).searchParams.get('enabled') === 'false';
    return route.fulfill({
      json: { items: inactive ? items.filter((item) => !item.enabled) : items, nextCursor: null },
    });
  });
  await page.goto('/?view=settings&section=library');
  const card = page.locator('section.settings-card').filter({
    has: page.getByRole('heading', { name: '共享链接', exact: true }),
  });
  await expect(card).toBeVisible({ timeout: 15000 });
  const expired = card.getByRole('listitem').filter({ hasText: 'Expired shared document' });
  await expect(expired).toContainText('已过期');
  await expect(expired).toContainText('可编辑');
  await expect(expired).toContainText('2020');
  await expect(expired.getByRole('link', { name: '打开共享页面', exact: true })).toHaveCount(0);
  await expect(expired.getByRole('button', { name: '复制链接', exact: true })).toHaveCount(0);
  const permanent = card.getByRole('listitem').filter({ hasText: 'Permanent shared document' });
  await expect(permanent).toContainText('仅查看');
  await expect(permanent).toContainText('永久有效');
  await expect(permanent.getByRole('link', { name: '打开共享页面', exact: true })).toBeVisible();
  const revoked = card.getByRole('listitem').filter({ hasText: 'Revoked shared document' });
  await expect(revoked).toContainText('已撤销');
  await expect(revoked.getByRole('button', { name: '撤销', exact: true })).toHaveCount(0);

  await card.locator('.ant-select').click();
  await page
    .locator('.ant-select-dropdown:visible .ant-select-item-option-content')
    .filter({ hasText: /^已失效$/ })
    .click();
  const request = page.waitForRequest((item) => {
    const url = new URL(item.url());
    return url.pathname === '/api/manage/shares' && url.searchParams.get('enabled') === 'false';
  });
  await card.getByRole('button', { name: '查找链接', exact: true }).click();
  await request;
  await expect(permanent).toHaveCount(0);
  await expect(expired).toBeVisible();
  await expect(revoked).toBeVisible();
});
