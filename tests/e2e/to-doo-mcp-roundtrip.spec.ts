import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test, expect } from '../support/browser-test';
import type { AppConfig } from '../../shared/contracts';

test('browser writes and SDK writes share the actual dataset and live resource grants', async ({
  page,
  context,
}, info) => {
  test.setTimeout(90000);
  const config: AppConfig = JSON.parse(await readFile('.local/e2e-config.json', 'utf8'));
  const root = dirname(resolve(config.dataRoot));
  if (
    dirname(root) !== resolve(tmpdir()) ||
    !basename(root).startsWith('dooknow-browser-') ||
    dirname(resolve(config.knowledgeRoot)) !== root
  )
    throw Error('MCP browser acceptance requires an isolated browser fixture');
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const headers = { origin: config.origin!, 'x-csrf-token': csrf.token };
  async function command(action: string, payload: Record<string, unknown>) {
    const response = await page.request.post('/api/to-doo/commands', {
      headers,
      data: { requestId: crypto.randomUUID(), action, payload },
    });
    expect(response.ok()).toBe(true);
    return response.json();
  }
  const allowed = (
    await command('save_entity', {
      kind: 'list',
      entity: { name: '跨端授权清单 ' + info.project.name, kind: 'list' },
    })
  ).ids[0];
  const privateList = (
    await command('save_entity', {
      kind: 'list',
      entity: { name: '不授权的清单 ' + info.project.name, kind: 'list' },
    })
  ).ids[0];
  const privateTask = (
    await command('create_task', {
      title: 'PRIVATE_RESOURCE_NOT_SHARED',
      listId: privateList,
    })
  ).ids[0];
  const title = '浏览器创建后由 MCP 读取 ' + info.project.name;
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&list=' + allowed);
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
  const input = app.getByRole('textbox', { name: '快速添加任务', exact: true });
  await input.fill(title);
  await input.press('Enter');
  await expect(input).toHaveValue('');
  await expect(app.getByRole('button', { name: title, exact: true })).toBeVisible();

  const updatedTitle = 'MCP 修改后浏览器刷新一致 ' + info.project.name;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      '--import',
      'tsx',
      'tests/support/to-doo-browser-sdk.ts',
      JSON.stringify({
        allowed,
        privateTask,
        privateList,
        title,
        updatedTitle,
      }),
    ],
    { timeout: 60000, maxBuffer: 65536 },
  );
  expect(JSON.parse(stdout)).toEqual({
    title,
    updatedTitle,
    scopedTotal: 1,
    replayed: true,
    privateDenied: true,
    revoked: true,
  });
  await page.reload();
  await expect(app.getByRole('button', { name: updatedTitle, exact: true })).toBeVisible();
  await expect(app.getByRole('button', { name: title, exact: true })).not.toBeVisible();
});
