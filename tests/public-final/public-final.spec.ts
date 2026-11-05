import { test as base, expect } from '../support/browser-test';
import type { Page, Locator } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { defaultBlogDesign } from '../../shared/blog-design';
import { closeSidebar } from '../support/settings-navigation';

type API = (path: string, method?: string, data?: unknown) => Promise<any>;
const test = base.extend<{ api: API }>({
  api: async ({ page, context, baseURL }, use) => {
    await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
    const csrf = await (await page.request.get('/api/security/csrf')).json();
    const headers = { origin: new URL(baseURL!).origin, 'x-csrf-token': csrf.token };
    await use(async (path, method = 'GET', data) => {
      const response = await page.request.fetch(path, { method, headers, data });
      expect(response.ok(), method + ' ' + path + ' status ' + response.status()).toBe(true);
      return response.status() === 204 ? null : response.json();
    });
  },
});
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
async function frames(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );
}
async function note(api: API, content: string) {
  return api('/api/notes', 'POST', {
    folderPath: '00-Inbox',
    fileName: 'final-visual-' + randomUUID() + '.md',
    content,
    requestId: randomUUID(),
  });
}
async function designSeed(api: API, collections = false) {
  const design = defaultBlogDesign(),
    marker = randomUUID().slice(0, 8);
  design.profile.name = '本次作者 ' + marker;
  const links = (prefix: string) =>
    Array.from({ length: 3 }, (_, i) => ({
      id: randomUUID(),
      label: prefix + (i + 1),
      href: 'https://example.invalid/' + prefix + '/' + i,
    }));
  design.navigation = links('导航');
  design.socialLinks = links('社交');
  design.friendLinks = links('朋友');
  design.modules = Array.from({ length: 4 }, (_, i) => ({
    id: randomUUID(),
    kind: 'latest' as const,
    title: '示例模块 ' + i,
    enabled: true,
    limit: 6,
  }));
  if (collections) {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const content = '# 专题文章 ' + marker + ' ' + i + '\n\n隔离公开快照。',
        created = await note(api, content);
      const post = await api('/api/blog/publish', 'POST', {
        noteId: created.id,
        expectedModifiedAt: created.modifiedAt,
        expectedContentHash: createHash('sha256').update(content).digest('hex'),
        expectedPublicationVersion: 0,
        requestId: randomUUID(),
        metadata: {
          title: '专题文章 ' + marker + ' ' + i,
          slug: 'focus-' + randomUUID().slice(0, 8),
        },
      });
      ids.push((post.post ?? post).id);
    }
    design.collections = [
      {
        id: randomUUID(),
        slug: 'focus-' + marker,
        title: '专题 ' + marker,
        description: '真实排序操作',
        postIds: ids,
      },
    ];
  }
  const current = await api('/api/blog/design');
  await api('/api/blog/design', 'PATCH', {
    expectedVersion: current.version,
    requestId: randomUUID(),
    design,
  });
  return design;
}
async function openBlog(page: Page, section: 'design' | 'settings') {
  await page.goto('/?view=apps&app=blog&appSection=' + section);
  await expect(page.locator('.workspace')).toBeVisible();
  await closeSidebar(page);
  await expect(
    page.getByRole('heading', {
      name: section === 'design' ? '装修主页' : '站点设置',
      exact: true,
    }),
  ).toBeVisible();
  if (section === 'design') await expect(page.getByLabel('姓名', { exact: true })).toBeVisible();
}
async function saveFeedback(page: Page, bar: Locator, message: RegExp) {
  const alert = bar.getByRole('alert');
  await expect(alert).toContainText(message);
  await expect
    .poll(() =>
      alert.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return box.top >= 0 && box.bottom <= innerHeight;
      }),
    )
    .toBe(true);
  await expect(alert.getByRole('button')).toBeEnabled();
}
async function focusClear(page: Page, target: Locator, bar: Locator) {
  await target.evaluate((element) =>
    element.scrollIntoView({ block: 'nearest', inline: 'nearest' }),
  );
  await target.focus();
  await frames(page);
  await expect(target).toBeFocused();
  const metrics = await target.evaluate(
    (element, selector) => {
      const box = element.getBoundingClientRect(),
        footer = document.querySelector(selector)!.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return {
        top: box.top,
        bottom: box.bottom,
        footerTop: footer.top,
        centerHit: hit === element || (!!hit && element.contains(hit)),
        withinViewport: box.top >= 0 && box.bottom <= innerHeight,
      };
    },
    await bar.getAttribute('class').then((classes) => '.' + classes!.trim().split(/\s+/).join('.')),
  );
  await test
    .info()
    .attach('field-focus.json', { body: JSON.stringify(metrics), contentType: 'application/json' });
  expect(metrics.withinViewport).toBe(true);
  expect(metrics.centerHit).toBe(true);
  expect(metrics.bottom).toBeLessThanOrEqual(metrics.footerTop - 1);
}

