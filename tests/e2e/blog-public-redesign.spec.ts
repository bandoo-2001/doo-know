import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { test, expect } from '../support/browser-test';

test.setTimeout(120000);
const origin = 'http://127.0.0.1:4179';

async function fixture(page: Page, short = false) {
  await page.context().addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const { token } = await (await page.request.get('/api/security/csrf')).json();
  const headers = { origin, 'x-csrf-token': token };
  const settings = await (await page.request.get('/api/blog/settings')).json();
  const result = await page.request.patch('/api/blog/settings', {
    headers,
    data: {
      settings: {
        ...settings,
        title: 'Bandoo 的手记',
        author: 'Bandoo',
        description: '关于技术、生活与缓慢生长的想法。',
        enabled: true,
        theme: 'system',
      },
      requestId: randomUUID(),
    },
  });
  expect(result.ok()).toBe(true);
  const image = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 960;
    c.height = 540;
    const x = c.getContext('2d')!;
    x.fillStyle = '#d8e2cf';
    x.fillRect(0, 0, 960, 540);
    x.fillStyle = '#345347';
    x.beginPath();
    x.arc(760, 120, 310, 0, Math.PI * 2);
    x.fill();
    x.fillStyle = '#d3b881';
    x.beginPath();
    x.arc(290, 400, 220, 0, Math.PI * 2);
    x.fill();
    return c.toDataURL('image/png').split(',')[1];
  });
  const uploaded = await page.request.post('/api/blog/design/media', {
    headers,
    data: { name: 'garden.png', mime: 'image/png', base64: image, requestId: randomUUID() },
  });
  expect(uploaded.ok()).toBe(true);
  const media = await uploaded.json();
  const posts: any[] = [];
  for (let i = 0; i < (short ? 1 : 3); i++) {
    let content = short
      ? '只有一句话的短文。'
      : [
          '# 从日常记录开始',
          '记录不需要一个宏大的开始。一个问题、一段代码，或是今天观察到的小变化，都值得留下。',
          ...Array.from(
            { length: 8 },
            (_, n) =>
              `## ${n + 1}. ${['留出思考的空间', '把想法连接起来', '让知识慢慢生长', '找到自己的节奏'][n % 4]}\n\n${'知识的价值，来自持续使用和重新理解。把复杂的问题拆成可以实践的一小步，每一次回看都会有新的发现。'.repeat(4)}`,
          ),
          '```ts\nconst garden = { growing: true };\n' +
            'const longLine = "' +
            'x'.repeat(300) +
            '";\n```',
          '| 想法 | 记录 | 实践 | 回顾 |\n| --- | --- | --- | --- |\n| ' +
            Array.from({ length: 4 }, () => '长表格'.repeat(20)).join(' | ') +
            ' |',
          '一个很长的链接：<https://example.invalid/' + 'x'.repeat(350) + '>',
        ].join('\n\n');
    const created = await page.request.post('/api/notes', {
      headers,
      data: {
        folderPath: '00-Inbox',
        fileName: 'public-design-' + randomUUID() + '.md',
        content,
        requestId: randomUUID(),
      },
    });
    expect(created.status()).toBe(201);
    let note = await created.json(),
      cover: string | undefined;
    if (i === 0 && !short) {
      const asset = await page.request.post('/api/notes/' + note.id + '/assets', {
        headers,
        multipart: {
          file: { name: 'garden.png', mimeType: 'image/png', buffer: Buffer.from(image, 'base64') },
        },
      });
      expect(asset.status()).toBe(201);
      cover = (await asset.json()).markdownPath;
      content += '\n\n![花园封面](' + cover + ')';
      const saved = await page.request.put('/api/notes/' + note.id, {
        headers,
        data: { content, expectedModifiedAt: note.modifiedAt },
      });
      expect(saved.ok()).toBe(true);
      note = { ...note, ...(await saved.json()) };
    }
    const published = await page.request.post('/api/blog/publish', {
      headers,
      data: {
        noteId: note.id,
        expectedModifiedAt: note.modifiedAt,
        expectedContentHash: createHash('sha256').update(content).digest('hex'),
        expectedPublicationVersion: 0,
        requestId: randomUUID(),
        metadata: {
          slug: 'public-design-' + randomUUID().slice(0, 8),
          title: short
            ? '一句话，也值得记录'
            : [
                '让记录长成自己的数字花园',
                '从一个小工具，到持续创造的日常',
                '写给未来的自己：保留好奇与耐心',
              ][i],
          summary: '把零散的观察与想法留下，让每一次回顾都有新的收获。',
          category: '数字生活',
          tags: ['知识管理', '持续创造'],
          pinned: i === 0,
          ...(cover ? { cover } : {}),
        },
      },
    });
    expect(published.ok()).toBe(true);
    posts.push(await published.json());
  }
  async function design(template: string, long = false) {
    const state = await (await page.request.get('/api/blog/design')).json();
    const saved = await page.request.patch('/api/blog/design', {
      headers,
      data: {
        expectedVersion: state.version,
        requestId: randomUUID(),
        design: {
          ...state.draft,
          template,
          font: template === 'magazine' ? 'serif' : 'sans',
          width: 'wide',
          cardStyle: 'bordered',
          profile: {
            name: long ? '记录者'.repeat(40) : '你好，我是 Bandoo。',
            tagline: '保持好奇，慢慢生长',
            bio: '在这里记录技术探索、生活观察，以及那些值得反复思考的小事。',
            avatar: media.url,
            cover: media.url,
          },
          projects: [
            {
              id: 'garden',
              title: long ? 'DooKnow'.repeat(20) : '花园工具箱',
              description: '让知识生长在自己的土地上。',
              href: 'https://example.com',
            },
          ],
          collections: [
            {
              id: 'series',
              slug: 'growing',
              title: '从记录到创造',
              description: '循着自己的节奏，读完一组相关的文章。',
              postIds: posts.map((p) => p.id).reverse(),
            },
          ],
          socialLinks: [{ id: 'site', label: '我的项目', href: 'https://example.com' }],
          friendLinks: [{ id: 'friend', label: '花园里的朋友', href: 'https://example.com' }],
        },
      },
    });
    expect(saved.ok()).toBe(true);
    const publish = await page.request.post('/api/blog/design/publish', {
      headers,
      data: { expectedVersion: (await saved.json()).version, requestId: randomUUID() },
    });
    expect(publish.ok()).toBe(true);
  }
  return { posts, design };
}

