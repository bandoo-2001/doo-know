import { readFile, writeFile } from 'node:fs/promises';
import type { Locator, Page } from '@playwright/test';
import type { PluginView } from '../../packages/plugin-contracts';
import { test, expect } from '../support/browser-test';
import { configurePlugin, closeSidebar } from '../support/settings-navigation';

async function registry(page: Page): Promise<PluginView> {
  const response = await page.request.get('/api/platform/plugins');
  expect(response.ok()).toBe(true);
  return (await response.json()).installed.find((entry: PluginView) => entry.id === 'mcp');
}
async function mutate(page: Page, path: string, method: string, data: unknown) {
  return page.evaluate(
    async ({ path, method, data }) => {
      const csrf = await (await fetch('/api/security/csrf')).json();
      const response = await fetch(path, {
        method,
        headers: {
          ...(data === undefined ? {} : { 'content-type': 'application/json' }),
          'x-csrf-token': csrf.token,
        },
        body: JSON.stringify(data),
      });
      if (!response.ok) throw Error('Isolated fixture mutation rejected: ' + response.status);
      return response.json();
    },
    { path, method, data },
  );
}
async function hit(control: Locator) {
  await control.scrollIntoViewIfNeeded();
  await expect(control).toBeInViewport({ ratio: 1 });
  await expect
    .poll(() =>
      control.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const target = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return !!target && element.contains(target);
      }),
    )
    .toBe(true);
}

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

