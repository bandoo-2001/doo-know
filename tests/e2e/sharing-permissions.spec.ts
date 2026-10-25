import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const cookiesPath = process.env.DOOKNOW_SHARE_E2E_COOKIES || '.local/e2e-cookies.json';
async function seed(page: Page, content = '# 分享权限验收\n\n原始正文。') {
  await page.context().addCookies(JSON.parse(await readFile(cookiesPath, 'utf8')));
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const origin = new URL(test.info().project.use.baseURL!).origin;
  const headers = { origin, 'x-csrf-token': csrf.token };
  const response = await page.request.post('/api/notes', {
    headers,
    data: {
      folderPath: '00-Inbox',
      fileName: `share-permissions-${crypto.randomUUID()}.md`,
      content,
      requestId: crypto.randomUUID(),
    },
  });
  expect(response.status()).toBe(201);
  return { note: await response.json(), headers, origin };
}
async function openShare(page: Page, id: string) {
  await page.goto('/?note=' + id);
  await page.getByRole('button', { name: '分享', exact: true }).click();
  await expect(page.locator('.share-dialog')).toBeVisible();
}

test('new links default to seven days and view; settings preserve the active URL and support permanent/custom expiry', async ({
  page,
}) => {
  const { note, headers } = await seed(page);
  await openShare(page, note.id);
  await expect(page.getByLabel('分享权限', { exact: true })).toHaveValue('view');
  await expect(page.getByLabel('链接有效期', { exact: true })).toHaveValue('7d');
  await page.getByLabel('链接有效期', { exact: true }).selectOption('permanent');
  await page.getByRole('button', { name: '生成分享链接', exact: true }).click();
  const link = page.getByRole('textbox', { name: '公开链接' });
  await expect(link).not.toHaveValue('');
  const url = await link.inputValue();
  let status = await (await page.request.get(`/api/notes/${note.id}/share`)).json();
  expect(status.permission).toBe('view');
  expect(status.expiresAt).toBeNull();
  await page.getByLabel('分享权限', { exact: true }).selectOption('edit');
  await page.getByLabel('链接有效期', { exact: true }).selectOption('custom');
  const expiry = new Date(Date.now() + 2 * 86400000);
  expiry.setSeconds(0, 0);
  const local = new Date(expiry.getTime() - expiry.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
  await page.getByLabel('自定义到期时间', { exact: true }).fill(local);
  await page.getByRole('button', { name: '保存分享设置', exact: true }).click();
  await expect(link).toHaveValue(url);
  status = await (await page.request.get(`/api/notes/${note.id}/share`)).json();
  expect(status.permission).toBe('edit');
  expect(new Date(status.expiresAt).getTime()).toBe(expiry.getTime());
  expect(await page.locator('.share-dialog').evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: test.info().outputPath('owner-share-dialog.png'),
    fullPage: true,
    mask: [link],
  });
  await page.getByLabel('链接有效期', { exact: true }).selectOption('1h');
  await page.getByRole('button', { name: '保存分享设置', exact: true }).click();
  await expect(page.getByText('分享设置已保存', { exact: true })).toBeVisible();
  status = await (await page.request.get(`/api/notes/${note.id}/share`)).json();
  expect(new Date(status.expiresAt).getTime() - Date.now()).toBeGreaterThan(3500000);
  expect((await page.request.delete(`/api/notes/${note.id}/share`, { headers })).ok()).toBe(true);
});

test('an anonymous visitor edits rich/source manually and owner sees the saved content without private API requests', async ({
  page,
  browser,
}) => {
  const { note, headers, origin } = await seed(page);
  const shared = await page.request.post(`/api/notes/${note.id}/share`, {
    headers,
    data: { permission: 'edit', expiresAt: new Date(Date.now() + 86400000).toISOString() },
  });
  expect(shared.ok()).toBe(true);
  const share = await shared.json();
  const guest = await browser.newContext();
  const reader = await guest.newPage();
  const privateRequests: string[] = [];
  reader.on('request', (r) => {
    if (
      new URL(r.url()).pathname.startsWith('/api/') &&
      !new URL(r.url()).pathname.startsWith('/api/public/')
    )
      privateRequests.push(new URL(r.url()).pathname);
  });
  await reader.goto(origin + share.url);
  await reader.getByRole('button', { name: '编辑笔记', exact: true }).click();
  await expect(reader.getByRole('textbox', { name: '文档正文', exact: true })).toBeVisible();
  await reader
    .getByRole('textbox', { name: '文档正文', exact: true })
    .locator('p')
    .first()
    .fill('匿名富文本修改。');
  await reader.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
  await expect(reader.locator('.cm-content')).toContainText('匿名富文本修改');
  await reader.locator('.cm-content').fill('# 分享权限验收\n\n匿名手动保存成功。');
  expect((await (await page.request.get(`/api/notes/${note.id}`)).json()).content).not.toContain(
    '匿名手动保存成功',
  );
  await reader.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(reader.locator('.public-save-state')).toHaveText('已保存');
  expect((await (await page.request.get(`/api/notes/${note.id}`)).json()).content).toContain(
    '匿名手动保存成功',
  );
  expect(privateRequests).toEqual([]);
  expect(
    await reader.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);
  await reader.screenshot({
    path: test.info().outputPath('anonymous-source-editor.png'),
    fullPage: true,
  });
  expect(
    await reader.evaluate(() => Object.keys(localStorage).some((k) => k.includes('draft'))),
  ).toBe(false);
  await guest.close();
});

