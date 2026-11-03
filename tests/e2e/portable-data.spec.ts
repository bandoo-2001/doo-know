import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, expect } from '../support/browser-test';
import { closeSidebar } from '../support/settings-navigation';

test('synchronized plugin data shows a dependency hint without installation or activation', async ({
  page,
  context,
}, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const { knowledgeRoot, origin = 'http://127.0.0.1:' + String(process.env.DOOKNOW_E2E_WEB_PORT || 4179) } =
    JSON.parse(await readFile('.local/e2e-config.json', 'utf8'));
  const initialRegistry = await (await page.request.get('/api/platform/plugins')).json();
  const counter = initialRegistry.installed.find((plugin: any) => plugin.id === 'counter');
  if (counter) {
    const csrf = await (await page.request.get('/api/security/csrf')).json();
    const headers = { origin, 'x-csrf-token': csrf.token };
    if (counter.state !== 'disabled' || counter.desiredEnabled) {
      const disabled = await page.request.post('/api/platform/plugins/counter/disable', { headers, data: {} });
      expect(disabled.ok()).toBe(true);
    }
    const uninstalled = await page.request.post('/api/platform/plugins/counter/uninstall', { headers, data: {} });
    expect(uninstalled.ok()).toBe(true);
  }
  const prepared = await (await page.request.get('/api/platform/plugins')).json();
  expect(prepared.installed.some((plugin: any) => plugin.id === 'counter')).toBe(false);
  const directory = join(knowledgeRoot, '_doo-data/plugins/counter');
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'state.json'),
    JSON.stringify({
      format: 1,
      revision: 'migration-browser-fixture',
      data: {
        schemaVersion: 1,
        plugin: { id: 'counter', version: '1.0.0', apiVersion: '^1.0.0' },
        config: {},
        userData: { example: '保留的插件资料' },
      },
    }),
  );
  const installationRequests: string[] = [];
  page.on('request', (request) => {
    if (
      request.method() !== 'GET' &&
      /\/api\/platform\/plugins\/.+\/(install|enable|upgrade)$|\/api\/platform\/plugin-installations$/.test(
        new URL(request.url()).pathname,
      )
    )
      installationRequests.push(request.url());
  });
  await page.goto('/?view=settings&section=plugins');
  await expect(page.getByRole('region', { name: '插件与连接', exact: true })).toBeVisible();
  await closeSidebar(page);
  const hint = page.locator('.plugin-feedback').filter({ hasText: '计数验收插件 · 用户资料' });
  await expect(hint).toBeVisible();
  await expect(hint).toContainText('用户资料已保留，安装插件后可继续使用');
  await expect(hint.getByRole('button', { name: '安装插件', exact: true })).toBeVisible();
  const registry = (await page.request.get('/api/platform/plugins')).json();
  expect((await registry).installed.some((plugin: { id: string }) => plugin.id === 'counter')).toBe(
    false,
  );
  expect(installationRequests).toEqual([]);
  if (info.project.name === 'desktop') await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: info.outputPath('plugin-data-dependency.png'),
    animations: 'disabled',
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
});