for (const kind of ['document', 'source', 'cas-conflict'] as const) {
  test(
    'guest permission badge remains inside its header and hittable in ' + kind,
    async ({ page, browser, baseURL, api }, info) => {
      const content = '# 公开编辑\n\n保留真实手动编辑权限。\n',
        created = await note(api, content);
      const share = await api('/api/notes/' + created.id + '/share', 'POST', {
        permission: 'edit',
        expiresAt: null,
      });
      const context = await browser.newContext({
        baseURL,
        viewport: page.viewportSize()!,
        colorScheme: 'light',
        isMobile: info.project.use.isMobile,
        hasTouch: info.project.use.hasTouch,
      });
      try {
        const guest = await context.newPage();
        await guest.goto(new URL(share.url, baseURL!).toString());
        await button(guest, '编辑笔记').click();
        await expect(guest.getByRole('textbox', { name: '文档正文', exact: true })).toBeVisible();
        if (kind !== 'document') {
          await button(guest, 'Markdown 源码').click();
          await expect(guest.locator('.cm-content')).toBeVisible();
        }
        if (kind === 'cas-conflict') {
          await guest.locator('.cm-content').fill('# 访客草稿仍需保留\n');
          await api('/api/notes/' + created.id, 'PUT', {
            content: '# 主人更新\n',
            expectedModifiedAt: created.modifiedAt,
            requestId: randomUUID(),
          });
          await button(guest, '保存修改').click();
          await expect(guest.getByRole('alert')).toContainText('笔记已更新');
        }
        const badge = guest.locator('.reader-header .read-only');
        await badge.scrollIntoViewIfNeeded();
        const metrics = await badge.evaluate((element) => {
          const badge = element.getBoundingClientRect(),
            header = element.closest('.reader-header')!.getBoundingClientRect(),
            toolbar = document.querySelector('.public-editor-toolbar')!.getBoundingClientRect();
          const hit = document.elementFromPoint(
            badge.x + badge.width / 2,
            badge.y + badge.height / 2,
          );
          return {
            badgeBottom: badge.bottom,
            headerBottom: header.bottom,
            toolbarTop: toolbar.top,
            centerHit: hit === element || (!!hit && element.contains(hit)),
          };
        });
        await test.info().attach('badge-bounds.json', {
          body: JSON.stringify(metrics),
          contentType: 'application/json',
        });
        await guest.screenshot({ path: info.outputPath('guest-' + kind + '.png') });
        await badge.hover({ timeout: 3000 });
        expect(metrics.centerHit).toBe(true);
        expect(metrics.badgeBottom).toBeLessThanOrEqual(metrics.headerBottom + 1);
        expect(metrics.badgeBottom).toBeLessThanOrEqual(metrics.toolbarTop);
      } finally {
        await context.close();
      }
    },
  );
}

