import { test, expect } from '../support/browser-test';
import { devices } from '@playwright/test';
import { createServer, request as httpRequest } from 'node:http';
import { testPassword } from '../support/credentials';
import { closeSidebar, showSidebar } from '../support/settings-navigation';

const alias = process.env.DOOKNOW_E2E_HTTP_ALIAS;
test.setTimeout(120000);
for (const [type, label] of [
  ['whiteboard', '白板'],
  ['flowchart', '流程图'],
  ['mindmap', '脑图'],
] as const) {
  test(`HTTP ${label} opens, edits, saves and reloads without Web Crypto subtle`, async ({
    browser,
  }, info) => {
    test.skip(!alias, 'requires DOOKNOW_E2E_HTTP_ALIAS exact fixture allowlist');
    const targetOrigin = new URL(alias!);
    const proxy = createServer((req, res) => {
      const target = new URL(req.url!);
      if (target.origin !== targetOrigin.origin) {
        res.writeHead(403).end();
        return;
      }
      const upstream = httpRequest(
        {
          hostname: '127.0.0.1',
          port: Number(targetOrigin.port),
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
    const port = (proxy.address() as { port: number }).port;
    const { defaultBrowserType: _type, ...mobile } = devices['iPhone 13'];
    const context = await browser.newContext({
      ...(info.project.name === 'mobile' ? mobile : {}),
      proxy: { server: 'http://127.0.0.1:' + port },
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await page.goto(alias!);
      expect(await page.evaluate(() => isSecureContext)).toBe(false);
      expect(await page.evaluate(() => typeof crypto.subtle)).toBe('undefined');
      await page.getByLabel('用户名', { exact: true }).fill('owner');
      await page.getByLabel('密码', { exact: true }).fill(testPassword);
      await page.getByRole('button', { name: '登录', exact: true }).click();
      await showSidebar(page);
      await page.getByRole('button', { name: '创建与导入', exact: true }).click();
      await page.getByRole('button', { name: '新建' + label, exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '新建' + label, exact: true });
      await dialog
        .getByLabel('文件名', { exact: true })
        .fill(`HTTP-${type}-${crypto.randomUUID()}`);
      await dialog.getByRole('button', { name: '创建', exact: true }).click();
      const workspace = page.getByTestId('diagram-document-workspace');
      await expect(workspace).toBeVisible({ timeout: 45000 });
      await closeSidebar(page);
      await expect(workspace.getByRole('alert')).toHaveCount(0);
      if (type === 'whiteboard') {
        const canvas = workspace.locator('canvas.interactive');
        await expect(canvas).toBeVisible({ timeout: 30000 });
        const box = (await canvas.boundingBox())!;
        const x = box.x + box.width * 0.55,
          y = box.y + box.height * 0.5;
        await canvas.click({ position: { x: box.width * 0.55, y: box.height * 0.4 } });
        await page.keyboard.press('r');
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x + Math.min(100, box.width * 0.2), y + 65, { steps: 8 });
        await page.mouse.up();
      } else if (type === 'mindmap') {
        const root = workspace.locator('me-root me-tpc');
        await expect(root).toBeVisible({ timeout: 30000 });
        await root.click();
        await page.keyboard.press('F2');
        await workspace.locator('#input-box').fill('HTTP脑图已编辑');
        await page.keyboard.press('Enter');
      } else {
        const source = workspace.locator('.cm-content');
        await source.click();
        await page.keyboard.press('ControlOrMeta+a');
        await page.keyboard.insertText('flowchart TD\nA[HTTP编辑] --> B[已保存]\n');
      }
      await workspace.getByRole('button', { name: '保存图形', exact: true }).click();
      await expect(workspace.getByRole('status')).toContainText('已保存', { timeout: 30000 });
      const id = new URL(page.url()).searchParams.get('note')!;
      const resource = await page.evaluate(
        async (noteId) => (await fetch('/api/notes/' + noteId + '/diagram')).json(),
        id,
      );
      expect(resource.preview.state).toBe('ready');
      if (type === 'whiteboard')
        expect(JSON.parse(resource.source.content).elements.length).toBeGreaterThan(0);
      else if (type === 'mindmap') expect(resource.title).toBe('HTTP脑图已编辑');
      else expect(resource.source.content).toContain('HTTP编辑');
      const hash = resource.documentHash;
      await page.reload();
      await expect(
        page.getByTestId('diagram-document-workspace').getByRole('status'),
      ).toContainText('已保存', { timeout: 30000 });
      await expect(page.getByTestId('diagram-document-workspace').getByRole('alert')).toHaveCount(
        0,
      );
      const reloaded = await page.evaluate(
        async (noteId) => (await fetch('/api/notes/' + noteId + '/diagram')).json(),
        id,
      );
      expect(reloaded.source.content).toBe(resource.source.content);
      expect(reloaded.documentHash).toBe(hash);
      expect(errors).toEqual([]);
      await page.screenshot({
        path: info.outputPath(type + '-insecure-http.png'),
        animations: 'disabled',
      });
    } catch (error) {
      await page.screenshot({ path: info.outputPath(type + '-failure.png') }).catch(() => {});
      throw error;
    } finally {
      await context.close();
      proxy.closeAllConnections();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });
}