for (const width of [320, 390, 1440]) {
  test(`plugin conflict copy and reload confirmation stay readable at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/');
    await configurePlugin(page, 'MCP 服务');
    await closeSidebar(page);
    const initial = await registry(page);
    try {
      const draft = '00-Inbox\n未保存的目录-' + crypto.randomUUID();
      const prefixes = page.getByLabel('允许访问的目录', { exact: true });
      await prefixes.fill(draft);
      const remote = (await mutate(page, '/api/platform/plugins/mcp/config', 'PUT', {
        values: { readOnly: !initial.config.readOnly },
        configVersion: initial.configVersion,
      })) as PluginView;
      await page.getByRole('button', { name: '刷新插件状态', exact: true }).click();
      const alert = page.locator('.plugin-settings .ant-alert').filter({
        hasText: '已保存配置在其他位置发生变化',
      });
      await expect(alert).toBeVisible();
      await expect(prefixes).toHaveValue(draft);
      await expect(page.getByRole('button', { name: '保存插件配置', exact: true })).toBeDisabled();
      const reload = alert.getByRole('button', { name: '重新载入已保存配置', exact: true });
      await hit(reload);
      await reload.focus();
      await expect(reload).toBeFocused();
      await page.keyboard.press('Enter');
      const popup = page.locator('.ant-popconfirm:visible');
      await expect(popup).toContainText('重新载入会丢弃当前未保存输入，确定继续？');
      await hit(popup.getByRole('button', { name: '保留当前输入', exact: true }));
      await hit(popup.getByRole('button', { name: '丢弃输入并重新载入', exact: true }));
      const metrics = await alert.evaluate((element) => {
        const content = element.querySelector('.ant-alert-content')!;
        const description = element.querySelector('.ant-alert-description')!;
        const action = element.querySelector('.ant-alert-action')!;
        const bounds = (node: Element) => {
          const box = node.getBoundingClientRect();
          return {
            x: box.x,
            y: box.y,
            width: box.width,
            height: box.height,
            right: box.right,
            bottom: box.bottom,
          };
        };
        const lines = new Map<number, { characters: number; left: number; right: number }>();
        const walker = document.createTreeWalker(description, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        while ((node = walker.nextNode())) {
          for (let offset = 0; offset < (node.textContent?.length || 0); offset++) {
            if (!node.textContent![offset].trim()) continue;
            const range = document.createRange();
            range.setStart(node, offset);
            range.setEnd(node, offset + 1);
            const box = range.getBoundingClientRect(),
              top = Math.round(box.top);
            const line = lines.get(top) || { characters: 0, left: box.left, right: box.right };
            line.characters++;
            line.left = Math.min(line.left, box.left);
            line.right = Math.max(line.right, box.right);
            lines.set(top, line);
          }
        }
        return {
          alert: bounds(element),
          content: bounds(content),
          action: bounds(action),
          descriptionLines: [...lines.values()].map((line) => ({
            ...line,
            width: line.right - line.left,
          })),
        };
      });
      await writeFile(info.outputPath('conflict-layout.json'), JSON.stringify(metrics, null, 2));
      await page.screenshot({
        path: info.outputPath('conflict-reload.png'),
        animations: 'disabled',
      });
      // A warning must leave enough room for a readable phrase, not a one-glyph column.
      expect(metrics.content.width / metrics.alert.width).toBeGreaterThan(0.6);
      expect(
        Math.max(...metrics.descriptionLines.map((line) => line.characters)),
      ).toBeGreaterThanOrEqual(8);
      expect(metrics.action.right).toBeLessThanOrEqual(metrics.alert.right + 1);
      await popup.getByRole('button', { name: '保留当前输入', exact: true }).click();
      await expect(popup).toBeHidden();
      await alert.evaluate((element) => element.scrollIntoView({ block: 'center' }));
      await expect(alert).toBeInViewport({ ratio: 1 });
      await page.screenshot({ path: info.outputPath('conflict-copy.png'), animations: 'disabled' });
      await expect(prefixes).toHaveValue(draft);
      await expect(page.getByRole('button', { name: '保存插件配置', exact: true })).toBeDisabled();
      await reload.focus();
      await expect(reload).toBeFocused();
      await page.keyboard.press('Enter');
      await page
        .locator('.ant-popconfirm:visible')
        .getByRole('button', { name: '丢弃输入并重新载入', exact: true })
        .click();
      await expect(prefixes).toHaveValue((remote.config.allowedPrefixes as string[]).join('\n'));
      await expect(alert).toHaveCount(0);
    } finally {
      const current = await registry(page);
      await mutate(page, '/api/platform/plugins/mcp/config', 'PUT', {
        values: initial.config,
        configVersion: current.configVersion,
      });
    }
  });
}

test('long Git credential actions remain contained independently of the plugin conflict layout', async ({
  page,
}, info) => {
  await page.goto('/?view=settings&section=library');
  await closeSidebar(page);
  const name = ('Capture-' + crypto.randomUUID() + 'X'.repeat(120)).slice(0, 120);
  const saved = await mutate(page, '/api/platform/git/credentials', 'POST', {
    name,
    host: 'github.com',
    kind: 'https',
    username: 'capture',
    token: 'synthetic-' + crypto.randomUUID(),
    remember: false,
  });
  try {
    await page
      .getByRole('region', { name: '云端同步面板', exact: true })
      .getByRole('button', { name: /^(管理同步|关联云端仓库)$/ })
      .click();
    const drawer = page.getByRole('dialog', { name: '管理云端同步', exact: true });
    const row = drawer.locator('.credential-list li').filter({ hasText: name });
    // The panel read preceded the API seed; refresh the actual view once.
    if (!(await row.count())) {
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: '刷新同步状态', exact: true }).click();
      await page
        .getByRole('region', { name: '云端同步面板', exact: true })
        .getByRole('button', { name: /^(管理同步|关联云端仓库)$/ })
        .click();
    }
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      for (const action of ['更换凭据 ', '移除凭据 ']) {
        const control = row.getByRole('button', { name: action + name, exact: true });
        await hit(control);
        const result = await control.evaluate((element) => {
          const box = element.getBoundingClientRect();
          return { right: box.right, x: box.x, height: box.height };
        });
        expect(result.x).toBeGreaterThanOrEqual(0);
        expect(result.right).toBeLessThanOrEqual(width);
        expect(result.height).toBeGreaterThanOrEqual(36);
      }
      await page.screenshot({
        path: info.outputPath(`long-credential-${width}.png`),
        animations: 'disabled',
      });
    }
  } finally {
    await mutate(page, '/api/platform/git/credentials/' + saved.id, 'DELETE', undefined);
  }
});