for (const section of ['design', 'settings'] as const)
  for (const failure of ['unknown', 'conflict'] as const) {
    test(
      section +
        ' ' +
        failure +
        ' save exposes real feedback beside save and reconciles without another write',
      async ({ page, api }, info) => {
        await designSeed(api);
        if (section === 'settings') {
          const settings = await api('/api/blog/settings');
          await api('/api/blog/settings', 'PATCH', {
            settings: { ...settings, title: '初始站点', about: '较长的说明。\n'.repeat(40) },
            requestId: randomUUID(),
          });
        }
        await openBlog(page, section);
        const endpoint = '/api/blog/' + (section === 'design' ? 'design' : 'settings');
        const field = page.getByLabel(section === 'design' ? '姓名' : '站点名称', { exact: true });
        await field.fill('当前修改必须保留 ' + randomUUID().slice(0, 8));
        const value = await field.inputValue();
        let writes = 0;
        await page.route('**' + endpoint, async (route) => {
          if (route.request().method() !== 'PATCH') return route.continue();
          writes++;
          if (failure === 'unknown') {
            await route.fetch();
            await route.abort('failed');
          } else await route.continue();
        });
        if (failure === 'conflict') {
          const current = await api(endpoint);
          if (section === 'design')
            await api(endpoint, 'PATCH', {
              expectedVersion: current.version,
              requestId: randomUUID(),
              design: {
                ...current.draft,
                profile: { ...current.draft.profile, tagline: '另一个会话已保存' },
              },
            });
          else
            await api(endpoint, 'PATCH', {
              settings: { ...current, description: '另一个会话已保存' },
              requestId: randomUUID(),
            });
        }
        const bar = page.locator(
          section === 'design' ? '.blog-studio-savebar' : '.blog-admin-settings-savebar',
        );
        await button(page, section === 'design' ? '保存装修草稿' : '保存站点设置').click();
        await saveFeedback(page, bar, failure === 'unknown' ? /结果尚未确认/ : /变化|版本|冲突/);
        await expect(field).toHaveValue(value);
        expect(writes).toBe(1);
        await page.screenshot({ path: info.outputPath(section + '-' + failure + '.png') });
        await bar
          .getByRole('button', {
            name: section === 'design' ? '重新核对版本' : '重新核对设置',
            exact: true,
          })
          .click();
        await expect(bar.getByRole('alert')).toHaveCount(0);
        await expect(field).toHaveValue(value);
        expect(writes).toBe(1);
      },
    );
  }

for (const section of ['appearance', 'navigation', 'modules', 'collections', 'settings'] as const) {
  test(
    'ordinary focus and scroll keep ' + section + ' controls clear of the actual sticky savebar',
    async ({ page, api }, info) => {
      await designSeed(api, section === 'collections');
      await openBlog(page, section === 'settings' ? 'settings' : 'design');
      if (!['appearance', 'settings'].includes(section))
        await button(
          page,
          { navigation: '导航与链接', modules: '首页模块', collections: '专题合集' }[
            section as 'navigation' | 'modules' | 'collections'
          ],
        ).click();
      const form = page.locator(
        section === 'settings' ? '.blog-settings .blog-form' : '.blog-studio-editor .blog-form',
      );
      const targets = form.locator(
        'input:not([type=file]):not([type=color]):not([type=range]),textarea,select,button,summary',
      );
      expect(await targets.count()).toBeGreaterThan(3);
      const frame =
        section !== 'settings'
          ? await page.locator('iframe[title="博客主页草稿预览"]').elementHandle()
          : null;
      const bar = page.locator(
        section === 'settings' ? '.blog-admin-settings-savebar' : '.blog-studio-savebar',
      );
      let checked = 0;
      for (const target of await targets.all()) {
        if (
          !(await target.isVisible()) ||
          !(await target.isEnabled()) ||
          (await target.evaluate(
            (element) => !!element.closest('.blog-studio-savebar,.blog-admin-settings-savebar'),
          ))
        )
          continue;
        await focusClear(page, target, bar);
        checked++;
      }
      expect(checked).toBeGreaterThan(2);
      if (frame) {
        expect(await frame.evaluate((element) => element.isConnected)).toBe(true);
        expect((await frame.getAttribute('sandbox'))?.split(/\s+/)).not.toContain('allow-scripts');
      }
      await page.screenshot({ path: info.outputPath('focus-' + section + '.png') });
    },
  );
}