test('a stale save retains guest text and reload requires explicit discard confirmation', async ({
  page,
  browser,
}) => {
  const { note, headers, origin } = await seed(page);
  const share = await (
    await page.request.post(`/api/notes/${note.id}/share`, {
      headers,
      data: { permission: 'edit' },
    })
  ).json();
  const guest = await browser.newContext();
  const reader = await guest.newPage();
  await reader.goto(origin + share.url);
  await reader.getByRole('button', { name: '编辑笔记', exact: true }).click();
  await reader.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
  await reader.locator('.cm-content').fill('# 访客尚未保存\n\n不能丢失。');
  const current = await (await page.request.get(`/api/notes/${note.id}`)).json();
  expect(
    (
      await page.request.put(`/api/notes/${note.id}`, {
        headers,
        data: {
          content: '# 主人已更新\n\n最新正文。',
          expectedModifiedAt: current.modifiedAt,
          requestId: crypto.randomUUID(),
        },
      })
    ).ok(),
  ).toBe(true);
  await reader.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(reader.getByRole('alert')).toContainText('已更新');
  await expect(reader.locator('.cm-content')).toContainText('不能丢失');
  await reader.getByRole('button', { name: '重新载入最新内容', exact: true }).click();
  await expect(reader.getByRole('dialog')).toContainText('未保存');
  await reader.getByRole('button', { name: '保留编辑', exact: true }).click();
  await expect(reader.locator('.cm-content')).toContainText('不能丢失');
  await reader.getByRole('button', { name: '重新载入最新内容', exact: true }).click();
  await reader.getByRole('button', { name: '放弃编辑并重新载入', exact: true }).click();
  await expect(reader.locator('.cm-content')).toContainText('主人已更新');
  await guest.close();
});

test('a downgrade blocks saving while keeping the unsaved text', async ({ page, browser }) => {
  const { note, headers, origin } = await seed(page);
  const share = await (
    await page.request.post(`/api/notes/${note.id}/share`, {
      headers,
      data: { permission: 'edit' },
    })
  ).json();
  const guest = await browser.newContext();
  const reader = await guest.newPage();
  await reader.goto(origin + share.url);
  await reader.getByRole('button', { name: '编辑笔记', exact: true }).click();
  await reader.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
  await reader.locator('.cm-content').fill('# 保存权限改变后仍保留输入');
  expect(
    (
      await page.request.post(`/api/notes/${note.id}/share`, {
        headers,
        data: { permission: 'view' },
      })
    ).ok(),
  ).toBe(true);
  await reader.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(reader.getByRole('alert')).toContainText('只读');
  await expect(reader.locator('.cm-content')).toContainText('仍保留输入');
  await expect(reader.getByRole('button', { name: '保存修改', exact: true })).toBeDisabled();
  await guest.close();
});

test('a rejected new private resource can be removed and saved without losing the draft', async ({
  page,
  browser,
}) => {
  const { note, headers, origin } = await seed(page);
  const share = await (
    await page.request.post(`/api/notes/${note.id}/share`, {
      headers,
      data: { permission: 'edit' },
    })
  ).json();
  const guest = await browser.newContext();
  const reader = await guest.newPage();
  await reader.goto(origin + share.url);
  await reader.getByRole('button', { name: '编辑笔记', exact: true }).click();
  await reader.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
  await reader.locator('.cm-content').fill('# 合法文字\n\n![不能新增](private-file.png)');
  await reader.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(reader.getByRole('alert')).toContainText('不能新增');
  await expect(reader.locator('.cm-content')).toContainText('private-file.png');
  await reader.locator('.cm-content').fill('# 合法文字\n\n删除私有引用后可以保存。');
  await expect(reader.getByRole('button', { name: '保存修改', exact: true })).toBeEnabled();
  await reader.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(reader.locator('.public-save-state')).toHaveText('已保存');
  expect((await (await page.request.get(`/api/notes/${note.id}`)).json()).content).toContain(
    '删除私有引用后可以保存',
  );
  await guest.close();
});

