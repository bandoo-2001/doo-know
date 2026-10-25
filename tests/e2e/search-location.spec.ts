import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, expect } from '../support/browser-test';
import { showSidebar } from '../support/settings-navigation';
import { openDocumentNote } from '../support/document-editor';

test('search opens the actual match in reading, source and split views, including a second hit in the same note', async ({
  page,
  context,
}, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.goto('/');
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const response = await page.request.post('/api/notes', {
    headers: { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token },
    data: {
      folderPath: '00-Inbox',
      fileName: `观测-${info.project.name}-${crypto.randomUUID()}.md`,
      content:
        '# 河流观测\n\n' +
        Array.from({ length: 120 }, (_, i) => `第${i + 1}次观测：记录天气与设备状态。\n`).join('') +
        '水文观测目标：分析河流水位与流速。\n\n洪峰观测目标：检查预警记录。\n\n```text\n' +
        'background\n'.repeat(70) +
        '截流记录目标：核对传感器。\n```\n',
    },
  });
  expect(response.status()).toBe(201);
  const note = await response.json();
  await page.route('**/api/search/advanced', (route) => {
    const second = route.request().postDataJSON().query === '洪峰';
    const code = route.request().postDataJSON().query === '截流';
    const matchLine = code ? 198 : second ? 125 : 123;
    return route.fulfill({
      json: {
        results: [
          {
            noteId: note.id,
            title: '河流观测',
            relativePath: note.relativePath,
            url: `/?note=${note.id}`,
            matches: [
              {
                noteId: note.id,
                chunkId: 'fixture',
                title: '河流观测',
                relativePath: note.relativePath,
                url: `/?note=${note.id}#L${matchLine}`,
                startLine: 1,
                endLine: 199,
                matchLine,
                headingPath: ['河流观测'],
                snippet: code
                  ? '截流记录目标：核对传感器。'
                  : second
                    ? '洪峰观测目标：检查预警记录。'
                    : '水文观测目标：分析河流水位与流速。',
                matchedBy: ['text'],
                sourceHash: '0'.repeat(64),
                sourceRevision: 1,
              },
            ],
          },
        ],
        degraded: false,
        reasons: [],
        index: { pending: 0, checkedAt: null, generation: null },
      },
    });
  });
  await page.goto('/?note=' + note.id);
  await page.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
  await expect(page.locator('.cm-content')).toBeVisible();
  await page.getByRole('button', { name: '阅读', exact: true }).click();
  await showSidebar(page);
  await page.getByRole('textbox', { name: '搜索笔记与目录', exact: true }).fill('水文');
  await page.locator('.search-result').filter({ hasText: '水文观测目标' }).click();
  await expect(page).toHaveURL(/#L123$/);
  const target = page.locator('.preview-panel [data-search-hit="true"]');
  await expect(target).toHaveText('水文观测目标：分析河流水位与流速。');
  await expect(target).toBeInViewport();
  await page.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
  await expect(page.locator('.cm-activeLine')).toContainText('水文观测目标');
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+Home');
  await expect(page.locator('.cm-activeLine')).toContainText('河流观测');
  await page.getByRole('button', { name: '阅读', exact: true }).click();
  await page.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
  await expect(page.locator('.cm-activeLine')).toContainText('河流观测');
  await page.getByRole('checkbox', { name: '同时预览', exact: true }).check();
  await expect(target).toBeInViewport();
  await showSidebar(page);
  await page.getByRole('textbox', { name: '搜索笔记与目录', exact: true }).fill('洪峰');
  await page.locator('.search-result').filter({ hasText: '洪峰观测目标' }).click();
  await expect(page).toHaveURL(/#L125$/);
  await expect(page.locator('.cm-activeLine')).toContainText('洪峰观测目标');
  await expect(target).toContainText('洪峰观测目标');
  await expect(target).toBeInViewport();
  await showSidebar(page);
  await page.getByRole('textbox', { name: '搜索笔记与目录', exact: true }).fill('截流');
  await page.locator('.search-result').filter({ hasText: '截流记录目标' }).click();
  await expect(page).toHaveURL(/#L198$/);
  await expect(target).toHaveText('截流记录目标：核对传感器。');
  await expect(target).toBeInViewport();
});

test('reading search reaches its hit when the first source adapter mounts', async ({
  page,
  context,
}) => {
  const original =
    '# 异步源码定位\n\n' + '背景记录\n\n'.repeat(50) + '延迟源码目标\n\n第二次源码目标\n';
  const note = await openDocumentNote(page, context, original);
  let release!: () => void;
  const loading = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = false;
  await page.route(
    (url) =>
      url.pathname.endsWith('/components/MarkdownEditor.vue') ||
      /\/assets\/MarkdownEditor-[^/]+\.js$/.test(url.pathname),
    async (route) => {
      held = true;
      await loading;
      await route.continue().catch(() => {});
    },
  );
  await page.route('**/api/search/advanced', (route) => {
    const second = route.request().postDataJSON().query === '第二次';
    const matchLine = second ? 105 : 103;
    const snippet = second ? '第二次源码目标' : '延迟源码目标';
    return route.fulfill({
      json: {
        results: [
          {
            noteId: note.id,
            title: '异步源码定位',
            relativePath: note.relativePath,
            url: `/?note=${note.id}`,
            matches: [
              {
                noteId: note.id,
                chunkId: 'fixture',
                title: '异步源码定位',
                relativePath: note.relativePath,
                url: `/?note=${note.id}#L${matchLine}`,
                startLine: matchLine,
                endLine: matchLine,
                matchLine,
                headingPath: ['异步源码定位'],
                snippet,
                matchedBy: ['text'],
                sourceHash: '0'.repeat(64),
                sourceRevision: 1,
              },
            ],
          },
        ],
        degraded: false,
        reasons: [],
        index: { pending: 0, checkedAt: null, generation: null },
      },
    });
  });
  try {
    await page.getByRole('button', { name: '阅读', exact: true }).click();
    await showSidebar(page);
    await page.getByRole('textbox', { name: '搜索笔记与目录', exact: true }).fill('延迟');
    await page.locator('.search-result').filter({ hasText: '延迟源码目标' }).click();
    await expect(page).toHaveURL(/#L103$/);
    await page.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
    await expect.poll(() => held).toBe(true);
    release();
    await expect(page.locator('.cm-activeLine')).toContainText('延迟源码目标');
    await expect(page.locator('.cm-activeLine')).toBeInViewport();
    await showSidebar(page);
    await page.getByRole('textbox', { name: '搜索笔记与目录', exact: true }).fill('第二次');
    await page.locator('.search-result').filter({ hasText: '第二次源码目标' }).click();
    await expect(page).toHaveURL(/#L105$/);
    await expect(page.locator('.cm-activeLine')).toContainText('第二次源码目标');
    await expect(page.locator('.cm-activeLine')).toBeInViewport();
    expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).toBe(original);
  } finally {
    release();
  }
});

test('a second hit in the same large note loads its own distant fragment', async ({
  page,
  context,
}, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const config = JSON.parse(await readFile('.local/e2e-config.json', 'utf8'));
  const name = `大库观测-${info.project.name}-${crypto.randomUUID()}.md`;
  const filler = 'background filler line\n'.repeat(60000);
  await writeFile(
    join(config.knowledgeRoot, '00-Inbox', name),
    '# 大库\nFIRST\n' + filler + '水文远端目标\n' + filler + '洪峰远端目标\n',
  );
  const tree = await (await page.request.get('/api/tree')).json();
  const flatten = (items: any[]): any[] =>
    items.flatMap((item) => [item, ...flatten(item.children || [])]);
  const note = flatten(tree).find((item) => item.name === name);
  expect(note?.id).toBeTruthy();
  await page.route('**/api/search/advanced', (route) => {
    const second = route.request().postDataJSON().query === '洪峰';
    const line = second ? 120004 : 60003;
    return route.fulfill({
      json: {
        results: [
          {
            noteId: note.id,
            title: '大库',
            relativePath: note.path,
            url: `/?note=${note.id}`,
            matches: [
              {
                noteId: note.id,
                chunkId: 'fixture',
                title: '大库',
                relativePath: note.path,
                url: `/?note=${note.id}#L${line}`,
                startLine: line,
                endLine: line,
                matchLine: line,
                headingPath: ['大库'],
                snippet: second ? '洪峰远端目标' : '水文远端目标',
                matchedBy: ['text'],
                sourceHash: '0'.repeat(64),
                sourceRevision: 1,
              },
            ],
          },
        ],
        degraded: false,
        reasons: [],
        index: { pending: 0, checkedAt: null, generation: null },
      },
    });
  });
  await page.goto('/');
  await showSidebar(page);
  await page.getByRole('textbox', { name: '搜索笔记与目录', exact: true }).fill('水文');
  await page.locator('.search-result').filter({ hasText: '水文远端目标' }).click();
  await expect(page.locator('.large-workspace .cm-content')).toContainText('水文远端目标');
  await showSidebar(page);
  await page.getByRole('textbox', { name: '搜索笔记与目录', exact: true }).fill('洪峰');
  await page.locator('.search-result').filter({ hasText: '洪峰远端目标' }).click();
  await expect(page).toHaveURL(/#L120004$/);
  await expect(page.locator('.large-workspace .cm-content')).toContainText('洪峰远端目标');
  await expect(page.locator('.large-workspace .cm-content')).not.toContainText('水文远端目标');
});
