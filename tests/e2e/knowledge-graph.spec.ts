import { mkdir, readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';
import { chooseGraphMode, captureGraph, graphArtifactRoot } from '../support/graph-navigation';

test.use({ sourceEditorPreference: true });
test('keeps explicit note exploration available in the calm graph workspace', async ({
  page,
  context,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const headers = { origin: new URL(info.project.use.baseURL!).origin, 'x-csrf-token': csrf.token };
  const prefix = `references-${info.project.name}-${Date.now()}`;
  const create = async (suffix: string, content: string) => {
    const response = await page.request.post('/api/notes', {
      headers,
      data: { folderPath: '00-Inbox', fileName: `${prefix}-${suffix}.md`, content },
    });
    expect(response.status()).toBe(201);
    return response.json();
  };
  await create('target', '# 概念与实践');
  await create('middle', `# 连接知识\n\n[[${prefix}-target]]`);
  const source = await create('source', `# 从引用开始\n\n[[${prefix}-middle]]\n\n原文保持完整。`);
  await create('orphan', '# 等待连接的想法');
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/graph/explore?view=notes&q=${prefix}`)).json()).nodes
          .length,
    )
    .toBe(4);
  await page.goto('/?view=apps&app=graph&appSection=overview');
  await expect(page.getByRole('heading', { name: '知识图谱', exact: true })).toBeVisible();
  await chooseGraphMode(page, '图谱类型', '笔记');
  await page.getByRole('searchbox', { name: '搜索图谱' }).fill(prefix.toUpperCase());
  await chooseGraphMode(page, '显示方式', '列表');
  const nodes = page.locator('.graph-node-select');
  await expect(nodes).toHaveCount(4);
  await nodes.filter({ hasText: '从引用开始' }).click();
  const detail = page.locator('.graph-inspector:visible');
  await detail.getByRole('button', { name: '1 跳关系', exact: true }).click();
  await expect(nodes).toHaveCount(2);
  await detail.getByRole('button', { name: '2 跳关系', exact: true }).click();
  await expect(nodes).toHaveCount(3);
  await detail.getByRole('button', { name: '关闭详情', exact: true }).click();
  await page.getByRole('button', { name: '清除局部 / 路径' }).click();
  await page.getByRole('searchbox', { name: '搜索图谱' }).fill(prefix);
  await expect(nodes).toHaveCount(4);
  await page.getByRole('button', { name: '筛选', exact: true }).click();
  const filters = page.getByRole('dialog', { name: '筛选与路径' });
  await expect(filters.getByRole('slider', { name: '最低置信度', exact: true })).toBeVisible();
  await expect(filters.getByRole('slider', { name: '最低语义相似度', exact: true })).toHaveCount(0);
  await filters.getByRole('checkbox', { name: '显示语义相似（向量）', exact: true }).check();
  const similarity = filters.getByRole('slider', { name: '最低语义相似度', exact: true });
  await expect(similarity).toBeVisible();
  await expect(similarity).toHaveAttribute('aria-valuenow', '0.65');
  await captureGraph(page, info.project.name, 'vector-filters');
  await filters.getByRole('button', { name: '关闭筛选与路径' }).click();
  await expect(page.getByRole('alert').filter({ hasText: '设置 → 搜索与索引' })).toBeVisible();
  await page.getByRole('button', { name: '筛选', exact: true }).click();
  await filters.getByRole('checkbox', { name: '显示语义相似（向量）', exact: true }).uncheck();
  await filters.getByRole('checkbox', { name: '仅孤立节点' }).check();
  await filters.getByRole('button', { name: '关闭筛选与路径' }).click();
  await expect(nodes).toHaveCount(1);
  await expect(nodes.first()).toContainText('等待连接的想法');
  await page.getByRole('button', { name: '筛选', exact: true }).click();
  await filters.getByRole('checkbox', { name: '仅孤立节点' }).uncheck();
  await filters.getByRole('button', { name: '关闭筛选与路径' }).click();
  await expect(nodes).toHaveCount(4);
  await nodes.filter({ hasText: '从引用开始' }).click();
  await detail.getByRole('button', { name: '打开原文', exact: true }).click();
  await expect(page).toHaveURL(new RegExp('note=' + source.id));
  await expect(page.locator('.cm-content').first()).toContainText('原文保持完整。');
  await page.goBack();
  await expect(page.getByRole('heading', { name: '知识图谱', exact: true })).toBeVisible();
  await page.reload();
  await chooseGraphMode(page, '显示方式', '画布');
  const canvas = page.getByRole('region', { name: /知识关系画布/ });
  await expect(canvas.locator('canvas').first()).toBeVisible();
  await expect(page.locator('.graph-note-list')).toHaveCount(0);
  await expect(page.locator('.graph-details')).toHaveCount(0);
  await mkdir(graphArtifactRoot, { recursive: true });
  await page.evaluate(() => {
    document.querySelectorAll('.graph-workspace, .main-content').forEach((element) => {
      element.scrollTop = 0;
    });
    window.scrollTo(0, 0);
  });
  await page.screenshot({
    path: `${graphArtifactRoot}/${info.project.name}-overview.png`,
    fullPage: true,
    animations: 'disabled',
  });
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage).filter((key) =>
      key.startsWith('dooknow.preferences.v1:'),
    )) {
      const preference = JSON.parse(localStorage.getItem(key) || '{}');
      localStorage.setItem(key, JSON.stringify({ ...preference, theme: 'dark' }));
    }
  });
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(canvas.locator('canvas').first()).toBeVisible();
  await page.screenshot({
    path: `${graphArtifactRoot}/${info.project.name}-overview-dark.png`,
    fullPage: true,
    animations: 'disabled',
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await chooseGraphMode(page, '显示方式', '列表');
  await page.locator('.graph-node-select').first().click();
  const darkEvidence = page.locator('.graph-inspector:visible .inspector-evidence-card').first();
  await expect(darkEvidence).toBeVisible();
  const background = await darkEvidence.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  expect(Math.max(...(background.match(/\d+/g) || []).slice(0, 3).map(Number))).toBeLessThan(100);
  await captureGraph(page, info.project.name, 'inspector-dark');
  expect(errors).toEqual([]);
});
