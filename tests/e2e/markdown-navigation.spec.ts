import { test, expect } from '../support/browser-test';
import { openDocumentNote } from '../support/document-editor';
import type { Page } from '@playwright/test';
import { showMainMenu } from '../support/settings-navigation';

const origin = 'http://127.0.0.1:4179';
const fragment = '#%E7%AB%A0%E8%8A%82';
const gap = Array.from({ length: 35 }, (_, i) => `间隔段落 ${i}。\n\n`).join('');
async function createNote(page: Page, content: string) {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const response = await page.request.post('/api/notes', {
    headers: { origin, 'x-csrf-token': csrf.token },
    data: { folderPath: '00-Inbox', fileName: `links-${crypto.randomUUID()}.md`, content },
  });
  expect(response.status()).toBe(201);
  return response.json();
}
async function externalPopup(page: Page, label: string, url: string) {
  const pending = page.waitForEvent('popup');
  await page.getByRole('link', { name: label, exact: true }).click();
  const popup = await pending;
  await expect(popup).toHaveURL(url);
  await popup.close();
}

test('阅读链接准确区分脚注、同路径外链和跨笔记编码章节，刷新与返回保留章节', async ({
  page,
  context,
}, info) => {
  const target = await openDocumentNote(
    page,
    context,
    '# Target\n\n' + gap + '## 章节\n\nDestination',
  );
  const external = 'https://example.org/' + target.relativePath + '#chapter';
  await context.route('https://example.org/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: 'External fixture' }),
  );
  const source = await createNote(
    page,
    `# Source\n\n[查看脚注](#fn1)\n\n[外部资料](${external})\n\n[打开章节](${target.relativePath.split('/').at(-1)}${fragment})\n\n正文[^1]\n\n${gap}[^1]: 有效脚注目标\n`,
  );
  await page.goto('/?note=' + source.id);
  await page.getByRole('button', { name: '阅读', exact: true }).click();
  const article = page.locator('.preview-panel .markdown');
  await expect(article.getByRole('link', { name: '外部资料', exact: true })).toHaveAttribute(
    'target',
    '_blank',
  );
  await expect(article.getByRole('link', { name: '查看脚注', exact: true })).toHaveAttribute(
    'href',
    '#fn1',
  );
  await article.getByRole('link', { name: '查看脚注', exact: true }).click();
  await expect(article.locator('#fn1')).toBeInViewport();
  await expect(page).toHaveURL(origin + '/?note=' + source.id + '#fn1');
  await externalPopup(page, '外部资料', external);
  await article.getByRole('link', { name: '打开章节', exact: true }).click();
  await expect(page).toHaveURL(origin + '/?note=' + target.id + fragment);
  await expect(article.locator('[id="章节"]')).toBeInViewport();
  await page.screenshot({
    path: `.local/optimization-fixes-20261026/frontend/${info.project.name}-chapter.png`,
  });
  await page.reload();
  await expect
    .poll(() =>
      page.evaluate(
        () => window.getSelection()?.anchorNode?.parentElement?.closest('h2')?.textContent,
      ),
    )
    .toBe('章节');
  await expect(
    page
      .getByRole('textbox', { name: '文档正文', exact: true })
      .getByRole('heading', { name: '章节', exact: true }),
  ).toBeInViewport();
  await page.goBack();
  await expect(page).toHaveURL(new RegExp('note=' + source.id));
});

