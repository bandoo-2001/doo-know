import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../support/browser-test';
import { openDocumentNote } from '../support/document-editor';
import { closeSidebar, showSidebar } from '../support/settings-navigation';

const query = '远端定位词';
const firstHit = `第一处${query}需要自动展示。`;
const secondHit = `第二处${query}需要继续展示。`;
const tableContent = '| 项目 | 数值 |\n| --- | --- |\n| 浮动工具目标 | 10 |\n| 对照行 | 20 |';

function longNote() {
  return [
    '# 长笔记定位',
    ...Array.from({ length: 60 }, (_, i) => `开头背景段落 ${i + 1}：记录日常观察。`),
    firstHit,
    ...Array.from({ length: 60 }, (_, i) => `中间背景段落 ${i + 1}：记录实验过程。`),
    secondHit,
    '表格之前的独立正文。',
    tableContent,
    '表格之后的独立正文。',
    ...Array.from({ length: 20 }, (_, i) => `结尾背景段落 ${i + 1}：保留足够滚动空间。`),
  ].join('\n\n');
}

async function expectCentered(target: Locator, viewport: Locator) {
  await expect(target).toBeInViewport();
  await expect
    .poll(async () => {
      const targetBox = await target.boundingBox();
      const viewportBox = await viewport.boundingBox();
      if (!targetBox || !viewportBox) return Infinity;
      const targetCenter = targetBox.y + targetBox.height / 2;
      const viewportCenter = viewportBox.y + viewportBox.height / 2;
      return Math.abs(targetCenter - viewportCenter) / viewportBox.height;
    })
    .toBeLessThan(0.3);
}

async function findInNote(page: Page, target: Locator, viewport: Locator) {
  await page.keyboard.press('ControlOrMeta+f');
  const search = page.getByRole('search', { name: '当前笔记查找', exact: true });
  const input = search.getByLabel('查找内容', { exact: true });
  await expect(input).toBeFocused();
  await input.fill(query);
  await expect(search.locator('.editor-search-count')).toHaveText('1 / 2');
  // A query must reveal its first match before Enter, without taking typing focus.
  await expectCentered(target, viewport);
  await expect(input).toBeFocused();
  return { search, input };
}

test('document find reveals distant matches while keeping the search field focused', async ({
  page,
  context,
}) => {
  await openDocumentNote(page, context, longNote());
  const editor = page.getByRole('textbox', { name: '文档正文', exact: true });
  await editor.locator('h1').click();
  const first = editor.locator('p').filter({ hasText: firstHit });
  const second = editor.locator('p').filter({ hasText: secondHit });
  await expect(first).not.toBeInViewport();
  const viewport = page.locator('.document-editor-mount');
  const { search, input } = await findInNote(page, first, viewport);
  await expect(first.locator('.document-search-match')).toHaveText(query);
  await expect(first.locator('.document-search-match')).toBeInViewport();
  await input.press('Enter');
  await expect(search.locator('.editor-search-count')).toHaveText('2 / 2');
  await expectCentered(second, viewport);
  await expect(second.locator('.document-search-match')).toHaveText(query);
  await expect(first.locator('.document-search-match')).toHaveCount(0);
  await expect(input).toBeFocused();
  await input.press('Shift+Enter');
  await expect(search.locator('.editor-search-count')).toHaveText('1 / 2');
  await expectCentered(first, viewport);
  await expect(input).toBeFocused();
});

test.describe('source find navigation', () => {
  test.use({ sourceEditorPreference: true });

  test('source find reveals distant matches while keeping the search field focused', async ({
    page,
    context,
  }) => {
    await openDocumentNote(page, context, longNote());
    await page.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+Home');
    const first = page.locator('.cm-line').filter({ hasText: firstHit });
    const second = page.locator('.cm-line').filter({ hasText: secondHit });
    const viewport = page.locator('.cm-scroller');
    const { search, input } = await findInNote(page, first, viewport);
    await input.press('Enter');
    await expect(search.locator('.editor-search-count')).toHaveText('2 / 2');
    await expectCentered(second, viewport);
    await expect(input).toBeFocused();
    await input.press('Shift+Enter');
    await expect(search.locator('.editor-search-count')).toHaveText('1 / 2');
    await expectCentered(first, viewport);
    await expect(input).toBeFocused();
    await input.fill('没有匹配的查找内容');
    await expect(search.locator('.editor-search-count')).toHaveText('0 / 0');
    await expect(page.locator('.editor-document-stats')).not.toContainText('已选');
    await expect(input).toBeFocused();
  });
});