test('a lost save response retains text and retries the same durable request', async ({
  page,
  browser,
}) => {
  const { note, headers, origin } = await seed(page);
  const share = await (
    await page.request.post(`/api/notes/${note.id}/share`, {
      headers,
      data: { permission: 'edit' },
    })
  ).json();
  const guest = await browser.newContext();
  const reader = await guest.newPage();
  await reader.goto(origin + share.url);
  await reader.getByRole('button', { name: '编辑笔记', exact: true }).click();
  await reader.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
  await reader.locator('.cm-content').fill('# 响应丢失后重试\n\n同一个保存请求。');
  const payloads: unknown[] = [];
  reader.on('request', (r) => {
    if (r.method() === 'PUT') payloads.push(r.postDataJSON());
  });
  await reader.route(
    `**/api/public/shares/${share.token}/source`,
    async (route) => {
      if (route.request().method() === 'PUT') {
        await route.fetch();
        await route.abort('failed');
      } else await route.continue();
    },
    { times: 1 },
  );
  await reader.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(reader.getByRole('alert')).toContainText('当前编辑已保留');
  await expect(reader.locator('.cm-content')).toContainText('同一个保存请求');
  expect((await (await page.request.get(`/api/notes/${note.id}`)).json()).content).toContain(
    '同一个保存请求',
  );
  const first = (await (await page.request.get(`/api/notes/${note.id}`)).json()).modifiedAt;
  await reader.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(reader.locator('.public-save-state')).toHaveText('已保存');
  expect(payloads).toHaveLength(2);
  expect(payloads[1]).toEqual(payloads[0]);
  expect((await (await page.request.get(`/api/notes/${note.id}`)).json()).modifiedAt).toBe(first);
  await guest.close();
});

for (const transition of ['expired', 'revoked'] as const)
  test(`${transition} links block saving and preserve the unsaved input`, async ({
    page,
    browser,
  }) => {
    const { note, headers, origin } = await seed(page);
    const share = await (
      await page.request.post(`/api/notes/${note.id}/share`, {
        headers,
        data: { permission: 'edit' },
      })
    ).json();
    const guest = await browser.newContext();
    const reader = await guest.newPage();
    await reader.goto(origin + share.url);
    await reader.getByRole('button', { name: '编辑笔记', exact: true }).click();
    await reader.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
    await reader.locator('.cm-content').fill('# 链接失效仍可复制输入');
    expect(
      await reader.evaluate(() => {
        const event = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
      }),
    ).toBe(true);
    if (transition === 'revoked')
      expect((await page.request.delete(`/api/notes/${note.id}/share`, { headers })).ok()).toBe(
        true,
      );
    else {
      expect(
        (
          await page.request.post(`/api/notes/${note.id}/share`, {
            headers,
            data: { permission: 'edit', expiresAt: new Date(Date.now() + 600).toISOString() },
          })
        ).ok(),
      ).toBe(true);
      await expect
        .poll(async () =>
          (await page.request.get(`/api/public/shares/${share.token}/meta`)).status(),
        )
        .toBe(404);
    }
    await reader.getByRole('button', { name: '保存修改', exact: true }).click();
    await expect(reader.getByRole('alert')).toContainText('无法保存');
    await expect(reader.locator('.cm-content')).toContainText('仍可复制输入');
    await expect(reader.getByRole('button', { name: '保存修改', exact: true })).toBeDisabled();
    expect((await (await page.request.get(`/api/notes/${note.id}`)).json()).content).not.toContain(
      '仍可复制输入',
    );
    await guest.close();
  });