test('文档编辑内部章节定位实际选区，同路径外链打开外部页面', async ({ page, context }) => {
  const target = await openDocumentNote(
    page,
    context,
    '# Target\n\n' + gap + '## 章节\n\nDestination',
  );
  const external = 'https://example.org/' + target.relativePath + '#chapter';
  await context.route('https://example.org/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: 'External fixture' }),
  );
  const source = await createNote(
    page,
    `# Source\n\n[当前章节](${fragment})\n\n[外部资料](${external})\n\n[打开章节](${target.relativePath.split('/').at(-1)}${fragment})\n\n${gap}## 章节\n\nSource destination`,
  );
  await page.goto('/?note=' + source.id);
  await page.getByRole('button', { name: '文档编辑', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '文档正文', exact: true });
  await editor.getByRole('link', { name: '当前章节', exact: true }).click();
  await page.getByRole('button', { name: '打开链接', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => window.getSelection()?.anchorNode?.parentElement?.closest('h2')?.textContent,
      ),
    )
    .toBe('章节');
  await expect(
    page
      .getByRole('textbox', { name: '文档正文', exact: true })
      .getByRole('heading', { name: '章节', exact: true }),
  ).toBeInViewport();
  await expect(page).toHaveURL(origin + '/?note=' + source.id + fragment);
  await page.reload();
  await expect
    .poll(() =>
      page.evaluate(
        () => window.getSelection()?.anchorNode?.parentElement?.closest('h2')?.textContent,
      ),
    )
    .toBe('章节');
  await expect(
    page
      .getByRole('textbox', { name: '文档正文', exact: true })
      .getByRole('heading', { name: '章节', exact: true }),
  ).toBeInViewport();
  await editor.getByRole('link', { name: '外部资料', exact: true }).click();
  const popupPending = page.waitForEvent('popup');
  await page.getByRole('button', { name: '打开链接', exact: true }).click();
  const popup = await popupPending;
  await expect(popup).toHaveURL(external);
  await popup.close();
  await editor.getByRole('link', { name: '打开章节', exact: true }).click();
  await page.getByRole('button', { name: '打开链接', exact: true }).click();
  await expect(page).toHaveURL(origin + '/?note=' + target.id + fragment);
  await expect
    .poll(() =>
      page.evaluate(
        () => window.getSelection()?.anchorNode?.parentElement?.closest('h2')?.textContent,
      ),
    )
    .toBe('章节');
  await expect(
    page
      .getByRole('textbox', { name: '文档正文', exact: true })
      .getByRole('heading', { name: '章节', exact: true }),
  ).toBeInViewport();
});

test('未保存源码切换阅读与分屏立即更新，图片代码图形正常并保留离开确认中的章节', async ({
  page,
  context,
}, info) => {
  const original = '# Original\n\n原文保留。\n';
  const note = await openDocumentNote(page, context, original);
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const upload = await page.request.post('/api/notes/' + note.id + '/assets', {
    headers: { origin, 'x-csrf-token': csrf.token },
    multipart: {
      file: {
        name: 'anchor.png',
        mimeType: 'image/png',
        buffer: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN9sAAAAASUVORK5CYII=',
          'base64',
        ),
      },
    },
  });
  expect(upload.status()).toBe(201);
  const asset = await upload.json();
  const target = await createNote(page, '# Target\n\n' + gap + '## 章节\n\nDestination');
  await page.reload();
  const raw = `# Current draft\n\n[当前章节](${fragment})\n\n[打开章节](${target.relativePath.split('/').at(-1)}${fragment})\n\n![本地图片](${asset.markdownPath})\n\n![拒绝远程](https://example.org/00-Inbox/${asset.markdownPath})\n\n\`\`\`js\nconst code = '<unsafe>';\n\`\`\`\n\n\`\`\`svg\n<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="blue"/></svg>\n\`\`\`\n\n${gap}## 章节\n\nunsaved-marker`;
  let writes = 0,
    remoteImages = 0;
  page.on('request', (request) => {
    if (request.method() === 'PUT' && new URL(request.url()).pathname === '/api/notes/' + note.id)
      writes++;
    if (request.url().startsWith('https://example.org/')) remoteImages++;
  });
  await page.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
  const source = page.locator('.cm-content');
  await source.fill(raw);
  await expect(page.locator('.preview-panel')).toHaveCount(0);
  await page.getByRole('button', { name: '阅读', exact: true }).click();
  const article = page.locator('.preview-panel .markdown');
  await expect(article).toContainText('unsaved-marker');
  await expect(article.locator('pre code')).toContainText("const code = '<unsafe>';");
  const image = article.getByAltText('本地图片', { exact: true });
  await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(1);
  await expect(article.locator('.diagram-card .diagram-image img')).toBeVisible();
  await article.getByRole('link', { name: '当前章节', exact: true }).click();
  await expect(article.locator('[id="章节"]')).toBeInViewport();
  await expect(page.getByRole('dialog', { name: '未保存的修改' })).toBeHidden();
  await page.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
  await expect(source).toContainText('unsaved-marker');
  await source.fill(raw + '-latest');
  await page.getByRole('checkbox', { name: '同时预览', exact: true }).check();
  await expect(article).toContainText('unsaved-marker-latest');
  await page.screenshot({
    path: `.local/optimization-fixes-20261026/frontend/${info.project.name}-draft-split.png`,
  });
  expect(writes).toBe(0);
  expect(remoteImages).toBe(0);
  expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).toBe(original);
  await article.getByRole('link', { name: '打开章节', exact: true }).click();
  const leave = page
    .getByRole('dialog')
    .filter({ hasText: '离开前，请选择如何处理当前编辑内容。' });
  await expect(leave).toBeVisible();
  await leave.getByRole('button', { name: '取消', exact: true }).click();
  await expect(article).toContainText('unsaved-marker-latest');
  await article.getByRole('link', { name: '打开章节', exact: true }).click();
  await leave.getByRole('button', { name: '放弃修改', exact: true }).click();
  await expect(page).toHaveURL(origin + '/?note=' + target.id + fragment);
  await expect(page.locator('.preview-panel [id="章节"]')).toBeInViewport();
});

