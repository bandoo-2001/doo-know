import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';
import { showSidebar } from '../support/settings-navigation';

test.use({ sourceEditorPreference: true });
test('blog manual publication keeps the original and public snapshots independent', async ({
  page,
  context,
  browser,
}, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const headers = { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token };
  const initialSettings = await (await page.request.get('/api/blog/settings')).json();
  if (initialSettings.enabled)
    expect(
      (
        await page.request.patch('/api/blog/settings', {
          headers,
          data: {
            settings: { ...initialSettings, enabled: false },
            requestId: crypto.randomUUID(),
          },
        })
      ).ok(),
    ).toBe(true);
  const create = await page.request.post('/api/notes', {
    headers,
    data: {
      folderPath: '00-Inbox',
      fileName: 'blog-' + info.project.name + '-' + crypto.randomUUID() + '.md',
      content:
        '# Private source title\n\nFirst published body.\n\n```mermaid\ngraph TD\n A[First] --> B[Second]\n```',
      requestId: crypto.randomUUID(),
    },
  });
  expect(create.status()).toBe(201);
  const note = await create.json();
  const original = note.content;
  await page.goto('/?view=apps');
  await expect(page.getByRole('heading', { name: '应用', exact: true })).toBeVisible();
  await page.screenshot({
    path: `logs.local/blog-feature-20261026/web/${info.project.name}-apps.jpg`,
    type: 'jpeg',
    quality: 65,
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: /博客.*把值得分享/ }).click();
  await expect(page.getByRole('heading', { name: '博客', exact: true })).toBeVisible();
  await expect(
    page.getByText('站点尚未开启。你可以先准备文章，开启后已发布内容才会公开。'),
  ).toBeVisible();
  await page.screenshot({
    path: `logs.local/blog-feature-20261026/web/${info.project.name}-overview.jpg`,
    type: 'jpeg',
    quality: 65,
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: '选择笔记', exact: true }).first().click();
  await page
    .getByRole('textbox', { name: '搜索待选笔记' })
    .fill(note.relativePath.split('/').at(-1)!);
  await page.locator('.blog-picker-notes button').first().click();
  await expect(page.getByRole('region', { name: '文章发布设置' })).toBeVisible();
  await page.getByLabel('文章标题', { exact: true }).fill('A quiet place to think');
  await page
    .getByLabel('摘要', { exact: true })
    .fill('Notes on making space for the ideas that matter.');
  await page.getByLabel('分类', { exact: true }).fill('生活与思考 ' + info.project.name);
  await page.getByLabel('标签', { exact: true }).fill('知识管理，随笔');
  await expect(page.getByRole('button', { name: '发布文章', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '保存文章信息', exact: true }).click();
  await page.getByRole('button', { name: '预览文章', exact: true }).click();
  await expect(page.getByRole('article', { name: '文章预览' })).toContainText(
    'First published body.',
  );
  await page.getByRole('button', { name: '发布文章', exact: true }).click();
  await expect(page.locator('.blog-article-detail .blog-badge')).toHaveText('已发布', {
    timeout: 60000,
  });
  const dashboard = await (await page.request.get('/api/blog')).json();
  const post = dashboard.posts.find((p: any) => p.sourceNoteId === note.id);
  expect(post).toBeTruthy();
  const unchanged = await (await page.request.get('/api/notes/' + note.id)).json();
  expect(unchanged.content).toBe(original);
  await page.getByRole('button', { name: '站点设置', exact: true }).click();
  await page.getByRole('checkbox', { name: '开启博客站点' }).check();
  await page.getByRole('button', { name: '保存站点设置', exact: true }).click();
  await expect(page.getByText('站点已开启，已发布文章可公开访问。')).toBeVisible();
  const guest = await browser.newContext({ baseURL: 'http://127.0.0.1:4179' });
  const visitor = await guest.newPage();
  const publicUrl = '/blog/' + post.slug;
  await visitor.goto(publicUrl);
  await expect(visitor.locator('body')).toContainText('First published body.');
  await expect(visitor.locator('body')).not.toContainText(note.id);
  await expect(visitor.locator('img').first()).toBeVisible();
  await visitor.screenshot({
    path: `logs.local/blog-feature-20261026/web/${info.project.name}-public.jpg`,
    type: 'jpeg',
    quality: 65,
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: '文章', exact: true }).click();
  await page.getByRole('button', { name: '编辑原稿', exact: true }).click();
  await expect(page.locator('.cm-content')).toBeVisible();
  await page
    .locator('.cm-content')
    .fill('# Private edited title\n\nSecond source body, explicitly updated.');
  await showSidebar(page);
  await page
    .locator('.workspace-footer')
    .getByRole('button', { name: '应用', exact: true })
    .click();
  await expect(page.locator('.blog-article-detail')).toBeVisible();
  await page.getByRole('button', { name: '编辑原稿', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('Second source body');
  await expect(page.locator('.save-state')).toContainText('未保存');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.locator('.save-state')).toContainText('已保存');
  await showSidebar(page);
  await page
    .locator('.workspace-footer')
    .getByRole('button', { name: '应用', exact: true })
    .click();
  await expect(page.locator('.blog-article-detail .blog-badge')).toHaveText('有更新待发布');
  await visitor.reload();
  await expect(visitor.locator('body')).toContainText('First published body.');
  await expect(visitor.locator('body')).not.toContainText('Second source body');
  await page.getByRole('button', { name: '发布更新', exact: true }).click();
  await expect(page.locator('.blog-article-detail .blog-badge')).toHaveText('已发布');
  await visitor.reload();
  await expect(visitor.locator('body')).toContainText('Second source body');
  await page.getByRole('button', { name: '分类与标签', exact: true }).click();
  await expect(page.locator('.blog-taxonomy')).toContainText('生活与思考');
  await page
    .locator('.blog-category')
    .filter({ hasText: '生活与思考 ' + info.project.name })
    .click();
  await expect(page.locator('.blog-post-option')).toHaveCount(1);
  await page.screenshot({
    path: `logs.local/blog-feature-20261026/web/${info.project.name}-articles.jpg`,
    type: 'jpeg',
    quality: 65,
    fullPage: true,
    animations: 'disabled',
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({
    path: `logs.local/blog-feature-20261026/web/${info.project.name}-dark.jpg`,
    type: 'jpeg',
    quality: 65,
    fullPage: true,
    animations: 'disabled',
  });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
  });
  await page.getByRole('button', { name: '下架文章', exact: true }).click();
  await page.getByRole('button', { name: '确认下架', exact: true }).click();
  await expect(page.locator('.blog-article-detail .blog-badge')).toHaveText('已下架');
  expect((await visitor.goto(publicUrl))?.status()).toBe(404);
  await page.getByRole('button', { name: '站点设置', exact: true }).click();
  await page.getByRole('checkbox', { name: '开启博客站点' }).uncheck();
  await page.getByRole('button', { name: '保存站点设置', exact: true }).click();
  await expect(page.getByText('站点已关闭，公开页面不可访问。')).toBeVisible();
  expect((await visitor.goto('/blog'))?.status()).toBe(404);
  await page.getByRole('button', { name: '文章', exact: true }).click();
  await page.getByRole('button', { name: '移除选稿', exact: true }).click();
  await page.getByRole('button', { name: '确认移除', exact: true }).click();
  await expect(page.locator('.blog-article-detail')).toHaveCount(0);
  expect((await page.request.get('/api/notes/' + note.id)).status()).toBe(200);
  await guest.close();
});

test('blog preserves per-article edits through delayed reads and real version conflicts', async ({
  page,
  context,
}, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const headers = { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token };
  async function seed(name: string) {
    const created = await page.request.post('/api/notes', {
      headers,
      data: {
        folderPath: '00-Inbox',
        fileName: `blog-${name}-${crypto.randomUUID()}.md`,
        content: `# ${name}\n\nPrivate original ${name}`,
        requestId: crypto.randomUUID(),
      },
    });
    expect(created.ok()).toBe(true);
    const note = await created.json();
    const draft = await page.request.post('/api/blog/posts', {
      headers,
      data: {
        sourceNoteId: note.id,
        metadata: { title: `${name} ${info.project.name}` },
        requestId: crypto.randomUUID(),
      },
    });
    expect(draft.ok()).toBe(true);
    return { note, post: await draft.json() };
  }
  const a = await seed('First article'),
    b = await seed('Second article');
  await page.goto('/?view=apps&app=blog&appSection=articles');
  const option = (id: string) => page.locator('.blog-post-option').filter({ hasText: id });
  await option(a.post.title).click();
  await page.getByLabel('摘要', { exact: true }).fill('Keep my unsaved article summary');
  await option(b.post.title).click();
  await expect(page.getByLabel('文章标题', { exact: true })).toHaveValue(b.post.title);
  await option(a.post.title).click();
  await expect(page.getByLabel('摘要', { exact: true })).toHaveValue(
    'Keep my unsaved article summary',
  );
  await page.getByRole('button', { name: '分类与标签', exact: true }).click();
  await page.goBack();
  await expect(page.getByRole('button', { name: '文章', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByLabel('摘要', { exact: true })).toHaveValue(
    'Keep my unsaved article summary',
  );
  const remoteTitle = 'Remote title ' + info.project.name;
  const metadata = {
    slug: a.post.slug,
    title: remoteTitle,
    summary: a.post.summary,
    category: 'Remote category',
    tags: [],
    pinned: false,
    cover: null,
  };
  const changed = await page.request.patch('/api/blog/posts/' + a.post.id, {
    headers,
    data: { metadata, expectedVersion: a.post.version, requestId: crypto.randomUUID() },
  });
  expect(changed.ok()).toBe(true);
  await page.getByRole('button', { name: '保存文章信息', exact: true }).click();
  await expect(page.locator('.blog-article-detail [role=alert]')).toContainText('变化');
  await expect(page.getByLabel('摘要', { exact: true })).toHaveValue(
    'Keep my unsaved article summary',
  );
  await page.getByRole('button', { name: '重新核对', exact: true }).click();
  await expect(page.getByLabel('文章标题', { exact: true })).toHaveValue(remoteTitle);
  await expect(page.getByLabel('摘要', { exact: true })).toHaveValue(
    'Keep my unsaved article summary',
  );
  await expect(page.getByLabel('分类', { exact: true })).toHaveValue('Remote category');
  await page.getByRole('button', { name: '保存文章信息', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存文章信息', exact: true })).toBeDisabled();
  let release!: () => void, markReached!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve)),
    reached = new Promise<void>((resolve) => (markReached = resolve));
  await page.route('**/api/blog/posts/' + a.post.id, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    markReached();
    await hold;
    await route.fulfill({ response });
  });
  await option(remoteTitle).click();
  await reached;
  await option(b.post.title).click();
  await expect(page.getByLabel('文章标题', { exact: true })).toHaveValue(b.post.title);
  const response = page.waitForResponse(
    (r) => r.url().endsWith('/api/blog/posts/' + a.post.id) && r.request().method() === 'GET',
  );
  release();
  await response;
  await expect(page.getByLabel('文章标题', { exact: true })).toHaveValue(b.post.title);
  await page.unroute('**/api/blog/posts/' + a.post.id);
  await page.getByRole('button', { name: '站点设置', exact: true }).click();
  await page.getByLabel('站点名称', { exact: true }).fill('My pending site title');
  const current = await (await page.request.get('/api/blog/settings')).json();
  expect(
    (
      await page.request.patch('/api/blog/settings', {
        headers,
        data: {
          settings: { ...current, description: 'Remote description' },
          requestId: crypto.randomUUID(),
        },
      })
    ).ok(),
  ).toBe(true);
  await page.getByRole('button', { name: '保存站点设置', exact: true }).click();
  await expect(page.locator('.blog-settings [role=alert]')).toContainText('变化');
  await expect(page.getByLabel('站点名称', { exact: true })).toHaveValue('My pending site title');
  await page.getByRole('button', { name: '重新核对设置', exact: true }).click();
  await expect(page.getByLabel('站点简介', { exact: true })).toHaveValue('Remote description');
  await expect(page.getByLabel('站点名称', { exact: true })).toHaveValue('My pending site title');
  await page.getByRole('button', { name: '保存站点设置', exact: true }).click();
  await expect(page.locator('.blog-settings [role=alert]')).toHaveCount(0);
  for (const item of [a, b]) {
    const detail = await (await page.request.get('/api/blog/posts/' + item.post.id)).json();
    expect(
      (
        await page.request.delete('/api/blog/posts/' + item.post.id, {
          headers,
          data: { expectedVersion: detail.post.version, requestId: crypto.randomUUID() },
        })
      ).ok(),
    ).toBe(true);
    expect((await page.request.get('/api/notes/' + item.note.id)).status()).toBe(200);
  }
});

test('a failed post-save preview refresh cannot publish an unreviewed source in the next click', async ({
  page,
  context,
}, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const headers = { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token };
  const created = await page.request.post('/api/notes', {
    headers,
    data: {
      folderPath: '00-Inbox',
      fileName: `blog-preview-failure-${info.project.name}-${crypto.randomUUID()}.md`,
      content: '# Original\n\nOLD REVIEWED BODY',
      requestId: crypto.randomUUID(),
    },
  });
  expect(created.ok()).toBe(true);
  const note = await created.json();
  const draft = await page.request.post('/api/blog/posts', {
    headers,
    data: {
      sourceNoteId: note.id,
      metadata: { title: 'Preview failure ' + info.project.name },
      requestId: crypto.randomUUID(),
    },
  });
  expect(draft.ok()).toBe(true);
  const post = await draft.json();
  await page.goto('/?view=apps&app=blog&appSection=articles');
  await page.locator('.blog-post-option').filter({ hasText: post.title }).click();
  await page.getByRole('button', { name: '预览文章', exact: true }).click();
  await expect(page.getByRole('article', { name: '文章预览' })).toContainText('OLD REVIEWED BODY');
  expect(
    (
      await page.request.put('/api/notes/' + note.id, {
        headers,
        data: {
          content: '# Changed source\n\nNEW UNREVIEWED BODY',
          expectedModifiedAt: note.modifiedAt,
          requestId: crypto.randomUUID(),
        },
      })
    ).ok(),
  ).toBe(true);
  await page.getByLabel('文章标题', { exact: true }).fill('Saved metadata ' + info.project.name);
  let failRefresh = true,
    publishRequests = 0;
  await page.route('**/api/blog/posts/' + post.id, async (route) => {
    if (route.request().method() === 'GET' && failRefresh) {
      failRefresh = false;
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Preview refresh unavailable' }),
      });
      return;
    }
    await route.continue();
  });
  page.on('request', (request) => {
    if (request.url().endsWith('/api/blog/publish') && request.method() === 'POST')
      publishRequests++;
  });
  await page.getByRole('button', { name: '保存文章信息', exact: true }).click();
  await expect(page.locator('.blog-article-detail [role=alert]')).toContainText(
    'Preview refresh unavailable',
  );
  await expect(page.getByLabel('文章标题', { exact: true })).toHaveValue(
    'Saved metadata ' + info.project.name,
  );
  await expect(page.getByRole('article', { name: '文章预览' })).toContainText('OLD REVIEWED BODY');
  await page.getByRole('button', { name: '发布文章', exact: true }).click();
  await expect(page.getByRole('article', { name: '文章预览' })).toContainText(
    'NEW UNREVIEWED BODY',
  );
  await expect(page.locator('.blog-article-detail [role=alert]')).toContainText('重新核对');
  expect(publishRequests).toBe(0);
  const refreshed = await (await page.request.get('/api/blog/posts/' + post.id)).json();
  expect(refreshed.post.state).toBe('draft');
  await page.getByRole('button', { name: '发布文章', exact: true }).click();
  await expect(page.locator('.blog-article-detail .blog-badge')).toHaveText('已发布');
  expect(publishRequests).toBe(1);
  const finalDetail = await (await page.request.get('/api/blog/posts/' + post.id)).json();
  expect(
    (
      await page.request.delete('/api/blog/posts/' + post.id, {
        headers,
        data: { expectedVersion: finalDetail.post.version, requestId: crypto.randomUUID() },
      })
    ).ok(),
  ).toBe(true);
});