test('document find reveals a late code line through both scrolling panes', async ({
  page,
  context,
}) => {
  const needle = 'code-find-needle-940';
  const original = [
    '# 代码内定位',
    ...Array.from({ length: 60 }, (_, index) => `代码之前的背景段落 ${index + 1}。`),
    '```text\n' +
      Array.from({ length: 1000 }, (_, index) =>
        index === 940 ? needle : `background code line ${index + 1}`,
      ).join('\n') +
      '\n```',
    ...Array.from({ length: 20 }, (_, index) => `代码之后的背景段落 ${index + 1}。`),
  ].join('\n\n');
  const note = await openDocumentNote(page, context, original);
  const editor = page.getByRole('textbox', { name: '文档正文', exact: true });
  await editor.locator('h1').click();
  await page.keyboard.press('ControlOrMeta+f');
  const search = page.getByRole('search', { name: '当前笔记查找', exact: true });
  const input = search.getByLabel('查找内容', { exact: true });
  await input.fill(needle);
  await expect(search.locator('.editor-search-count')).toHaveText('1 / 1');
  const hit = editor.locator('.document-code-block .cm-line').filter({ hasText: needle });
  await expect(hit).toBeInViewport();
  for (const viewport of [
    page.locator('.document-editor-mount'),
    editor.locator('.document-code-block .cm-scroller'),
  ]) {
    await expect
      .poll(async () => {
        const lineBox = await hit.boundingBox();
        const viewportBox = await viewport.boundingBox();
        return !!(
          lineBox &&
          viewportBox &&
          lineBox.y >= viewportBox.y &&
          lineBox.y + lineBox.height <= viewportBox.y + viewportBox.height
        );
      })
      .toBe(true);
  }
  await expect(input).toBeFocused();
  expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).toBe(original);
});

test('a delayed source adapter keeps newer sidebar typing focus', async ({ page, context }) => {
  await openDocumentNote(page, context, '# 延迟编辑器\n\n保留正文。');
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
  try {
    await page.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
    await expect.poll(() => held).toBe(true);
    await showSidebar(page);
    const input = page.getByRole('textbox', { name: '搜索笔记与目录', exact: true });
    await input.fill('侧栏继续输入');
    release();
    await expect(page.locator('.cm-content')).toContainText('保留正文。');
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('侧栏继续输入');
  } finally {
    release();
  }
});