test('纯章节链接保留刷新历史，设置返回未保存草稿仍定位章节，标题不遮蔽脚注与返回目标', async ({
  page,
  context,
}, info) => {
  const original = `# fn1\n\n# fnref1\n\n[当前章节](${fragment})\n\n[标题定义名](#fn1-1)\n\n[标题返回名](#fnref1-1)\n\n${gap}## 章节\n\n真正引用[^a] 和再次引用[^a]\n\n${gap}[^a]: 真正脚注定义\n`;
  const note = await openDocumentNote(page, context, original);
  await page.getByRole('button', { name: '阅读', exact: true }).click();
  const article = page.locator('.preview-panel .markdown');
  await article.getByRole('link', { name: '当前章节', exact: true }).click();
  await expect(page).toHaveURL(origin + '/?note=' + note.id + fragment);
  await expect(article.locator('[id="章节"]')).toBeInViewport();
  await page.reload();
  await expect
    .poll(() =>
      page.evaluate(
        () => window.getSelection()?.anchorNode?.parentElement?.closest('h2')?.textContent,
      ),
    )
    .toBe('章节');
  await expect(
    page
      .getByRole('textbox', { name: '文档正文', exact: true })
      .getByRole('heading', { name: '章节', exact: true }),
  ).toBeInViewport();
  await page.goBack();
  await expect(page).toHaveURL(origin + '/?note=' + note.id);
  await page.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
  const draft = original + '\nunsaved-round1';
  await page.locator('.cm-content').fill(draft);
  await page.getByRole('button', { name: '阅读', exact: true }).click();
  await article.getByRole('link', { name: '当前章节', exact: true }).click();
  await expect(page).toHaveURL(origin + '/?note=' + note.id + fragment);
  await expect(page.getByRole('dialog', { name: '当前笔记尚未保存', exact: true })).toBeHidden();
  await showMainMenu(page);
  await page.locator('.sidebar-footer').getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.locator('.settings-workspace')).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(origin + '/?note=' + note.id + fragment);
  await expect(article.locator('[id="章节"]')).toBeInViewport();
  await expect(article).toContainText('unsaved-round1');
  const ids = await article.locator('[id]').evaluateAll((nodes) => nodes.map((node) => node.id));
  expect(new Set(ids).size).toBe(ids.length);
  await article.getByRole('link', { name: '标题定义名', exact: true }).click();
  await expect(article.locator('h1[id="fn1-1"]')).toBeInViewport();
  await article.getByRole('link', { name: '标题返回名', exact: true }).click();
  await expect(article.locator('h1[id="fnref1-1"]')).toBeInViewport();
  await article.locator('.footnote-ref a').first().click();
  await expect(page).toHaveURL(origin + '/?note=' + note.id + '#fn1');
  await expect(article.locator('li[id="fn1"]')).toBeInViewport();
  await article.locator('a.footnote-backref[href="#fnref1"]').click();
  await expect(page).toHaveURL(origin + '/?note=' + note.id + '#fnref1');
  await expect(article.locator('.footnote-ref a[id="fnref1"]')).toBeInViewport();
  await page.screenshot({
    path: `.local/optimization-fixes-20261026/frontend/round1-${info.project.name}-footnote.jpg`,
    type: 'jpeg',
    quality: 65,
  });
  await page.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('unsaved-round1');
  expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).toBe(original);
});