test('large documents keep paginated public reading and explain why public editing is unavailable', async ({
  page,
  browser,
}) => {
  const { note, headers, origin } = await seed(page);
  const configPath = process.env.DOOKNOW_SHARE_E2E_CONFIG || '.local/e2e-config.json';
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const { join, resolve, dirname, basename } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const fixtureRoot = dirname(resolve(config.knowledgeRoot));
  expect(dirname(fixtureRoot)).toBe(resolve(tmpdir()));
  expect(basename(fixtureRoot)).toMatch(/^dooknow-(?:share-)?browser-/);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(
    join(config.knowledgeRoot, note.relativePath),
    '# 大文件分享验收\n\n' + '当前大文件正文。\n'.repeat(70000),
  );
  await openShare(page, note.id);
  await expect(page.locator('.share-limitation')).toContainText('大文件');
  await expect(
    page.getByLabel('分享权限', { exact: true }).locator('option[value="edit"]'),
  ).toHaveJSProperty('disabled', true);
  await page.getByRole('button', { name: '生成分享链接', exact: true }).click();
  const url = await page.getByRole('textbox', { name: '公开链接' }).inputValue();
  const guest = await browser.newContext();
  const reader = await guest.newPage();
  await reader.goto(url);
  await expect(reader.locator('.markdown')).toContainText('当前大文件正文');
  await expect(reader.getByRole('button', { name: '编辑笔记', exact: true })).toHaveCount(0);
  await expect(reader.getByRole('note')).toContainText('大文件');
  await reader.getByRole('button', { name: '下一片段', exact: true }).click();
  await expect(reader.locator('.markdown')).toContainText('当前大文件正文');
  await guest.close();
});

for (const authenticated of [false, true])
  test(`an editable parent share never grants editing of its referenced whiteboard (${authenticated ? 'owner' : 'anonymous'})`, async ({
    page,
    browser,
  }) => {
    const { headers, origin } = await seed(page);
    const boardResponse = await page.request.post('/api/notes', {
      headers,
      data: {
        folderPath: '00-Inbox',
        fileName: `share-board-${crypto.randomUUID()}.excalidraw`,
        content: JSON.stringify({
          type: 'excalidraw',
          version: 2,
          elements: [],
          appState: { viewBackgroundColor: '#ffffff' },
          files: {},
        }),
        requestId: crypto.randomUUID(),
      },
    });
    expect(boardResponse.status()).toBe(201);
    const board = await boardResponse.json();
    const { note } = await seed(
      page,
      `# 含引用白板的分享\n\n\`\`\`excalidraw\n${board.id}\n\`\`\`\n\n父笔记正文。`,
    );
    const share = await (
      await page.request.post(`/api/notes/${note.id}/share`, {
        headers,
        data: { permission: 'edit' },
      })
    ).json();
    const status = await (await page.request.get(`/api/notes/${board.id}/share`)).json();
    expect(status.editSupported).toBe(false);
    expect(status.editUnavailableReason).toContain('白板');
    const guest = await browser.newContext();
    if (authenticated) await guest.addCookies(JSON.parse(await readFile(cookiesPath, 'utf8')));
    const reader = await guest.newPage();
    const privateRequests: string[] = [],
      boardResponses: number[] = [];
    reader.on('response', (response) => {
      if (
        new URL(response.url()).pathname ===
        `/api/public/shares/${share.token}/whiteboards/${board.id}`
      )
        boardResponses.push(response.status());
    });
    reader.on('request', (r) => {
      const path = new URL(r.url()).pathname;
      if (path.startsWith('/api/') && !path.startsWith('/api/public/')) privateRequests.push(path);
    });
    await reader.goto(origin + share.url);
    await expect(reader.locator('.diagram-card')).toBeVisible();
    await expect(reader.getByRole('button', { name: '编辑设计', exact: true })).toHaveCount(0);
    await reader.getByRole('button', { name: '编辑笔记', exact: true }).click();
    await expect(
      reader.locator('.public-share-editor .document-diagram .diagram-card'),
    ).toBeVisible();
    await expect.poll(() => boardResponses).toEqual([200, 200]);
    await expect(reader.locator('.public-share-editor .diagram-state[role=status]')).toHaveCount(0);
    await expect(reader.getByRole('button', { name: '编辑设计', exact: true })).toHaveCount(0);
    await expect(reader.getByRole('button', { name: '编辑源码', exact: true })).toHaveCount(0);
    await expect(reader.getByRole('button', { name: '生成通用预览', exact: true })).toHaveCount(0);
    await expect(reader.locator('.public-share-editor .diagram-card [role=alert]')).toHaveCount(0);
    expect(privateRequests).toEqual([]);
    await reader.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
    await expect(reader.locator('.cm-content')).toContainText(board.id);
    await expect(reader.getByRole('button', { name: '编辑设计', exact: true })).toHaveCount(0);
    expect(privateRequests).toEqual([]);
    await guest.close();
  });