for (const mode of ['document', 'source', 'read'] as const) {
  test(`sidebar content hit opens a different note and centers its line in ${mode} mode`, async ({
    page,
    context,
  }) => {
    const content = longNote();
    const targetNote = await openDocumentNote(page, context, content);
    await openDocumentNote(page, context, '# 起始笔记\n\n本笔记不含要跳转的内容。');
    if (mode === 'source')
      await page.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
    else if (mode === 'read') {
      const session = await (await page.request.get('/api/auth/get-session')).json();
      await page.evaluate(
        (key) => {
          localStorage.setItem(key, JSON.stringify({ editorKind: 'document', mode: 'preview' }));
        },
        'dooknow.preferences.v1:' + encodeURIComponent(session.user.id),
      );
      await page.reload();
      await expect(page.locator('.preview-panel .markdown')).toContainText('起始笔记');
    }

    // Keep indexing/tokenizer availability out of this UI navigation regression.
    const matchLine = content.split('\n').findIndex((line) => line === secondHit) + 1;
    await page.route('**/api/search/advanced', (route) =>
      route.fulfill({
        json: {
          results: [
            {
              noteId: targetNote.id,
              title: '长笔记定位',
              relativePath: targetNote.relativePath,
              url: `/?note=${targetNote.id}`,
              matches: [
                {
                  noteId: targetNote.id,
                  chunkId: 'distant-content-hit',
                  title: '长笔记定位',
                  relativePath: targetNote.relativePath,
                  url: `/?note=${targetNote.id}#L${matchLine}`,
                  startLine: matchLine,
                  endLine: matchLine,
                  matchLine,
                  headingPath: ['长笔记定位'],
                  snippet: secondHit,
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
      }),
    );
    await showSidebar(page);
    await page.getByRole('textbox', { name: '搜索笔记与目录', exact: true }).fill(query);
    await page.locator('.search-result').filter({ hasText: secondHit }).click();
    await expect(page).toHaveURL(new RegExp(`note=${targetNote.id}#L${matchLine}$`));
    await closeSidebar(page);
    if (mode === 'document') {
      const editor = page.getByRole('textbox', { name: '文档正文', exact: true });
      await expectCentered(
        editor.locator('p').filter({ hasText: secondHit }),
        page.locator('.document-editor-mount'),
      );
    } else if (mode === 'source') {
      await expectCentered(
        page.locator('.cm-activeLine').filter({ hasText: secondHit }),
        page.locator('.cm-scroller'),
      );
    } else {
      const hit = page.locator('.preview-panel [data-search-hit="true"]');
      await expect(hit).toHaveText(secondHit);
      await expectCentered(hit, page.locator('.preview-panel'));
    }
  });
}

test('table controls leave the document when focus moves to search or the sidebar', async ({
  page,
  context,
}) => {
  await openDocumentNote(page, context, longNote());
  const editor = page.getByRole('textbox', { name: '文档正文', exact: true });
  const tools = page.getByRole('toolbar', { name: '表格操作', exact: true });
  const cell = editor.getByRole('cell', { name: '浮动工具目标', exact: true });
  await editor.locator('h1').click();
  await expect(tools).toBeHidden();
  await cell.click();
  await expect(tools).toBeVisible();
  await page.keyboard.press('ControlOrMeta+f');
  await expect(
    page
      .getByRole('search', { name: '当前笔记查找', exact: true })
      .getByLabel('查找内容', { exact: true }),
  ).toBeFocused();
  await expect(tools).toBeHidden();
  await page.getByRole('button', { name: '关闭查找', exact: true }).click();
  await cell.click();
  await expect(tools).toBeVisible();
  await showSidebar(page);
  await page.getByRole('textbox', { name: '搜索笔记与目录', exact: true }).focus();
  await expect(tools).toBeHidden();
});

test('table controls float without moving adjacent text and stay usable with keyboard focus', async ({
  page,
  context,
}) => {
  await openDocumentNote(page, context, longNote());
  const editor = page.getByRole('textbox', { name: '文档正文', exact: true });
  const tools = page.getByRole('toolbar', { name: '表格操作', exact: true });
  const before = editor.locator('p').filter({ hasText: '表格之前的独立正文。' });
  const after = editor.locator('p').filter({ hasText: '表格之后的独立正文。' });
  const table = editor.locator('table');
  await before.click();
  await expect(tools).toBeHidden();
  const paragraphBefore = await before.boundingBox();
  const tableBefore = await table.boundingBox();
  expect(paragraphBefore).not.toBeNull();
  expect(tableBefore).not.toBeNull();
  const initialGap = tableBefore!.y - paragraphBefore!.y - paragraphBefore!.height;
  await editor.getByRole('cell', { name: '浮动工具目标', exact: true }).click();
  await expect(tools).toBeVisible();
  // Focus must not insert a toolbar-sized row between this table and its paragraph.
  const paragraphFocused = await before.boundingBox();
  const tableFocused = await table.boundingBox();
  expect(paragraphFocused).not.toBeNull();
  expect(tableFocused).not.toBeNull();
  const focusedGap = tableFocused!.y - paragraphFocused!.y - paragraphFocused!.height;
  expect(Math.abs(focusedGap - initialGap)).toBeLessThan(3);
  const firstAction = tools.getByRole('button').first();
  await firstAction.focus();
  await expect(firstAction).toBeFocused();
  await expect(tools).toBeVisible();
  await firstAction.press('ArrowRight');
  await expect(tools.getByRole('button').nth(1)).toBeFocused();
  await expect(tools).toBeVisible();
  await after.click();
  await expect(tools).toBeHidden();
});
