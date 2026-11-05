import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Locator, Page, Request } from '@playwright/test';
import type { GraphUserState } from '../../shared/graph-semantic-contracts';
import { test, expect } from '../support/browser-test';
import { openGraphPanel } from '../support/graph-navigation';

async function readGraphState(page: Page): Promise<GraphUserState> {
  const response = await page.request.get('/api/graph/state');
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}

async function removeTestViews(page: Page, prefix: string) {
  const csrf = await page.request.get('/api/security/csrf');
  expect(csrf.status()).toBe(200);
  const headers = {
    origin: new URL(page.url()).origin,
    'x-csrf-token': (await csrf.json()).token,
  };
  const state = await readGraphState(page);
  for (const view of state.views.filter((item) => item.name.startsWith(prefix))) {
    // Each removal advances the CAS version; never delete the fixture's other views.
    const current = await readGraphState(page);
    const removed = await page.request.post('/api/graph/commands', {
      headers,
      data: {
        action: 'delete-view',
        id: view.id,
        requestId: randomUUID(),
        expectedVersion: current.version,
      },
    });
    expect(removed.status(), await removed.text()).toBe(200);
  }
  expect((await readGraphState(page)).views.filter((item) => item.name.startsWith(prefix))).toEqual(
    [],
  );
}

for (const entry of ['typing', 'clipboard paste'] as const) {
  test(`saved graph view persists 80 characters and blocks the 81st from ${entry}`, async ({
    page,
    context,
  }) => {
    await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
    await page.goto('/?view=apps&app=graph');
    await expect(page.getByRole('heading', { name: '知识图谱', exact: true })).toBeVisible();
    await openGraphPanel(page, '视图');
    const dialog = page.getByRole('dialog', { name: '视图与导出', exact: true });
    const input = dialog.getByRole('textbox', { name: '保存当前视图', exact: true });
    await expect(input).toBeVisible();

    // UUID prefix = 41 ASCII characters; the literal suffix = 38. Expectations
    // are hand-counted fixture data, independent of the production name policy.
    const prefix = `g80-${randomUUID()}-`;
    const name79 = prefix + '01234567890123456789012345678901234567';
    const name80 = prefix + '01234567890123456789012345678901234567文';
    const name81 = prefix + '01234567890123456789012345678901234567文字';
    const submittedNames: string[] = [];
    const recordSave = (request: Request) => {
      if (request.method() !== 'POST' || new URL(request.url()).pathname !== '/api/graph/commands')
        return;
      const command = request.postDataJSON();
      if (command.action === 'save-view') submittedNames.push(command.name);
    };
    page.on('request', recordSave);

    async function enter(target: Locator, text: string) {
      if (entry === 'typing') await target.pressSequentially(text);
      else {
        await page.evaluate((value) => navigator.clipboard.writeText(value), text);
        await target.press('ControlOrMeta+V');
      }
    }

    async function saveAndRead(expectedCount: number) {
      const responsePromise = page.waitForResponse((response) => {
        const request = response.request();
        if (request.method() !== 'POST' || new URL(response.url()).pathname !== '/api/graph/commands')
          return false;
        return request.postDataJSON().action === 'save-view';
      });
      await dialog.getByRole('button', { name: '保存视图', exact: true }).click();
      const response = await responsePromise;
      expect(response.status(), await response.text()).toBe(200);
      expect(response.request().postDataJSON().name).toBe(name80);
      await expect(input).toHaveValue('');
      const persisted = (await readGraphState(page)).views.filter((view) =>
        view.name.startsWith(prefix),
      );
      expect(persisted.map((view) => view.name)).toEqual(
        expectedCount === 1 ? [name80] : [name80, name80],
      );
      await expect(dialog.getByRole('button', { name: name80, exact: true })).toHaveCount(expectedCount);
    }

    try {
      if (entry === 'clipboard paste')
        await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
          origin: new URL(page.url()).origin,
        });
      await input.focus();
      await enter(input, name79);
      await expect(input).toHaveValue(name79);
      await enter(input, '文');
      await expect(input).toHaveValue(name80);
      await saveAndRead(1);

      // Repeat real user entry after the successful save. The old UI accepts
      // this extra character and must fail here before any frontend fix.
      await input.focus();
      await enter(input, name79);
      await expect(input).toHaveValue(name79);
      await enter(input, '文');
      await expect(input).toHaveValue(name80);
      await enter(input, '字');
      await expect(input).toHaveValue(name80);

      if (entry === 'clipboard paste') {
        // Also cover replacing the entire field with an overlong clipboard
        // value, rather than testing only a one-character paste at the end.
        await input.press('ControlOrMeta+A');
        await input.press('Backspace');
        await enter(input, name81);
        await expect(input).toHaveValue(name80);
      }
      await saveAndRead(2);
      expect(submittedNames).toEqual([name80, name80]);
    } finally {
      page.off('request', recordSave);
      await removeTestViews(page, prefix);
    }
  });
}
