import { execFileSync } from 'node:child_process';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { GitDiffBody, readGitDiff } from '../plugins/git/web/diff-view';

let root: string;
let patch: string;
let renamedPatch: string;
let binaryPatch: string;
const longLine = '中文长行<&>'.repeat(600);
const original = '第一行保留\n删除这一行\n末尾保留\n';
const changed = `第一行保留\n<img src=x onerror="window.diffExecuted=true">\n${longLine}\n末尾保留\n`;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'dooknow-git-diff-view-'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  git('init', '--initial-branch=main');
  git('config', 'user.name', 'Diff Fixture');
  git('config', 'user.email', 'diff-fixture@example.invalid');
  git('config', 'core.quotepath', 'false');
  await writeFile(join(root, '中文笔记.md'), original);
  await writeFile(join(root, 'binary.bin'), Buffer.from([0, 1, 2]));
  git('add', '--all');
  git('commit', '-m', 'Before');
  await writeFile(join(root, '中文笔记.md'), changed);
  patch = git('diff', '--no-ext-diff', '--', '中文笔记.md');
  await writeFile(join(root, '中文笔记.md'), original);
  await rename(join(root, '中文笔记.md'), join(root, '重命名.md'));
  git('add', '--all');
  renamedPatch = git('diff', '--cached', '--find-renames');
  await writeFile(join(root, 'binary.bin'), Buffer.from([0, 3, 4]));
  binaryPatch = git('diff', '--no-ext-diff', '--', 'binary.bin');
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

async function render(diff: string, layout: 'line-by-line' | 'side-by-side' = 'line-by-line') {
  const document = await readGitDiff({ diff });
  return renderToString(h(GitDiffBody, { document, diff, layout }));
}

it('distinguishes deleted and inserted lines with their real old and new line numbers', async () => {
  const document = await readGitDiff({ diff: patch });
  expect(document.status).toBe('ready');
  expect(document.files[0]).toMatchObject({
    oldName: '中文笔记.md',
    newName: '中文笔记.md',
    addedLines: 2,
    deletedLines: 1,
  });
  const html = await render(patch);
  expect(html).toContain('data-line-type="delete" data-old-line="2"');
  expect(html).toContain('data-line-type="insert" data-new-line="2"');
  expect(html).toContain('data-line-type="insert" data-new-line="3"');
  expect(html).toContain('data-old-line="3" data-new-line="4"');
  expect(html).toContain('删除这一行');
  expect(html).toContain('新增 2 行，删除 1 行');
});

it('keeps Chinese, long lines and HTML characters as complete inert text in both layouts', async () => {
  for (const layout of ['line-by-line', 'side-by-side'] as const) {
    const html = await render(patch, layout);
    expect(html).toContain('data-diff-layout="' + layout + '"');
    expect(html).toContain('&lt;img src=x onerror=&quot;window.diffExecuted=true&quot;&gt;');
    expect(html).toContain('中文长行&lt;&amp;&gt;'.repeat(600));
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).toContain('原始差异');
  }
});

it('pairs additions with deletions and preserves unpaired additions in side by side view', async () => {
  const html = await render(patch, 'side-by-side');
  expect(html).toContain('aria-label="旧行 2"');
  expect(html).toContain('aria-label="新行 2"');
  expect(html).toContain('aria-label="新行 3"');
  expect(html).toContain('aria-label="旧行 3"');
  expect(html).toContain('aria-label="新行 4"');
});

it('explains a real rename and binary change without inventing textual lines', async () => {
  const renamed = await render(renamedPatch);
  expect(renamed).toContain('中文笔记.md → 重命名.md');
  expect(renamed).toContain('没有文本行差异');
  const binary = await render(binaryPatch);
  expect(binary).toContain('二进制文件');
  expect(binary).not.toContain('data-line-type=');
});

it('explains an empty diff and keeps an unrecognized patch visible as the raw fallback', async () => {
  expect((await readGitDiff({ diff: '' })).status).toBe('empty');
  expect(await render('')).toContain('没有文本差异');
  const invalid = '无法解析 <img src=x onerror=alert(1)>';
  const document = await readGitDiff({ diff: invalid });
  expect(document.status).toBe('unavailable');
  const html = await renderToString(h(GitDiffBody, { document, diff: invalid }));
  expect(html).toContain('原始差异');
  expect(html).toContain('无法解析 &lt;img src=x onerror=alert(1)&gt;');
  expect(html).toMatch(/<details[^>]*open/);
});

it('honors provider truncation without parsing or exposing a supplied partial patch', async () => {
  const diff = patch + 'DO_NOT_DISPLAY_TRUNCATED_CONTENT';
  const document = await readGitDiff({ diff, truncated: true });
  expect(document).toMatchObject({ status: 'truncated', files: [] });
  const html = await renderToString(h(GitDiffBody, { document, diff }));
  expect(html).toContain('256 KiB');
  expect(html).not.toContain('DO_NOT_DISPLAY_TRUNCATED_CONTENT');
  expect(html).not.toContain('<table');
});

it('keeps the raw patch readable when the lazy parser fails to load', async () => {
  vi.resetModules();
  vi.doMock('diff2html', () => {
    throw Error('Parser chunk unavailable');
  });
  try {
    const module = await import('../plugins/git/web/diff-view');
    const document = await module.readGitDiff({ diff: patch });
    expect(document.status).toBe('unavailable');
    const html = await renderToString(h(module.GitDiffBody, { document, diff: patch }));
    expect(html).toContain('原始差异');
    expect(html).toContain('删除这一行');
    expect(html).toMatch(/<details[^>]*open/);
  } finally {
    vi.doUnmock('diff2html');
    vi.resetModules();
  }
});