test('late owner share responses cannot open a dialog for a different note', async ({ page }) => {
  const { note: a } = await seed(page, '# 分享迟到A\n\nA的正文。');
  const { note: b } = await seed(page, '# 分享迟到B\n\nB的正文。');
  await page.goto('/?note=' + a.id);
  await expect(page.getByRole('textbox', { name: '文档正文', exact: true })).toBeVisible();
  let release!: () => void, started!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve)),
    captured = new Promise<void>((resolve) => (started = resolve));
  await page.route(`**/api/notes/${a.id}/share`, async (route) => {
    const response = await route.fetch();
    started();
    await hold;
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: '分享', exact: true }).click();
  await captured;
  if (test.info().project.name === 'mobile')
    await page.getByRole('button', { name: '打开侧栏', exact: true }).click();
  const folder = page.getByRole('button', { name: '展开 00-Inbox', exact: true });
  if ((await folder.count()) && (await folder.getAttribute('aria-expanded')) === 'false')
    await folder.click();
  await page
    .locator('.tree-scroll')
    .getByRole('button', { name: b.relativePath.split('/').at(-1), exact: true })
    .first()
    .click();
  await expect(page.getByRole('textbox', { name: '文档正文', exact: true })).toContainText(
    'B的正文',
  );
  release();
  await page.waitForResponse((r) => r.url().endsWith(`/api/notes/${a.id}/share`));
  await expect(page.locator('.share-dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '分享', exact: true }).click();
  await expect(page.locator('.share-title')).toContainText('分享迟到B');
});

test('a late owner share failure does not place an error on the next note', async ({ page }) => {
  const { note: a } = await seed(page, '# 分享失败A\n\nA的正文。');
  const { note: b } = await seed(page, '# 分享失败B\n\nB的正文。');
  await page.goto('/?note=' + a.id);
  await expect(page.getByRole('textbox', { name: '文档正文', exact: true })).toBeVisible();
  let release!: () => void, started!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve)),
    captured = new Promise<void>((resolve) => (started = resolve));
  await page.route(`**/api/notes/${a.id}/share`, async (route) => {
    started();
    await hold;
    await route.fulfill({ status: 503, json: { error: 'A笔记分享失败，不能显示在B上' } });
  });
  await page.getByRole('button', { name: '分享', exact: true }).click();
  await captured;
  if (test.info().project.name === 'mobile')
    await page.getByRole('button', { name: '打开侧栏', exact: true }).click();
  const folder = page.getByRole('button', { name: '展开 00-Inbox', exact: true });
  if ((await folder.count()) && (await folder.getAttribute('aria-expanded')) === 'false')
    await folder.click();
  await page
    .locator('.tree-scroll')
    .getByRole('button', { name: b.relativePath.split('/').at(-1), exact: true })
    .first()
    .click();
  await expect(page.getByRole('textbox', { name: '文档正文', exact: true })).toContainText(
    'B的正文',
  );
  release();
  await page.waitForResponse((r) => r.url().endsWith(`/api/notes/${a.id}/share`));
  await expect(page.getByText('A笔记分享失败，不能显示在B上', { exact: true })).toHaveCount(0);
  await expect(page.locator('.share-dialog')).toHaveCount(0);
});