async function contained(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
}

test('three public home layouts remain usable with mobile, custom design and long identity', async ({
  page,
  browser,
}, info) => {
  const { design } = await fixture(page);
  const context = await browser.newContext({
    baseURL: origin,
    viewport: page.viewportSize()!,
    colorScheme: 'light',
  });
  const guest = await context.newPage();
  const errors: string[] = [];
  guest.on('pageerror', (e) => errors.push(e.message));
  try {
    for (const template of ['journal', 'magazine', 'profile']) {
      await design(template);
      await guest.goto('/blog');
      await expect(
        guest.getByRole('heading', { name: '你好，我是 Bandoo。', exact: true }),
      ).toBeVisible();
      await expect(guest.locator('.site-header nav')).toBeVisible();
      await contained(guest);
      if (template === 'profile' && page.viewportSize()!.width <= 500) {
        const collections = await guest.locator('.module-collections').boundingBox();
        const projects = await guest.locator('.module-projects').boundingBox();
        expect(projects!.y - collections!.y - collections!.height).toBeGreaterThanOrEqual(24);
      }
      for (const link of await guest.locator('.site-header nav a').all()) {
        const box = await link.boundingBox();
        expect(box!.height).toBeGreaterThanOrEqual(44);
      }
      await guest.screenshot({
        path: info.outputPath('home-' + template + '.png'),
        fullPage: true,
        animations: 'disabled',
      });
      await guest.setViewportSize({ width: 320, height: 780 });
      await design(template, true);
      await guest.reload();
      await contained(guest);
      await guest.setViewportSize(page.viewportSize()!);
    }
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('long reader has working progress, active table of contents and no-JavaScript navigation', async ({
  page,
  browser,
}, info) => {
  const { posts, design } = await fixture(page);
  await design('journal');
  const context = await browser.newContext({
    baseURL: origin,
    viewport: page.viewportSize()!,
    colorScheme: 'light',
    reducedMotion: 'reduce',
  });
  const guest = await context.newPage();
  const errors: string[] = [];
  guest.on('pageerror', (e) => errors.push(e.message));
  try {
    await guest.goto('/blog/' + posts[0].slug);
    await contained(guest);
    await guest.screenshot({
      path: info.outputPath('reader-first-screen.png'),
      animations: 'disabled',
    });
    await expect(guest.locator('.article-body h1')).toHaveText('从日常记录开始');
    await expect(guest.locator('[data-reading-progress]')).toBeVisible();
    if (!(await guest.locator('.toc nav').isVisible())) await guest.locator('.toc summary').click();
    const target = guest.locator('.toc nav a').nth(3),
      href = await target.getAttribute('href');
    await target.click();
    await expect(guest).toHaveURL(new RegExp(href! + '$'));
    await expect(target).toHaveAttribute('aria-current', 'location');
    await expect
      .poll(() =>
        guest.locator('[data-reading-progress]').evaluate((e: HTMLProgressElement) => e.value),
      )
      .toBeGreaterThan(0);
    const code = guest.locator('.article-body pre').first();
    expect(await code.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true);
    await guest.screenshot({
      path: info.outputPath('reader.png'),
      fullPage: true,
      animations: 'disabled',
    });
    await guest.evaluate(() => {
      const body = document.querySelector('.article-body')!;
      scrollTo(0, body.getBoundingClientRect().bottom + scrollY - innerHeight + 2);
    });
    await expect
      .poll(() =>
        guest.locator('[data-reading-progress]').evaluate((e: HTMLProgressElement) => e.value),
      )
      .toBe(100);
    await guest.emulateMedia({ colorScheme: 'dark' });
    await guest.screenshot({
      path: info.outputPath('reader-dark.png'),
      fullPage: true,
      animations: 'disabled',
    });
    await guest.getByRole('link', { name: '返回顶部 ↑', exact: true }).click();
    await expect(guest).toHaveURL(/#article-top$/);
    await contained(guest);
    expect(errors).toEqual([]);
    const noJS = await browser.newContext({
      baseURL: origin,
      viewport: page.viewportSize()!,
      javaScriptEnabled: false,
    });
    try {
      const plain = await noJS.newPage();
      await plain.goto('/blog/' + posts[0].slug);
      await expect(plain.locator('.article-body')).toContainText('知识的价值');
      await expect(plain.locator('[data-copy-link]')).not.toBeVisible();
      if (!(await plain.locator('.toc nav').isVisible())) {
        await plain.locator('.toc summary').focus();
        await plain.keyboard.press('Enter');
      }
      const nativeAnchor = plain.locator('.toc nav a').nth(2);
      const nativeHref = await nativeAnchor.getAttribute('href');
      await nativeAnchor.focus();
      await plain.keyboard.press('Enter');
      expect(new URL(plain.url()).hash).toBe(nativeHref);
      await plain
        .getByRole('navigation', { name: '博客导航' })
        .getByRole('link', { name: '文章', exact: true })
        .click();
      await expect(plain.locator('.article-index')).toBeVisible();
      await contained(plain);
    } finally {
      await noJS.close();
    }
  } finally {
    await context.close();
  }
});

test('short reader handles missing headings and unavailable clipboard without interrupting reading', async ({
  page,
  browser,
}) => {
  const { posts } = await fixture(page, true);
  const context = await browser.newContext({ baseURL: origin, viewport: page.viewportSize()! });
  try {
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: () => Promise.reject(new Error('denied')) },
      });
    });
    const guest = await context.newPage();
    await guest.goto('/blog/' + posts[0].slug);
    await expect(guest.locator('.toc')).toHaveCount(0);
    await expect(guest.locator('[data-reading-progress]')).not.toBeVisible();
    await guest.getByRole('button', { name: '复制链接', exact: true }).click();
    await expect(guest.locator('[data-reader-status]')).toContainText('无法复制');
    await expect(guest.locator('.article-body')).toContainText('只有一句话');
    await contained(guest);
  } finally {
    await context.close();
  }
});
