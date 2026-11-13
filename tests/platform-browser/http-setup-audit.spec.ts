import { test, expect, devices } from '@playwright/test';
import { createServer, request as httpRequest } from 'node:http';
import { testPassword } from '../support/credentials.js';

test('plain HTTP non-loopback login and first-time setup work without secure-context Web Crypto', async ({
  browser,
  request,
}, info) => {
  expect((await request.post('/__test/setup/reset')).ok()).toBe(true);
  // Loopback transport keeps the browser URL, Origin and cookie host intact.
  const proxy = createServer((req, res) => {
    const target = new URL(req.url!);
    if (target.hostname !== 'setup.audit.test' || target.port !== '4178') {
      res.writeHead(403).end();
      return;
    }
    const upstream = httpRequest(
      {
        hostname: '127.0.0.1',
        port: 4178,
        path: target.pathname + target.search,
        method: req.method,
        headers: { ...req.headers, host: target.host },
      },
      (reply) => {
        res.writeHead(reply.statusCode!, reply.headers);
        reply.pipe(res);
      },
    );
    upstream.on('error', () => res.writeHead(502).end());
    req.pipe(upstream);
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const address = proxy.address() as { port: number };
  const { defaultBrowserType: _browser, ...mobile } = devices['iPhone 13'];
  const context = await browser.newContext({
    ...(info.project.name === 'mobile' ? mobile : {}),
    proxy: { server: `http://127.0.0.1:${address.port}` },
  });
  const page = await context.newPage();
  try {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('http://setup.audit.test:4178');
    expect(await page.evaluate(() => isSecureContext)).toBe(false);
    await page.getByLabel('用户名', { exact: true }).fill('owner');
    await page.getByLabel('密码', { exact: true }).fill(testPassword);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: '准备你的知识库', exact: true })).toBeVisible();
    await page.getByLabel('知识库名称', { exact: true }).fill('HTTP首次安装');
    await page.getByRole('button', { name: '确认并继续', exact: true }).click();
    await expect(page.getByRole('heading', { name: '选择需要的功能', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '暂时跳过', exact: true }).click();
    await page.getByRole('button', { name: '进入工作区', exact: true }).click();
    await expect(page.locator('.sidebar .brand')).toContainText('DooKnow');
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  }
});