for (const authenticated of [false, true])
  test(`existing images load through the current share in rich editing (${authenticated ? 'owner' : 'anonymous'})`, async ({
    page,
    browser,
  }) => {
    const { note, headers, origin } = await seed(page);
    const upload = await page.request.post(`/api/notes/${note.id}/assets`, {
      headers,
      multipart: {
        file: {
          name: 'public-existing.png',
          mimeType: 'image/png',
          buffer: Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN9sAAAAASUVORK5CYII=',
            'base64',
          ),
        },
      },
    });
    expect(upload.status()).toBe(201);
    const asset = await upload.json();
    const current = await (await page.request.get(`/api/notes/${note.id}`)).json();
    expect(
      (
        await page.request.put(`/api/notes/${note.id}`, {
          headers,
          data: {
            content: `# 已有图片分享\n\n![现有图片](${asset.markdownPath})\n\n保留图片的正文。`,
            expectedModifiedAt: current.modifiedAt,
            requestId: crypto.randomUUID(),
          },
        })
      ).ok(),
    ).toBe(true);
    const share = await (
      await page.request.post(`/api/notes/${note.id}/share`, {
        headers,
        data: { permission: 'edit' },
      })
    ).json();
    const guest = await browser.newContext();
    if (authenticated) await guest.addCookies(JSON.parse(await readFile(cookiesPath, 'utf8')));
    const reader = await guest.newPage();
    const privateRequests: string[] = [];
    const publicAssets: string[] = [];
    reader.on('request', (r) => {
      const path = new URL(r.url()).pathname;
      if (path.startsWith('/api/') && !path.startsWith('/api/public/')) privateRequests.push(path);
      if (path.startsWith(`/api/public/shares/${share.token}/asset`)) publicAssets.push(path);
    });
    await reader.goto(origin + share.url);
    await expect
      .poll(() =>
        reader.locator('.markdown img').evaluate((img) => (img as HTMLImageElement).naturalWidth),
      )
      .toBe(1);
    await reader.getByRole('button', { name: '编辑笔记', exact: true }).click();
    const image = reader
      .getByRole('textbox', { name: '文档正文', exact: true })
      .locator('img[alt="现有图片"]');
    await expect(image).toHaveAttribute('src', /^blob:/);
    await expect
      .poll(() => image.evaluate((img) => (img as HTMLImageElement).naturalWidth))
      .toBe(1);
    expect(privateRequests).toEqual([]);
    expect(publicAssets.length).toBeGreaterThan(1);
    await reader
      .getByRole('textbox', { name: '文档正文', exact: true })
      .locator('p')
      .last()
      .fill('修改正文并保留现有图片。');
    await reader.getByRole('button', { name: '保存修改', exact: true }).click();
    await expect(reader.locator('.public-save-state')).toHaveText('已保存');
    const saved = await (await page.request.get(`/api/notes/${note.id}`)).json();
    expect(saved.content).toContain(asset.markdownPath);
    expect(saved.content).toContain('修改正文并保留现有图片');
    expect(saved.content).not.toContain(share.token);
    expect(privateRequests).toEqual([]);
    await guest.close();
  });

test('dark share reading and editing keep readable contrast', async ({ page }) => {
  const { note, headers, origin } = await seed(page);
  const share = await (
    await page.request.post(`/api/notes/${note.id}/share`, {
      headers,
      data: { permission: 'edit' },
    })
  ).json();
  await page.goto(origin + share.url);
  await expect(page.locator('.reader-title')).toBeVisible();
  await page.evaluate(async () => {
    const path = '/preferences.ts';
    const preferences = await import(path);
    preferences.setEditorPreferences({ theme: 'dark' });
  });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  async function contrast(selector: string) {
    return page.locator(selector).evaluate((element) => {
      const fg = getComputedStyle(element).color,
        bg = getComputedStyle(document.querySelector('.share-page')!).backgroundColor;
      const luminance = (color: string) => {
        const values = color
          .match(/[\d.]+/g)!
          .slice(0, 3)
          .map(Number)
          .map((v) => {
            const c = v / 255;
            return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
          });
        return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2];
      };
      const a = luminance(fg),
        b = luminance(bg);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });
  }
  expect(await contrast('.reader-title')).toBeGreaterThanOrEqual(4.5);
  await page.getByRole('button', { name: '编辑笔记', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '文档正文', exact: true })).toBeVisible();
  expect(await contrast('.public-share-editor .tiptap')).toBeGreaterThanOrEqual(4.5);
});

test('changing permission preserves a still-valid expiry within the current displayed minute', async ({
  page,
}) => {
  const { note, headers } = await seed(page);
  const expiresAt = '2030-01-02T12:00:45.789Z';
  const created = await page.request.post(`/api/notes/${note.id}/share`, {
    headers,
    data: { permission: 'view', expiresAt },
  });
  expect(created.ok()).toBe(true);
  const previous = await created.json();
  await page.clock.setFixedTime(new Date('2030-01-02T12:00:20.123Z'));
  await openShare(page, note.id);
  await expect(page.getByLabel('自定义到期时间', { exact: true })).toHaveValue('2030-01-02T12:00');
  await page.getByLabel('分享权限', { exact: true }).selectOption('edit');
  await page.getByRole('button', { name: '保存分享设置', exact: true }).click();
  await expect(page.getByText('分享设置已保存', { exact: true })).toBeVisible();
  const saved = await (await page.request.get(`/api/notes/${note.id}/share`)).json();
  expect(saved.permission).toBe('edit');
  expect(saved.expiresAt).toBe(expiresAt);
  expect(saved.url).toBe(previous.url);
});
