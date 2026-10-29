import type { Locator } from '@playwright/test';
import { test, expect } from '../support/browser-test';
import { openDocumentNote } from '../support/document-editor';
import { closeSidebar, showSidebar } from '../support/settings-navigation';

const firstPath = '/home/bandoo/.local/bin/tunnel-client';
const secondPath = '/srv/bin/second-client';
const firstLine = `第一处路径：\`${firstPath}\`。`;
const secondLine = `第二处路径：\`${secondPath}\`。`;
const semanticLine = '语义定位目标：这里介绍如何配置可执行程序。';
const semanticQuery = '命令安装位置';

function noteContent() {
  return [
    '# 侧栏精确定位',
    '开头也有 bin，但点击远处结果时不应选择这里。',
    ...Array.from({ length: 45 }, (_, index) => `第一段背景记录 ${index + 1}。`),
    firstLine,
    ...Array.from({ length: 35 }, (_, index) => `第二段背景记录 ${index + 1}。`),
    secondLine,
    ...Array.from({ length: 20 }, (_, index) => `第三段背景记录 ${index + 1}。`),
    semanticLine,
    ...Array.from({ length: 10 }, (_, index) => `末尾背景记录 ${index + 1}。`),
  ].join('\n\n') + '\n';
}

async function expectSelectedTextIn(target: Locator) {
  await expect
    .poll(() => target.evaluate((element) => {
      const selection = window.getSelection();
      return {
        text: selection?.toString() || '',
        inside: !!selection?.anchorNode && !!selection.focusNode &&
          element.contains(selection.anchorNode) && element.contains(selection.focusNode),
      };
    }))
    .toEqual({ text: 'bin', inside: true });
  await expect(target).toBeInViewport();
}

for (const mode of ['document', 'source'] as const) {
  test(`sidebar hits select the exact inline substring and clear stale selection in ${mode} mode`, async ({
    page,
    context,
  }) => {
    const original = noteContent();
    const targetNote = await openDocumentNote(page, context, original);
    await openDocumentNote(page, context, '# 起始笔记\n\n从另一篇笔记打开搜索结果。');
    if (mode === 'source') {
      await page.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
      await expect(page.locator('.cm-content')).toBeVisible();
    }

    // Isolate editor navigation from optional indexing and tokenizer services.
    await page.route('**/api/search/advanced', (route) => {
      const query = route.request().postDataJSON().query.trim();
      const semantic = query === semanticQuery;
      const snippet = semantic ? semanticLine : query === '"bin"' ? secondLine : firstLine;
      const line = original.split('\n').indexOf(snippet) + 1;
      return route.fulfill({
        json: {
          results: [{
            noteId: targetNote.id,
            title: '侧栏精确定位',
            relativePath: targetNote.relativePath,
            url: `/?note=${targetNote.id}`,
            matches: [{
              noteId: targetNote.id,
              chunkId: `line-${line}`,
              title: '侧栏精确定位',
              relativePath: targetNote.relativePath,
              url: `/?note=${targetNote.id}#L${line}`,
              startLine: line,
              endLine: line,
              matchLine: line,
              headingPath: ['侧栏精确定位'],
              snippet,
              matchedBy: [semantic ? 'semantic' : 'text'],
              sourceHash: '0'.repeat(64),
              sourceRevision: 1,
            }],
          }],
          degraded: false,
          reasons: [],
          index: { pending: 0, checkedAt: null, generation: null },
        },
      });
    });

    const editor = page.getByRole('textbox', { name: '文档正文', exact: true });
    const source = page.locator('.cm-content');
    const input = page.getByRole('textbox', { name: '搜索笔记与目录', exact: true });
    async function openHit(query: string, snippet: string) {
      await showSidebar(page);
      await input.fill(query);
      await page.locator('.search-result').filter({ hasText: snippet }).click();
      const line = original.split('\n').indexOf(snippet) + 1;
      await expect(page).toHaveURL(new RegExp(`note=${targetNote.id}#L${line}$`));
      await closeSidebar(page);
    }
    async function expectPathSelected(path: string) {
      if (mode === 'document') {
        const code = editor.locator('code').filter({ hasText: path });
        await expect(code.locator('.document-search-match')).toHaveText('bin');
        await expect(editor.locator('.document-search-match')).toHaveCount(1);
        await expectSelectedTextIn(code);
      } else {
        await expectSelectedTextIn(source.locator('.cm-line').filter({ hasText: path }));
        await expect(page.locator('.cm-selectionBackground')).toBeVisible();
      }
    }

    await openHit('bin', firstLine);
    await expectPathSelected(firstPath);

    // The same result must restore a selection after the user moves the caret,
    // even though neither the note ID nor its target line changes.
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() || '')).toBe('');
    await openHit('bin', firstLine);
    await expectPathSelected(firstPath);

    // Quoted, padded input still selects the second line's literal substring.
    await openHit('  "bin"  ', secondLine);
    await expectPathSelected(secondPath);

    await openHit(semanticQuery, semanticLine);
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() || '')).toBe('');
    if (mode === 'document') {
      await expect(editor.locator('.document-search-match')).toHaveCount(0);
      await expect(editor.locator('p').filter({ hasText: semanticLine })).toBeInViewport();
    } else {
      await expect(page.locator('.cm-selectionBackground')).toHaveCount(0);
      await expect(source.locator('.cm-activeLine').filter({ hasText: semanticLine })).toBeInViewport();
    }
    expect((await (await page.request.get('/api/notes/' + targetNote.id)).json()).content).toBe(original);
  });
}
