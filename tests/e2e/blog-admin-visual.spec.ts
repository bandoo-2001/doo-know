import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { test, expect } from '../support/browser-test';

test.setTimeout(120000);
test('management sections remain readable and actionable at screenshot and phone sizes', async ({
  page,
  context,
}, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  if (info.project.name === 'desktop') await page.setViewportSize({ width: 1094, height: 870 });
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const headers = { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token };
  const settings = await (await page.request.get('/api/blog/settings')).json();
  expect(
    (
      await page.request.patch('/api/blog/settings', {
        headers,
        data: { settings: { ...settings, enabled: false }, requestId: randomUUID() },
      })
    ).ok(),
  ).toBe(true);
  let dashboard = await (await page.request.get('/api/blog')).json();
  for (const post of dashboard.posts) {
    expect(
      (
        await page.request.patch('/api/blog/posts/' + post.id, {
          headers,
          data: {
            expectedVersion: post.version,
            metadata: { category: '', tags: [] },
            requestId: randomUUID(),
          },
        })
      ).ok(),
    ).toBe(true);
  }
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const capture = async (name: string) => {
    await page
      .locator('.blog-admin')
      .evaluate((element) => element.scrollIntoView({ block: 'start' }));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    await page.screenshot({
      path: info.outputPath(name + '.png'),
      fullPage: true,
      animations: 'disabled',
    });
  };
  await page.goto('/?view=apps&app=blog&appSection=taxonomy');
  await expect(page.getByRole('heading', { name: '还没有分类', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '还没有标签', exact: true })).toBeVisible();
  await capture('taxonomy-empty');

  const samples = [
    {
      title: '把知识整理成可以分享的文章',
      category: '知识管理',
      tags: ['写作', '整理方法'],
      published: true,
    },
    {
      title: '最近在折腾的工具与自动化',
      category: '开发札记',
      tags: ['工具', '自动化'],
      published: false,
    },
    {
      title: '从零搭建数字花园：让很长的文章标题也能保持清晰的阅读层级与完整的操作入口',
      category: '阅读与个人知识整理的长期实践',
      tags: ['持续记录', 'a-very-long-tag-that-still-needs-to-wrap-without-breaking-the-layout'],
      published: false,
    },
  ];
  const posts: any[] = [];
  for (const sample of samples) {
    const content =
      '# ' +
      sample.title +
      '\n\n把零散的记录整理成有结构的文章。\n\n## 从一个问题开始\n\n记录自己的观察和实践。\n\n## 留给读者一条线索\n\n继续探索相关的主题。';
    const created = await page.request.post('/api/notes', {
      headers,
      data: {
        folderPath: '00-Inbox',
        fileName: 'admin-visual-' + randomUUID() + '.md',
        content,
        requestId: randomUUID(),
      },
    });
    expect(created.status()).toBe(201);
    const note = await created.json();
    const metadata = {
      title: sample.title,
      category: sample.category,
      tags: sample.tags,
      summary: '关于记录、整理与持续创造的一些实践。为值得分享的内容，留出清楚的表达空间。',
    };
    const response = sample.published
      ? await page.request.post('/api/blog/publish', {
          headers,
          data: {
            noteId: note.id,
            expectedModifiedAt: note.modifiedAt,
            expectedContentHash: createHash('sha256').update(content).digest('hex'),
            expectedPublicationVersion: 0,
            metadata,
            requestId: randomUUID(),
          },
        })
      : await page.request.post('/api/blog/posts', {
          headers,
          data: { sourceNoteId: note.id, metadata, requestId: randomUUID() },
        });
    expect(response.ok(), await response.text()).toBe(true);
    posts.push(await response.json());
  }
  const headings = {
    overview: '概览',
    articles: '文章',
    taxonomy: '分类与标签',
    settings: '站点设置',
    design: '装修主页',
  };
  for (const section of ['overview', 'articles', 'taxonomy', 'settings', 'design'] as const) {
    await page.goto('/?view=apps&app=blog&appSection=' + section);
    await expect(
      page.getByRole('heading', { name: headings[section], exact: true }).first(),
    ).toBeVisible();
    if (section === 'articles') {
      await page.locator('.blog-post-option').filter({ hasText: samples[2]!.title }).click();
      await expect(page.getByRole('region', { name: '文章发布设置' })).toBeVisible();
      await expect(page.getByRole('button', { name: '保存文章信息', exact: true })).toBeVisible();
    }
    if (section === 'settings') {
      const title = page.getByLabel('站点名称', { exact: true }),
        value = await title.inputValue();
      await title.fill(value + ' · 草稿');
      await expect(page.getByText('有未保存修改，保存后生效', { exact: true })).toBeVisible();
      await capture('settings-unsaved');
      await title.fill(value);
    }
    if (section === 'design') {
      await expect(
        page.frameLocator('iframe[title="博客主页草稿预览"]').locator('html[data-template]'),
      ).toBeVisible();
    }
    await capture(section);
  }
  await page.getByRole('button', { name: '放大预览', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '主页预览', exact: true });
  await expect(dialog).toBeVisible();
  await page.screenshot({
    path: info.outputPath('expanded-preview.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await dialog.getByRole('button', { name: '关闭预览', exact: true }).click();

  await page.goto('/?view=apps&app=blog&appSection=taxonomy');
  await page.getByRole('textbox', { name: '搜索分类与标签' }).fill('知识');
  await expect(page.locator('.blog-category').filter({ hasText: '知识管理' })).toBeVisible();
  await capture('taxonomy-search');
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await capture('taxonomy-dark');
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
  if (info.project.name === 'desktop') {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/?view=apps&app=blog&appSection=design');
    await expect(page.getByRole('heading', { name: '装修主页', exact: true })).toBeVisible();
    await capture('design-wide');
  }
  expect(errors).toEqual([]);
  dashboard = await (await page.request.get('/api/blog')).json();
  expect(dashboard.settings.enabled).toBe(false);
});
