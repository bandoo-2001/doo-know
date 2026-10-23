import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, expect } from '../support/browser-test';
import { showSidebar } from '../support/settings-navigation';

test('search opens the actual match in preview, edit and split views, including a second hit in the same note', async ({
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
  await expect(page.locator('.cm-content')).toBeVisible();
  await page.getByRole('button', { name: '预览', exact: true }).click();
  await showSidebar(page);
  await page.getByRole('textbox', { name: '搜索笔记与目录', exact: true }).fill('水文');
  await page.locator('.search-result').filter({ hasText: '水文观测目标' }).click();
  await expect(page).toHaveURL(/#L123$/);
  const target = page.locator('.preview-panel [data-search-hit="true"]');
  await expect(target).toHaveText('水文观测目标：分析河流水位与流速。');
  await expect(target).toBeInViewport();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(page.locator('.cm-activeLine')).toContainText('水文观测目标');
  await page.getByRole('button', { name: '分屏', exact: true }).click();
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
