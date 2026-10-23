import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { test, expect } from '../support/browser-test';
import { showSidebar } from '../support/settings-navigation';

test.use({ actionTimeout: 10000 });
test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});
async function seed(page: any, files: { path: string; content: string }[]) {
  const config = JSON.parse(await readFile('.local/e2e-config.json', 'utf8'));
  for (const f of files) {
    const target = join(config.knowledgeRoot, f.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, f.content);
  }
  const response = await page.request.get('/api/tree');
  expect(response.status()).toBe(200);
  const flatten = (items: any[]): any[] =>
    items.flatMap((item) => [item, ...flatten(item.children || [])]);
  const entries = flatten(await response.json());
  return files.map((file) => {
    const entry = entries.find((item) => item.path === file.path);
    expect(entry?.id).toBeTruthy();
    return entry;
  });
}
async function query(page: any, q: string) {
  const done = page.waitForResponse(
    (r: any) =>
      new URL(r.url()).pathname === '/api/search/advanced' &&
      r.request().postDataJSON().query === q,
  );
  await page.getByRole('textbox', { name: '搜索笔记与目录', exact: true }).fill(q);
  await done;
  await expect(page.getByText('正在搜索…', { exact: true })).toHaveCount(0);
}
const unavailable = (route: any) =>
  route.fulfill({ status: 503, json: { code: 'TOKENIZER_UNAVAILABLE' } });
function indexed(note: any, line: number, snippet: string, matchedBy = ['text']) {
  return {
    noteId: note.id,
    title: '内容结果',
    relativePath: note.path,
    url: `/?note=${note.id}`,
    matches: [
      {
        noteId: note.id,
        chunkId: 'fixture',
        title: '内容结果',
        relativePath: note.path,
        url: `/?note=${note.id}#L${line}`,
        startLine: 1,
        endLine: 50,
        matchLine: line,
        headingPath: ['测试记录'],
        snippet,
        matchedBy,
        sourceHash: '0'.repeat(64),
        sourceRevision: 1,
      },
    ],
  };
}
const reply = (results: any[], nextCursor?: string) => ({
  results,
  ...(nextCursor ? { nextCursor } : {}),
  degraded: false,
  reasons: [],
  index: { pending: 0, checkedAt: null, generation: null },
});

test('complete, partial, Chinese, English and path filename searches open the correct note without a content index', async ({
  page,
}, info) => {
  const suffix = info.project.name;
  const [cn, en] = await seed(page, [
    {
      path: `00-Inbox/水文观测记录-audit-${suffix}.md`,
      content: '# 设备维护台账\n\n正文没有文件名。',
    },
    {
      path: `00-Inbox/River Flow-audit-${suffix}.md`,
      content: '# English note\n\nSensor maintenance only.',
    },
  ]);
  await page.route('**/api/search/advanced', unavailable);
  await page.goto('/');
  await showSidebar(page);
  for (const [text, note] of [
    [basename(cn.path), cn],
    [basename(cn.path, '.md'), cn],
    [`观测记录-audit-${suffix}`, cn],
    [cn.path, cn],
    [`river flow-AUDIT-${suffix}`, en],
    [`  River Flow-audit-${suffix}.md  `, en],
  ] as const) {
    await query(page, text);
    const row = page.locator('.search-result').filter({ hasText: note.path });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('文件名与目录位置匹配');
    await row.click();
    await expect(page).toHaveURL(new RegExp(`note=${note.id}(?:#L1)?$`));
    await expect(page.locator('.note-topline')).toContainText(basename(note.path, '.md'));
    await showSidebar(page);
  }
});

test('exact filename is prioritized over a semantic-only content result', async ({
  page,
}, info) => {
  const q = `水文排序-${info.project.name}`;
  const [exact, other] = await seed(page, [
    { path: `00-Inbox/${q}.md`, content: '# 现场记录\n传感器读数。' },
    {
      path: `00-Inbox/sorting-noise-${info.project.name}.md`,
      content: '# 开发说明\n服务开发记录。',
    },
  ]);
  await page.route('**/api/search/advanced', (route: any) =>
    route.fulfill({ json: reply([indexed(other, 2, '语义候选内容', ['semantic'])]) }),
  );
  await page.goto('/');
  await showSidebar(page);
  await query(page, q);
  await expect(page.locator('.search-result')).toHaveCount(2);
  await page.screenshot({ path: info.outputPath('filename-order.png') });
  await expect(page.locator('.search-result').first()).toContainText(exact.path, { timeout: 1500 });
});

test('exact filename survives more than twenty directory-path matches when indexing is unavailable', async ({
  page,
}, info) => {
  const q = `水文上限-${info.project.name}`;
  const files = Array.from({ length: 25 }, (_, i) => ({
    path: `00-Inbox/${q}/其他-${i}.md`,
    content: '# 其他记录\n没有目标内容。',
  }));
  const target = `40-Resources/${q}.md`;
  await seed(page, [...files, { path: target, content: '# 目标文件\n记录。' }]);
  await page.route('**/api/search/advanced', unavailable);
  await page.goto('/');
  await showSidebar(page);
  await query(page, q);
  await page.screenshot({ path: info.outputPath('filename-limit.png') });
  await expect(page.locator('.search-result').filter({ hasText: target })).toHaveCount(1, {
    timeout: 1500,
  });
});

test('a later content page updates the first-line fallback location of the same filename result', async ({
  page,
}, info) => {
  const q = `水文分页-${info.project.name}`;
  const [exact, other] = await seed(page, [
    {
      path: `00-Inbox/${q}.md`,
      content: '# 现场记录\n' + 'background\n'.repeat(36) + `${q}正文在这里。\n`,
    },
    {
      path: `00-Inbox/pagination-noise-${info.project.name}.md`,
      content: '# 开发说明\n服务开发记录。',
    },
  ]);
  await page.route('**/api/search/advanced', (route: any) =>
    route.fulfill({
      json: route.request().postDataJSON().cursor
        ? reply([indexed(exact, 38, `${q}正文在这里。`)])
        : reply([indexed(other, 2, '第一批内容结果')], 'page-2'),
    }),
  );
  await page.goto('/');
  await showSidebar(page);
  await query(page, q);
  await expect(page.locator('.search-result').filter({ hasText: exact.path })).toBeVisible();
  const next = page.waitForResponse(
    (r: any) =>
      new URL(r.url()).pathname === '/api/search/advanced' &&
      r.request().postDataJSON().cursor === 'page-2',
  );
  await page.getByRole('button', { name: '加载更多搜索结果', exact: true }).click();
  await next;
  await expect(page.getByRole('button', { name: '加载更多搜索结果', exact: true })).toHaveCount(0);
  await page.locator('.search-result').filter({ hasText: exact.path }).click();
  await expect(page).toHaveURL(/#L38$/, { timeout: 1500 });
});
