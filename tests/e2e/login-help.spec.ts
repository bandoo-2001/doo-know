import { test, expect } from '../support/browser-test';

test('first-time login help explains where the owner account comes from and links the installation guide', async ({
  page,
}) => {
  await page.goto('/');
  const help = page.locator('.login-help');
  await expect(help.getByText('账号在安装 DooKnow 时创建。', { exact: true })).toBeHidden();
  await expect(page.getByText('第一次使用或还没有账号？', { exact: true })).toBeVisible();
  await page.getByText('第一次使用或还没有账号？', { exact: true }).click();
  await expect(help).toContainText('账号在安装 DooKnow 时创建。');
  await expect(help).toContainText('如果由他人部署，请向部署者获取用户名和密码。');
  await expect(help).toContainText(
    '如果由你部署，请在运行 DooKnow 的设备终端中继续完成安装，再回到这里登录。',
  );
  await expect(help.getByRole('link', { name: '查看安装说明', exact: true })).toHaveAttribute(
    'href',
    'https://github.com/bandoo-2001/doo-know#安装',
  );
  await expect(page.getByRole('button', { name: '注册', exact: true })).toHaveCount(0);
});
