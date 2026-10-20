import { chromium } from 'playwright';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { basename, dirname, resolve, join } from 'node:path';
import { tmpdir, cpus, platform, release } from 'node:os';
import { gzipSync } from 'node:zlib';
import Database from 'better-sqlite3';
const config = JSON.parse(await readFile('.local/e2e-config.json', 'utf8'));
const root = dirname(resolve(config.dataRoot));
if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith('dooknow-browser-'))
  throw Error('基准只允许使用独立浏览器测试实例');
const db = new Database(join(config.dataRoot, 'app.sqlite'), { fileMustExist: true });
db.prepare('DELETE FROM rateLimit').run();
db.close();
const browser = await chromium.launch();
const p95 = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1] || 0;
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const page = await context.newPage();
  const seed = async (content: string) => {
    const csrf = await (await page.request.get('http://127.0.0.1:4179/api/security/csrf')).json();
    const r = await page.request.post('http://127.0.0.1:4179/api/notes', {
      headers: { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token },
      data: { folderPath: '00-Inbox', fileName: `benchmark-${crypto.randomUUID()}.md`, content },
    });
    if (r.status() !== 201) throw Error('基准语料创建失败');
    return (await r.json()).id;
  };
  const table =
    '| ' +
    Array.from({ length: 10 }, (_, i) => 'Column ' + i).join(' | ') +
    ' |\n| ' +
    Array(10).fill('---').join(' | ') +
    ' |\n' +
    Array.from(
      { length: 100 },
      (_, i) => '| ' + Array.from({ length: 10 }, (_, j) => `cell-${i}-${j}`).join(' | ') + ' |',
    ).join('\n');
  function corpus(bytes: number, withTable = false) {
    let text = '# Writing benchmark\n\n' + (withTable ? table + '\n\n' : '');
    while (Buffer.byteLength(text) < bytes)
      text += 'Normal paragraph with ordinary words for editing. '.repeat(12) + '\n\n';
    return text;
  }
  const small = corpus(10 * 1024),
    large = corpus(200 * 1024, true);
  const samples: Record<string, unknown> = {};
  let smallId = '';
  for (const [name, content] of [
    ['10KiB', small],
    ['200KiB-table100x10', large],
  ]) {
    const id = await seed(content);
    if (name === '10KiB') smallId = id;
    await page.goto('http://127.0.0.1:4179/?note=' + id);
    await page.getByRole('button', { name: '文档编辑', exact: true }).click();
    await page.getByRole('textbox', { name: '文档正文', exact: true }).waitFor();
    const durations: number[] = [];
    for (let i = 0; i < 35; i++) {
      await page.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
      await page.locator('.cm-content').waitFor();
      const start = performance.now();
      await page.getByRole('button', { name: '文档编辑', exact: true }).click();
      await page.getByRole('textbox', { name: '文档正文', exact: true }).waitFor();
      await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
      if (i >= 5) durations.push(performance.now() - start);
    }
    samples[name] = {
      bytes: Buffer.byteLength(content),
      warmups: 5,
      samples: durations.length,
      p95Ms: p95(durations),
      maxMs: Math.max(...durations),
    };
  }
  await page.goto('http://127.0.0.1:4179/?note=' + smallId);
  const editor = page.getByRole('textbox', { name: '文档正文', exact: true });
  await editor.waitFor();
  await editor.locator('p').first().click();
  await page.keyboard.press('End');
  await editor.evaluate((el) => {
    (window as any).__inputDurations = [];
    el.addEventListener(
      'beforeinput',
      () => {
        const start = performance.now();
        requestAnimationFrame(() => {
          (window as any).__inputDurations.push(performance.now() - start);
        });
      },
      true,
    );
  });
  await page.keyboard.type('x'.repeat(200));
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
  const input = await page.evaluate(() => (window as any).__inputDurations as number[]);
  samples.input = { samples: input.length, p95Ms: p95(input), maxMs: Math.max(...input) };
  const session = await (
    await context.request.get('http://127.0.0.1:4179/api/auth/get-session')
  ).json();
  const readPage = await context.newPage();
  await readPage.addInitScript(
    ({ key }) =>
      localStorage.setItem(key, JSON.stringify({ editorKind: 'document', mode: 'preview' })),
    { key: 'dooknow.preferences.v1:' + encodeURIComponent(session.user.id) },
  );
  const requested: string[] = [];
  readPage.on('request', (r) => requested.push(r.url()));
  await readPage.goto('http://127.0.0.1:4179/?note=' + smallId);
  await readPage.locator('.preview-panel').waitFor();
  await readPage.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
  const editorModules = requested.filter((url) =>
    /\/components\/(DocumentEditor|MarkdownEditor)\.vue(?:\?|$)/.test(url),
  );
  samples.reading = { editorModules };
  let bundles: unknown[] = [];
  let incrementalBundles: Record<string, unknown> = {};
  try {
    const manifest: Record<string, { file: string; name?: string; imports?: string[] }> =
      JSON.parse(await readFile('dist/web/.vite/manifest.json', 'utf8'));
    const graph = (key: string, seen = new Set<string>()): Set<string> => {
      if (seen.has(key) || !manifest[key]) return seen;
      seen.add(key);
      for (const child of manifest[key].imports || []) graph(child, seen);
      return seen;
    };
    const base = new Set([...graph('index.html'), ...graph('components/Workspace.vue')]);
    for (const name of ['DocumentEditor', 'MarkdownEditor']) {
      const key = Object.keys(manifest).find((k) => manifest[k].name === name);
      if (!key) continue;
      const added = [...graph(key)].filter((k) => !base.has(k));
      const files = await Promise.all(
        added.map(async (k) => ({
          file: manifest[k].file,
          gzipBytes: gzipSync(await readFile(join('dist/web', manifest[k].file))).length,
        })),
      );
      incrementalBundles[name] = {
        files,
        totalGzipBytes: files.reduce((n, f) => n + f.gzipBytes, 0),
      };
    }
    const dir = 'dist/web/assets';
    bundles = await Promise.all(
      (await readdir(dir))
        .filter((f) => /DocumentEditor|MarkdownEditor|NoteEditorHost/.test(f) && f.endsWith('.js'))
        .map(async (file) => ({
          file,
          gzipBytes: gzipSync(await readFile(join(dir, file))).length,
        })),
    );
  } catch {}
  const result = {
    date: new Date().toISOString(),
    environment: {
      platform: platform(),
      release: release(),
      cpu: cpus()[0]?.model,
      node: process.version,
      browser: browser.version(),
      viewport: '1440x900',
      mode: 'local Vite development',
    },
    samples,
    bundles,
    incrementalBundles,
  };
  await writeFile(
    '.local/document-editor-validation/benchmark.json',
    JSON.stringify(result, null, 2) + '\n',
  );
  console.log(JSON.stringify(result, null, 2));
  const a = samples['10KiB'] as any,
    b = samples['200KiB-table100x10'] as any;
  if (
    a.p95Ms > 300 ||
    b.p95Ms > 1500 ||
    input.length < 200 ||
    p95(input) > 50 ||
    editorModules.length
  )
    process.exitCode = 1;
} finally {
  await browser.close();
}
