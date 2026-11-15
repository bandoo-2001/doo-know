import { test, expect } from '@playwright/test';
import { testPassword } from '../support/credentials.js';

test.beforeEach(async ({ request, page }) => {
  expect((await request.post('/__test/setup/reset')).ok()).toBe(true);
  await page.goto('/');
  await page.getByLabel('用户名', { exact: true }).fill('owner');
  await page.getByLabel('密码', { exact: true }).fill(testPassword);
  await page.getByRole('button', { name: '登录', exact: true }).click();
});

test('Git credential help follows platform and authentication choices without submitting secrets', async ({
  page,
}) => {
  await expect(page.getByText('第一次使用可直接选择', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '从 GitHub／Gitee 导入', exact: true }).click();
  await expect(
    page.getByRole('complementary', { name: '云端仓库入门', exact: true }),
  ).toContainText('公开仓库只读取');
  await page.getByRole('button', { name: '添加凭据', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '添加凭据', exact: true });
  const guide = dialog.getByRole('complementary', { name: '访问令牌申请指南', exact: true });
  await expect(dialog.getByText('不是邮箱', { exact: false })).toBeVisible();
  const link = guide.getByRole('link', {
    name: '前往 GitHub 创建令牌（已预填仓库读写权限）',
    exact: true,
  });
  const address = new URL((await link.getAttribute('href'))!);
  expect(address.origin).toBe('https://github.com');
  expect(address.searchParams.get('contents')).toBe('write');
  await expect(link).toHaveAttribute('target', '_blank');
  await guide.getByText('按步骤选择仓库和权限', { exact: true }).click();
  await expect(guide).toContainText('Only select repositories');
  await expect(guide).toContainText('Read and write');
  const token = dialog.getByLabel('访问令牌', { exact: true });
  await expect(token).toHaveAttribute('type', 'password');
  await expect(token).toHaveValue('');
  await expect(token).toHaveAttribute('aria-describedby', (await guide.getAttribute('id'))!);
  await dialog.getByLabel('凭据服务平台', { exact: true }).selectOption('gitee.com');
  await expect(
    guide.getByRole('link', { name: '前往 Gitee 创建私人令牌', exact: true }),
  ).toHaveAttribute('href', 'https://gitee.com/profile/personal_access_tokens');
  await expect(link).toHaveCount(0);
  await dialog.getByLabel('认证方式', { exact: true }).selectOption('ssh');
  await expect(guide).toHaveCount(0);
  await expect(dialog.getByLabel('SSH 私钥', { exact: true })).toBeVisible();
});

test('feature prerequisites and guides are available before installing plugins or downloading search', async ({
  page,
}) => {
  await page.getByRole('button', { name: '确认并继续', exact: true }).click();
  await expect(page.getByRole('heading', { name: '选择需要的功能', exact: true })).toBeVisible();
  const changes: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && /plugin-installations|search-runtime\/prepare/.test(r.url()))
      changes.push(r.url());
  });
  await page.getByText('如何开始连接', { exact: true }).click();
  await expect(page.getByText('这里的 API Key 由 DooKnow 创建', { exact: false })).toBeVisible();
  await page.getByText('如何开始记录与同步', { exact: true }).click();
  await expect(page.getByText('提交署名不是仓库登录账号', { exact: false })).toBeVisible();
  const searchGuide = page
    .locator('details')
    .filter({ has: page.locator('summary', { hasText: '如何开始搜索' }) });
  await searchGuide.locator('summary').click();
  await expect(searchGuide).toContainText('下载');
  await expect(page.getByRole('button', { name: '暂时跳过', exact: true })).toBeEnabled();
  expect(changes).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
