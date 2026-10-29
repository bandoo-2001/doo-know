import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { test, expect } from '../support/browser-test';

async function prepareReader(page: Page, theme: 'light' | 'system') {
  await page.context().addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const headers = { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token };
  async function appearance(value: 'light' | 'system') {
    const settings = await (await page.request.get('/api/blog/settings')).json();
    const changed = await page.request.patch('/api/blog/settings', {
      headers,
      data: {
        settings: { ...settings, enabled: true, theme: value, title: 'Notebook' + 'a'.repeat(100) },
        requestId: randomUUID(),
      },
    });
    expect(changed.ok()).toBe(true);
  }
  await appearance(theme);
  const category = 'Reader category ' + randomUUID(),
    tag = 't'.repeat(80);
  const content = [
    '# Original source heading',
    'A link that should wrap: <https://example.invalid/' + 'a'.repeat(450) + '>',
    'Inline code: `' + 'c'.repeat(350) + '`.',
    '## Details',
    '```text\n' + 'LongCode'.repeat(50) + '\n```',
    '| One | Two | Three | Four | Five | Six |\n| --- | --- | --- | --- | --- | --- |\n| ' +
      Array.from({ length: 6 }, (_, index) => 'cell-' + index + '-' + 'x'.repeat(60)).join(' | ') +
      ' |',
    '### More',
    'A final paragraph, still the same published snapshot.',
  ].join('\n\n');
  const created = await page.request.post('/api/notes', {
    headers,
    data: {
      folderPath: '00-Inbox',
      fileName: 'public-polish-' + randomUUID() + '.md',
      content,
      requestId: randomUUID(),
    },
  });
  expect(created.status()).toBe(201);
  const note = await created.json();
  const published = await page.request.post('/api/blog/publish', {
    headers,
    data: {
      noteId: note.id,
      expectedModifiedAt: note.modifiedAt,
      expectedContentHash: createHash('sha256').update(content).digest('hex'),
      expectedPublicationVersion: 0,
      requestId: randomUUID(),
      metadata: {
        slug: 'reader-' + randomUUID().slice(0, 8),
        title: 'A readable title ' + 'r'.repeat(150),
        summary: 'A summary ' + 's'.repeat(240),
        category,
        tags: [tag],
      },
    },
  });
  expect(published.ok()).toBe(true);
  return { post: await published.json(), appearance, category, tag };
}

test('the anonymous reader follows the system appearance and respects an explicit light setting', async ({
  page,
  browser,
}, info) => {
  const { post, appearance } = await prepareReader(page, 'system');
  const guest = await browser.newContext({
    baseURL: 'http://127.0.0.1:4179',
    viewport: page.viewportSize()!,
    isMobile: info.project.name === 'mobile',
    hasTouch: info.project.name === 'mobile',
    colorScheme: 'dark',
  });
  try {
    const reader = await guest.newPage();
    await reader.goto('/blog/' + post.slug);
    await expect(reader.locator('html')).toHaveAttribute('data-theme', 'system');
    expect(
      await reader.locator('body').evaluate((element) => getComputedStyle(element).backgroundColor),
    ).toBe('rgb(21, 29, 25)');
    expect(
      await reader.locator('body').evaluate((element) => getComputedStyle(element).color),
    ).toBe('rgb(229, 236, 229)');
    await reader.screenshot({
      path: info.outputPath('public-reader-dark.jpg'),
      type: 'jpeg',
      quality: 65,
      fullPage: true,
      animations: 'disabled',
    });
    await reader.emulateMedia({ colorScheme: 'light' });
    expect(
      await reader.locator('body').evaluate((element) => getComputedStyle(element).backgroundColor),
    ).toBe('rgb(251, 250, 246)');
    await reader.emulateMedia({ colorScheme: 'dark' });
    await appearance('light');
    await reader.reload();
    await expect(reader.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(
      await reader.locator('body').evaluate((element) => getComputedStyle(element).backgroundColor),
    ).toBe('rgb(251, 250, 246)');
    expect(
      await reader.locator('html').evaluate((element) => getComputedStyle(element).colorScheme),
    ).toBe('light');
    await expect(reader.locator('.article-body h1')).toHaveText('Original source heading');
    await reader.screenshot({
      path: info.outputPath('public-reader-light.jpg'),
      type: 'jpeg',
      quality: 65,
      fullPage: true,
      animations: 'disabled',
    });
  } finally {
    await guest.close();
  }
});

test('public reading contains long content and provides keyboard and filter exits', async ({
  page,
  browser,
}, info) => {
  const { post, category } = await prepareReader(page, 'light');
  const guest = await browser.newContext({
    baseURL: 'http://127.0.0.1:4179',
    viewport: page.viewportSize()!,
    isMobile: info.project.name === 'mobile',
    hasTouch: info.project.name === 'mobile',
    colorScheme: 'light',
  });
  try {
    const reader = await guest.newPage();
    await reader.goto('/blog/' + post.slug);
    expect(await reader.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    for (const selector of ['.article-body pre', '.article-body table'])
      expect(
        await reader
          .locator(selector)
          .evaluate((element) => element.scrollWidth > element.clientWidth),
      ).toBe(true);
    const titleSize = await reader
      .locator('article > h1')
      .evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
    const bodyHeadingSize = await reader
      .locator('.article-body h1')
      .evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
    expect(titleSize).toBeGreaterThan(bodyHeadingSize);
    await reader.keyboard.press('Tab');
    const skip = reader.getByRole('link', { name: '跳到正文', exact: true });
    await expect(skip).toBeFocused();
    expect((await skip.boundingBox())!.y).toBeGreaterThanOrEqual(0);
    await reader.keyboard.press('Enter');
    await expect(reader.locator('main')).toBeFocused();
    await reader.screenshot({
      path: info.outputPath('public-reader-long-content.jpg'),
      type: 'jpeg',
      quality: 65,
      fullPage: true,
      animations: 'disabled',
    });
    await reader
      .getByRole('navigation', { name: '博客导航' })
      .getByRole('link', { name: '文章', exact: true })
      .click();
    const filters = reader.locator('.taxonomy[aria-label="文章筛选"]');
    await filters.getByRole('link', { name: category, exact: true }).click();
    await expect(reader.getByText('当前分类：' + category, { exact: false })).toBeVisible();
    await expect(filters.getByRole('link', { name: category, exact: true })).toHaveAttribute(
      'aria-current',
      'true',
    );
    await expect(reader.locator('.post-card')).toHaveCount(1);
    await filters.getByRole('link', { name: '全部文章', exact: true }).click();
    await expect(reader).toHaveURL('http://127.0.0.1:4179/blog/-/articles');
    await expect(filters.getByRole('link', { name: '全部文章', exact: true })).toHaveAttribute(
      'aria-current',
      'true',
    );
    await reader.goto('/blog?tag=missing-' + randomUUID());
    await expect(reader.getByRole('heading', { name: '没有匹配的文章' })).toBeVisible();
    await reader.getByRole('link', { name: '查看全部文章', exact: true }).click();
    await expect(reader.locator('.post-card').first()).toBeVisible();
    await reader
      .getByRole('navigation', { name: '博客导航' })
      .getByRole('link', { name: '归档', exact: true })
      .click();
    await expect(
      reader
        .getByRole('navigation', { name: '博客导航' })
        .getByRole('link', { name: '归档', exact: true }),
    ).toHaveAttribute('aria-current', 'page');
  } finally {
    await guest.close();
  }
});
