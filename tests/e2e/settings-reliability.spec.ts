import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';
import {
  openFeatureSettings,
  openSettingsSection,
  setFeatureSwitch,
} from '../support/settings-navigation';

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

test('keeps an editor preference draft across settings, and persists only the saved choices', async ({
  page,
}) => {
  await page.goto('/?view=settings&section=editor');
  const lines = page.getByRole('switch', { name: '显示行号', exact: true });
  await expect(lines).toBeEnabled();
  const original = await lines.getAttribute('aria-checked');
  await lines.click();
  const changed = original === 'true' ? 'false' : 'true';
  await openSettingsSection(page, '搜索与索引');
  await openSettingsSection(page, '通用与编辑');
  await expect(lines).toHaveAttribute('aria-checked', changed);
  await expect(page.getByRole('button', { name: '取消更改', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '保存偏好', exact: true }).click();
  await page.reload();
  await expect(lines).toHaveAttribute('aria-checked', changed);
});

test('copies an MCP address on browsers without the asynchronous Clipboard API', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    document.addEventListener('copy', () => {
      const input = document.activeElement;
      if (input instanceof HTMLTextAreaElement)
        document.documentElement.dataset.copiedMcpAddress = input.value.slice(
          input.selectionStart,
          input.selectionEnd,
        );
    });
  });
  await page.goto('/?view=settings&section=mcp');
  await page.getByRole('button', { name: 'API Key 接入', exact: true }).click();
  const address = page.locator('.guide-value code');
  await expect(address).toHaveText(/\/mcp\/api-key$/);
  const copy = page.getByRole('button', { name: '复制连接地址', exact: true });
  await copy.click();
  await expect(page.getByText('连接地址已复制', { exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute(
    'data-copied-mcp-address',
    (await address.innerText()).trim(),
  );
  await expect(page.locator('textarea[readonly][tabindex="-1"]')).toHaveCount(0);
});

test('requires saving new MCP settings before enabling and permits immediate disable', async ({
  page,
}) => {
  await page.goto('/');
  await openFeatureSettings(page, 'MCP 服务');
  const toggle = page.getByRole('switch', { name: '启用 MCP 服务', exact: true });
  const originallyOn = (await toggle.getAttribute('aria-checked')) === 'true';
  try {
    await setFeatureSwitch(page, 'MCP 服务', true);
    const address = page.getByLabel('外部网页地址', { exact: true });
    await address.fill('https://settings-draft.example.invalid');
    await expect(toggle).toBeEnabled();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(toggle).toBeDisabled();
    await expect(
      page.getByText('保存当前权限和连接配置后即可启用 MCP。', { exact: true }),
    ).toBeVisible();
  } finally {
    const csrf = await (await page.request.get('/api/security/csrf')).json();
    await page.request.put('/api/platform/mcp/enabled', {
      headers: { origin: new URL(page.url()).origin, 'x-csrf-token': csrf.token },
      data: { enabled: originallyOn },
    });
  }
});

test('keeps older MCP calls visible while refreshing the recent list', async ({ page }) => {
  const rows = Array.from({ length: 55 }, (_, i) => ({
    id: String(i),
    tool: 'fixture-tool-' + i,
    client: 'fixture',
    code: 'OK',
    elapsedMs: 10,
    at: '2026-11-26T00:00:00Z',
  }));
  await page.route('**/api/platform/mcp/actions', async (route) => {
    const input = route.request().postDataJSON();
    if (input.id !== 'mcp.calls') return route.continue();
    const start = input.input.cursor === undefined ? 0 : Number(input.input.cursor) + 1;
    const items = rows.slice(start, start + 50);
    await route.fulfill({
      json: { items, nextCursor: start + 50 < rows.length ? items.at(-1)!.id : undefined },
    });
  });
  await page.goto('/');
  await openFeatureSettings(page, 'MCP 服务');
  const toggle = page.getByRole('switch', { name: '启用 MCP 服务', exact: true });
  const wasOn = (await toggle.getAttribute('aria-checked')) === 'true';
  try {
    await setFeatureSwitch(page, 'MCP 服务', true);
    await page.locator('summary').filter({ hasText: '调用记录' }).click();
    await page.getByRole('button', { name: '加载更早调用', exact: true }).click();
    await expect(page.getByText('fixture-tool-54', { exact: true })).toBeVisible();
    const refresh = page.waitForResponse(
      (r) =>
        r.url().endsWith('/api/platform/mcp/actions') &&
        r.request().postDataJSON().input.cursor === undefined,
      { timeout: 16000 },
    );
    await refresh;
    await expect(page.locator('.mcp-call-list li')).toHaveCount(55);
  } finally {
    await setFeatureSwitch(page, 'MCP 服务', wasOn);
  }
});