for (const viewport of [
  { width: 360, height: 460 },
  { width: 844, height: 390 },
]) {
  test(
    'short viewport expanded feedback keeps native focus hittable ' + viewport.width,
    async ({ page, api }, info) => {
      await page.setViewportSize(viewport);
      const session = await api('/api/auth/get-session');
      const theme = viewport.width === 360 ? 'dark' : 'light';
      await page.addInitScript(
        ({ id, theme }) =>
          localStorage.setItem(
            'dooknow.preferences.v1:' + encodeURIComponent(id),
            JSON.stringify({ theme }),
          ),
        { id: session.user.id, theme },
      );
      await designSeed(api);
      await openBlog(page, 'design');
      const frame = await page.locator('iframe[title="博客主页草稿预览"]').elementHandle();
      const name = page.getByLabel('姓名', { exact: true });
      await name.fill('短屏保留草稿 ' + randomUUID().slice(0, 8));
      const draft = await name.inputValue();
      let writes = 0;
      await page.route('**/api/blog/design', async (route) => {
        if (route.request().method() !== 'PATCH') return route.continue();
        writes++;
        await route.fetch();
        await route.abort('failed');
      });
      await button(page, '保存装修草稿').click();
      const bar = page.locator('.blog-studio-savebar');
      await expect(bar.getByRole('alert')).toContainText(/结果尚未确认/);
      await frames(page);
      await writeFile(
        info.outputPath('feedback-before-reveal.json'),
        JSON.stringify(
          await bar.evaluate((element) => ({
            active: document.activeElement?.outerHTML.slice(0, 300),
            top: element.getBoundingClientRect().top,
            bottom: element.getBoundingClientRect().bottom,
            alertTop: element.querySelector('[role=alert]')!.getBoundingClientRect().top,
            alertBottom: element.querySelector('[role=alert]')!.getBoundingClientRect().bottom,
            position: getComputedStyle(element).position,
          })),
          null,
          2,
        ),
      );
      await page.screenshot({ path: info.outputPath('feedback-before-reveal.png') });
      await saveFeedback(page, bar, /结果尚未确认/);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      const surface = await bar.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          position: getComputedStyle(element).position,
          top: bounds.top,
          bottom: bounds.bottom,
          height: bounds.height,
          viewport: { width: innerWidth, height: innerHeight },
          theme: document.documentElement.dataset.theme,
        };
      });
      await writeFile(info.outputPath('feedback-surface.json'), JSON.stringify(surface, null, 2));
      await page.screenshot({ path: info.outputPath('feedback-' + viewport.width + '.png') });
      const targets = page
        .locator('.blog-studio-editor .blog-form')
        .locator('.blog-template-choice,select,textarea');
      const probes = [];
      for (const target of await targets.all()) {
        await target.evaluate((element) =>
          element.scrollIntoView({ block: 'nearest', inline: 'nearest' }),
        );
        await target.focus();
        await frames(page);
        const metrics = await target.evaluate((element) => {
          const box = element.getBoundingClientRect(),
            hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
          return {
            ancestors: Array.from(
              (function* () {
                let node = element.parentElement;
                while (node) {
                  yield node;
                  node = node.parentElement;
                }
              })(),
            ).map((node) => ({
              class: node.className,
              overflow: getComputedStyle(node).overflowY,
              top: node.getBoundingClientRect().top,
              bottom: node.getBoundingClientRect().bottom,
              height: node.clientHeight,
              scrollHeight: node.scrollHeight,
            })),
            tag: element.tagName,
            text: (element.getAttribute('aria-label') || element.textContent || '').slice(0, 70),
            top: box.top,
            bottom: box.bottom,
            height: box.height,
            focused: document.activeElement === element,
            centerHit: hit === element || (!!hit && element.contains(hit)),
            hit: hit?.className,
          };
        });
        probes.push(metrics);
        await writeFile(info.outputPath('short-probes.json'), JSON.stringify(probes, null, 2));
        await page.screenshot({
          path: info.outputPath('short-' + viewport.width + '-' + probes.length + '.png'),
        });
        await info.attach('short-probe.json', {
          body: JSON.stringify(probes, null, 2),
          contentType: 'application/json',
        });
        expect(metrics.focused).toBe(true);
        expect(metrics.centerHit).toBe(true);
        expect(metrics.top).toBeGreaterThanOrEqual(0);
        expect(metrics.bottom).toBeLessThanOrEqual(viewport.height);
      }
      // Native keyboard traversal after the first real template tile, without pointer auto-scroll.
      const first = targets.first();
      await first.evaluate((element) => element.scrollIntoView({ block: 'nearest' }));
      await first.focus();
      for (let i = 0; i < 8; i++) {
        await page.keyboard.press('Tab');
        await frames(page);
        const hit = await page.evaluate(() => {
          const active = document.activeElement!;
          const box = active.getBoundingClientRect(),
            target = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
          return target === active || (!!target && active.contains(target));
        });
        expect(hit).toBe(true);
      }
      await expect(name).toHaveValue(draft);
      expect(writes).toBe(1);
      // Live viewport changes must remeasure without replacing the preview or draft.
      await page.setViewportSize({ width: viewport.width, height: 844 });
      await frames(page);
      await expect(bar).toHaveCSS('position', 'sticky');
      await page.setViewportSize(viewport);
      await frames(page);
      await expect(bar).toHaveCSS('position', 'static');
      expect(await frame!.evaluate((element) => element.isConnected)).toBe(true);
      await bar.getByRole('button', { name: '重新核对版本', exact: true }).click();
      await expect(bar.getByRole('alert')).toHaveCount(0);
      expect(writes).toBe(1);
      await expect(name).toHaveValue(draft);
    },
  );
}
