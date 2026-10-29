import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { test, expect } from '../support/browser-test';

test.setTimeout(120000);
async function owner(page: Page) {
  await page.context().addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const headers = { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token };
  const settings = await (await page.request.get('/api/blog/settings')).json();
  const updated = await page.request.patch('/api/blog/settings', {
    headers,
    data: {
      settings: {
        ...settings,
        title: '慢慢生长的花园',
        author: 'Bandoo',
        description: '记录、创造与分享',
        enabled: true,
      },
      requestId: randomUUID(),
    },
  });
  expect(updated.ok()).toBe(true);
  return headers;
}
async function seed(page: Page, headers: Record<string, string>, title: string, publish = true) {
  const content = `---\nprivate: STUDIO_PRIVATE_PROPERTY\n---\n# ${title}\n\n慢慢积累的知识，会长成自己的花园。\n\n## 整理方法\n\n从一个小想法开始。\n\n## 实际操作\n\n\`\`\`ts\nconst garden = 'grow';\n\`\`\`\n\n## 继续探索\n\n保持好奇。`;
  const created = await page.request.post('/api/notes', {
    headers,
    data: {
      folderPath: '00-Inbox',
      fileName: 'studio-' + randomUUID() + '.md',
      content,
      requestId: randomUUID(),
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const note = await created.json();
  const response = publish
    ? await page.request.post('/api/blog/publish', {
        headers,
        data: {
          noteId: note.id,
          expectedModifiedAt: note.modifiedAt,
          expectedContentHash: createHash('sha256').update(content).digest('hex'),
          expectedPublicationVersion: 0,
          metadata: {
            slug: 'studio-' + randomUUID().slice(0, 8),
            title,
            summary: '一些关于个人知识与持续创造的记录。',
            category: '知识与创造',
            tags: ['数字花园'],
          },
          requestId: randomUUID(),
        },
      })
    : await page.request.post('/api/blog/posts', {
        headers,
        data: { sourceNoteId: note.id, requestId: randomUUID() },
      });
  expect(response.ok(), await response.text()).toBe(true);
  return { note, post: await response.json() };
}

test('homepage studio previews privately, publishes all configured content and restores history', async ({
  page,
  browser,
}, info) => {
  const headers = await owner(page);
  const marker = '装修-' + info.project.name;
  const first = await seed(page, headers, marker + ' 让知识慢慢生长');
  const second = await seed(page, headers, marker + ' 记录正在创造的事情');
  const guest = await browser.newContext({
    baseURL: 'http://127.0.0.1:4179',
    viewport: page.viewportSize()!,
    isMobile: info.project.name === 'mobile',
    hasTouch: info.project.name === 'mobile',
  });
  const visitor = await guest.newPage();
  const identity = 'Bandoo 的数字花园 ' + info.project.name;
  try {
    await page.goto('/?view=apps&app=blog&appSection=design');
    await expect(page.getByRole('heading', { name: '装修主页', exact: true })).toBeVisible();
    await page.getByRole('button', { name: /^个人主页 从你出发/ }).click();
    await page.getByLabel('姓名', { exact: true }).fill(identity);
    await page.getByLabel('一句话介绍', { exact: true }).fill('把值得记录的日常，慢慢变成作品。');
    await page.getByLabel('个人简介', { exact: true }).fill('一个关于技术、生活与个人知识的空间。');
    const imageBase64 = await page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 160;
      c.height = 120;
      const x = c.getContext('2d')!;
      x.fillStyle = '#44684f';
      x.fillRect(0, 0, 160, 120);
      x.fillStyle = '#e8c77d';
      x.fillRect(45, 25, 70, 70);
      return c.toDataURL('image/png').split(',')[1];
    });
    const avatar = page.locator('.blog-profile-media .blog-image-editor').first();
    await avatar.locator('input[type=file]').setInputFiles({
      name: 'avatar.png',
      mimeType: 'image/png',
      buffer: Buffer.from(imageBase64, 'base64'),
    });
    await expect
      .poll(() =>
        avatar.locator('.blog-crop-window img').evaluate((e: HTMLImageElement) => e.naturalWidth),
      )
      .toBeGreaterThan(0);
    await avatar.getByRole('button', { name: '裁切并上传', exact: true }).click();
    await expect(page.getByAltText('当前头像')).toBeVisible();
    const privateImage = (await page.getByAltText('当前头像').getAttribute('src'))!;
    const publicImage = privateImage.replace('/api/blog/design/media/', '/blog/media/');
    expect((await guest.request.get(publicImage)).status()).toBe(404);
    const preview = page.frameLocator('iframe[title="博客主页草稿预览"]');
    await expect(preview.getByRole('heading', { name: identity, exact: true })).toBeVisible();
    await expect(preview.locator('html')).toHaveAttribute('data-template', 'profile');
    await expect.poll(() => preview.locator('html').evaluate(() => innerWidth)).toBe(1100);
    await page.getByRole('button', { name: '手机', exact: true }).click();
    await expect.poll(() => preview.locator('html').evaluate(() => innerWidth)).toBe(375);
    await page.getByRole('button', { name: '桌面', exact: true }).click();
    await expect.poll(() => preview.locator('html').evaluate(() => innerWidth)).toBe(1100);
    await page.getByRole('button', { name: '首页模块', exact: true }).click();
    const latest = page
      .locator('.blog-edit-list-item')
      .filter({ has: page.locator('.blog-badge', { hasText: '最近更新' }) });
    await latest.getByLabel('模块标题').fill('新近写作');
    await latest.getByRole('button', { name: '上移模块 新近写作', exact: true }).click();
    await page.getByRole('button', { name: '项目作品', exact: true }).click();
    await page.getByRole('button', { name: '＋ 添加项目', exact: true }).click();
    await page.getByLabel('项目名称').last().fill('DooKnow');
    await page.getByLabel('项目地址').last().fill('https://example.com/dooknow');
    await page.getByLabel('项目介绍').last().fill('让知识长在自己的土地上。');
    await page.getByRole('button', { name: '专题合集', exact: true }).click();
    await page.getByRole('button', { name: '＋ 添加专题', exact: true }).click();
    await page
      .getByLabel('专题名称')
      .last()
      .fill('从记录到创造 ' + marker);
    await page
      .getByLabel('专题路径')
      .last()
      .fill('create-' + info.project.name);
    await page.getByLabel('专题介绍').last().fill('按照自己的节奏，读完一组相关的文章。');
    const collection = page.locator('.blog-edit-list-item').last();
    await collection.getByText('从已发布文章中添加', { exact: true }).click();
    await collection.getByRole('button', { name: '＋ ' + second.post.title, exact: true }).click();
    await collection.getByRole('button', { name: '＋ ' + first.post.title, exact: true }).click();
    await visitor.goto('/blog');
    await expect(visitor.locator('body')).not.toContainText(identity);
    await page.getByRole('button', { name: '保存装修草稿', exact: true }).click();
    await expect(page.getByRole('button', { name: '发布主页', exact: true })).toBeEnabled();
    await visitor.reload();
    await expect(visitor.locator('body')).not.toContainText(identity);
    await page.getByRole('button', { name: '发布主页', exact: true }).click();
    await expect(page.locator('.blog-studio > .blog-section-title .blog-badge')).toHaveText(
      '与线上一致',
    );
    await visitor.reload();
    await expect(visitor.getByRole('heading', { name: identity, exact: true })).toBeVisible();
    await expect(visitor.getByRole('heading', { name: '新近写作', exact: true })).toBeVisible();
    await expect(visitor.getByRole('link', { name: 'DooKnow', exact: true })).toBeVisible();
    expect((await guest.request.get(publicImage)).status()).toBe(200);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    expect(
      await visitor.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    ).toBe(true);
    await page.getByRole('button', { name: '主题与个人资料', exact: true }).click();
    await expect(preview.getByRole('heading', { name: '新近写作', exact: true })).toBeVisible();
    await expect(preview.getByRole('link', { name: 'DooKnow', exact: true })).toBeVisible();
    await page
      .locator('.blog-studio')
      .evaluate((element) => element.scrollIntoView({ block: 'start' }));
    await page.screenshot({
      path: info.outputPath('studio-editor.png'),
      fullPage: true,
      animations: 'disabled',
    });
    await visitor.screenshot({
      path: info.outputPath('profile-home.png'),
      fullPage: true,
      animations: 'disabled',
    });
    await visitor.getByRole('link', { name: '从记录到创造 ' + marker, exact: true }).click();
    const titles = await visitor.locator('.collection-articles .post-card h2').allTextContents();
    expect(titles).toEqual([second.post.title, first.post.title]);
    await page.getByRole('button', { name: '主题与个人资料', exact: true }).click();
    await page.getByLabel('姓名', { exact: true }).fill('只存在于草稿中的名字');
    await page.getByRole('button', { name: '保存装修草稿', exact: true }).click();
    await expect(page.getByRole('button', { name: '发布主页', exact: true })).toBeEnabled();
    await visitor.goto('/blog');
    await expect(visitor.getByRole('heading', { name: identity, exact: true })).toBeVisible();
    await page.getByText('发布历史', { exact: false }).last().click();
    await page.getByRole('button', { name: '恢复到草稿', exact: true }).first().click();
    await expect(page.getByLabel('姓名', { exact: true })).toHaveValue(identity);
  } finally {
    await guest.close();
  }
});

test('all themes render public content and reader discovery, code copy and link sharing work', async ({
  page,
  browser,
}, info) => {
  const headers = await owner(page);
  const marker = '阅读-' + info.project.name + '-' + randomUUID().slice(0, 6);
  const first = await seed(page, headers, marker + ' 第一篇');
  const second = await seed(page, headers, marker + ' 第二篇');
  const privatePost = await seed(page, headers, marker + ' 私有草稿', false);
  const guest = await browser.newContext({
    baseURL: 'http://127.0.0.1:4179',
    viewport: page.viewportSize()!,
    isMobile: info.project.name === 'mobile',
    hasTouch: info.project.name === 'mobile',
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const visitor = await guest.newPage();
  try {
    for (const template of ['journal', 'magazine', 'profile']) {
      const state = await (await page.request.get('/api/blog/design')).json();
      const saved = await page.request.patch('/api/blog/design', {
        headers,
        data: {
          design: { ...state.draft, template },
          expectedVersion: state.version,
          requestId: randomUUID(),
        },
      });
      expect(saved.ok(), await saved.text()).toBe(true);
      const published = await page.request.post('/api/blog/design/publish', {
        headers,
        data: { expectedVersion: (await saved.json()).version, requestId: randomUUID() },
      });
      expect(published.ok()).toBe(true);
      await visitor.goto('/blog');
      await expect(visitor.locator('html')).toHaveAttribute('data-template', template);
      expect(
        await visitor.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      ).toBe(true);
      await visitor.screenshot({
        path: info.outputPath(template + '-home.png'),
        fullPage: true,
        animations: 'disabled',
      });
    }
    await visitor.goto('/blog/-/articles?q=' + encodeURIComponent(marker) + '&pageSize=1');
    await expect(visitor.locator('.filter-status')).toContainText('共 2 篇文章');
    await expect(visitor.locator('.article-index .post-card')).toHaveCount(1);
    const one = await visitor.locator('.article-index .post-card h2').textContent();
    await visitor.getByRole('link', { name: '下一页 →', exact: true }).click();
    await expect(visitor.locator('.pagination')).toContainText('第 2 / 2 页');
    expect(await visitor.locator('.article-index .post-card h2').textContent()).not.toBe(one);
    await visitor.getByLabel('搜索公开文章').fill(marker + ' 私有草稿');
    await visitor.getByRole('button', { name: '搜索', exact: true }).click();
    await expect(
      visitor.getByRole('heading', { name: '没有匹配的文章', exact: true }),
    ).toBeVisible();
    expect((await guest.request.get('/blog/' + privatePost.post.slug)).status()).toBe(404);
    await visitor.goto('/blog/' + first.post.slug);
    await expect(visitor.locator('body')).not.toContainText('STUDIO_PRIVATE_PROPERTY');
    await expect(visitor.getByRole('button', { name: '复制代码', exact: true })).toBeVisible();
    await visitor.getByRole('button', { name: '复制代码', exact: true }).click();
    await expect(visitor.locator('[data-reader-status]')).toHaveText('代码已复制');
    expect(await visitor.evaluate(() => navigator.clipboard.readText())).toContain(
      "const garden = 'grow';",
    );
    await visitor.getByRole('button', { name: '复制链接', exact: true }).click();
    await expect(visitor.locator('[data-reader-status]')).toHaveText('链接已复制');
    expect(await visitor.evaluate(() => navigator.clipboard.readText())).toContain(
      '/blog/' + first.post.slug,
    );
    await expect(visitor.getByRole('navigation', { name: '相邻文章' })).toBeVisible();
    await visitor.screenshot({
      path: info.outputPath('reader.png'),
      fullPage: true,
      animations: 'disabled',
    });
    await page.goto('/?view=apps&app=blog&appSection=articles');
    await page.locator('.blog-post-option').filter({ hasText: first.post.title }).click();
    await page.getByRole('button', { name: '预览文章', exact: true }).click();
    await expect(page.getByRole('heading', { name: '发布前核对', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: '线上与待发版本对照' })).toContainText(
      '线上版本',
    );
    await page.screenshot({
      path: info.outputPath('publication-review.png'),
      fullPage: true,
      animations: 'disabled',
    });
    const current = await (await page.request.get('/api/blog/posts/' + second.post.id)).json();
    const withdrawn = await page.request.post('/api/blog/unpublish', {
      headers,
      data: {
        noteId: second.note.id,
        expectedPublicationVersion: current.post.version,
        requestId: randomUUID(),
      },
    });
    expect(withdrawn.ok()).toBe(true);
    expect((await guest.request.get('/blog/' + second.post.slug)).status()).toBe(404);
  } finally {
    await guest.close();
  }
});
