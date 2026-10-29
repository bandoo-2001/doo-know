import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';
import {
  chooseGraphMode,
  chooseGraphOption,
  openGraphPanel,
  captureGraph,
  graphArtifactRoot,
} from '../support/graph-navigation';
test.use({ sourceEditorPreference: true });
test('configures a model, reviews evidence, edits entities, saves views and asks a grounded slow question', async ({
  page,
  context,
}, info) => {
  test.setTimeout(120000);
  page.setDefaultTimeout(15000);
  const fixture = JSON.parse(await readFile('.local/e2e-config.json', 'utf8'));
  test.skip(!fixture.graphModelURL, 'Requires the synthetic graph model protocol fixture.');
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const headers = { origin: new URL(info.project.use.baseURL!).origin, 'x-csrf-token': csrf.token };
  const response = await page.request.post('/api/notes', {
    headers,
    data: {
      folderPath: '00-Inbox',
      fileName: `semantic-${info.project.name}-${Date.now()}.md`,
      content: '# 容器技术笔记\n\nDocker 依赖 Linux 内核。\n\nDocker 和 Linux 用于容器运行。',
    },
  });
  expect(response.status()).toBe(201);
  const note = await response.json();
  await page.goto('/?view=apps&app=graph');
  await expect(page.getByRole('heading', { name: '知识图谱', exact: true })).toBeVisible();
  await openGraphPanel(page, '模型');
  const settings = page.getByRole('dialog', { name: '模型设置' });
  await settings.getByRole('switch', { name: '自动分析内容变化' }).click();
  await settings.getByRole('button', { name: '关闭模型设置' }).click();
  await expect(settings).toContainText('有未保存的更改');
  await settings.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(settings.getByRole('switch', { name: '自动分析内容变化' })).not.toBeChecked();
  await settings.getByRole('button', { name: '关闭模型设置' }).click();
  await settings.getByRole('button', { name: '放弃更改', exact: true }).click();
  await expect(settings).toBeHidden();
  await openGraphPanel(page, '模型');
  await expect(settings.getByRole('switch', { name: '自动分析内容变化' })).toBeChecked();
  await chooseGraphOption(page, '提供方', 'Ollama · 本地模型');
  await settings.getByLabel('服务地址', { exact: true }).fill(fixture.graphModelURL);
  await settings.getByLabel('模型名称', { exact: true }).fill('fixture-knowledge');
  await settings.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(settings.getByRole('status')).toContainText('设置已保存');
  await settings.getByRole('button', { name: '测试已保存连接' }).click();
  await expect(settings.getByRole('status')).toContainText('连接');
  await captureGraph(page, info.project.name, 'model-settings');
  await settings.getByRole('button', { name: '关闭模型设置' }).click();
  await expect
    .poll(
      async () => {
        const r = await page.request.get('/api/graph/review?status=suggested');
        return (await r.json()).some((item: { predicate: string }) => item.predicate === '依赖');
      },
      { timeout: 20000 },
    )
    .toBe(true);
  await openGraphPanel(page, '审核');
  const review = page.getByRole('dialog', { name: '关系审核' });
  const item = review.locator('.graph-review').filter({ hasText: 'Docker' }).first();
  await expect(item).toContainText('Docker 依赖 Linux 内核。');
  await captureGraph(page, info.project.name, 'review');
  await item.getByLabel('关系', { exact: true }).fill('依赖于');
  await item.getByRole('button', { name: '确认 / 保存' }).click();
  await expect(review.locator('.graph-review').filter({ hasText: 'Docker' })).toHaveCount(0);
  await chooseGraphOption(page, '审核状态', '已确认');
  await expect(
    review.locator('.graph-review').getByRole('textbox', { name: '关系', exact: true }),
  ).toHaveValue('依赖于');
  await review.getByRole('button', { name: '关闭关系审核' }).click();
  await page.getByRole('searchbox', { name: '搜索图谱' }).fill('Docker');
  await chooseGraphMode(page, '显示方式', '列表');
  const docker = page
    .locator('.graph-node-select')
    .filter({ hasText: 'Docker' })
    .filter({ hasText: '技术' })
    .first();
  await expect(docker).toBeVisible();
  await docker.click();
  const detail = page.locator('.graph-inspector:visible');
  await expect(detail).toContainText('模型提取');
  if (info.project.name === 'mobile') {
    await page.getByRole('button', { name: '关闭图谱详情', exact: true }).focus();
    await page.keyboard.press('Shift+Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('.graph-ant-drawer'))).toBe(
      true,
    );
  }
  await detail.getByText('整理实体', { exact: true }).click();
  await detail.getByLabel('新增别名', { exact: true }).fill('容器引擎');
  await detail.getByRole('button', { name: '保存别名' }).click();
  await expect(detail).toContainText('容器引擎');
  await detail.getByRole('button', { name: '1 跳关系', exact: true }).click();
  await expect(page.locator('.graph-node-select').filter({ hasText: 'Linux' })).not.toHaveCount(0);
  await detail.getByText('新增人工关系', { exact: true }).click();
  await chooseGraphOption(page, '目标', 'Linux · 技术');
  await detail.getByLabel('关系', { exact: true }).fill('运行于');
  await chooseGraphOption(page, '原文依据', '容器技术笔记');
  await detail.getByRole('button', { name: '添加关系', exact: true }).click();
  await expect(page.locator('.graph-relation-select').filter({ hasText: '运行于' })).toBeAttached();
  await detail.getByRole('button', { name: '关闭详情', exact: true }).click();
  await openGraphPanel(page, '视图');
  const views = page.getByRole('dialog', { name: '视图与导出' });
  await views.getByLabel('保存当前视图', { exact: true }).fill('容器知识视图');
  await views.getByRole('button', { name: '保存视图', exact: true }).click();
  await expect(views.getByRole('button', { name: '容器知识视图', exact: true })).toBeVisible();
  const download = page.waitForEvent('download');
  await views.getByRole('button', { name: '导出当前 JSON' }).click();
  expect((await download).suggestedFilename()).toBe('knowledge-graph.json');
  await views.getByRole('button', { name: '关闭视图与导出' }).click();
  await openGraphPanel(page, '模型');
  await chooseGraphOption(page, '提供方', 'OpenAI 兼容 API');
  await settings.getByLabel('服务地址', { exact: true }).fill(fixture.graphModelURL + '/v1');
  await settings.getByLabel('API 密钥', { exact: true }).fill('fixture-only-graph-key');
  await settings.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(settings.getByRole('status')).toContainText('设置已保存');
  await expect(settings.getByLabel('API 密钥', { exact: true })).toHaveValue('');
  await settings.getByRole('button', { name: '测试已保存连接' }).click();
  await expect(settings.getByRole('status')).toContainText('连接');
  await settings.getByRole('button', { name: '关闭模型设置' }).click();
  await expect
    .poll(
      async () => {
        const status = await (await page.request.get('/api/graph/status')).json();
        return status.pending + status.running + status.failed;
      },
      { timeout: 20000 },
    )
    .toBe(0);
  await openGraphPanel(page, '问答');
  const ask = page.getByRole('dialog', { name: '图谱问答' });
  await ask.getByRole('textbox', { name: '问题', exact: true }).fill('慢速验证：Docker 依赖什么？');
  await ask.getByRole('button', { name: '提问', exact: true }).click();
  await expect(ask.locator('.graph-answer')).toContainText('Docker', { timeout: 25000 });
  await expect(ask.locator('blockquote')).not.toHaveCount(0);
  await ask.getByRole('button', { name: '关闭图谱问答' }).click();
  await page.getByRole('button', { name: /待处理/ }).click();
  const tasks = page.getByRole('dialog', { name: '后台分析' });
  await tasks.getByRole('button', { name: '暂停', exact: true }).click();
  await expect(tasks).toContainText('已暂停');
  await tasks.getByRole('button', { name: '继续', exact: true }).click();
  await tasks.getByRole('button', { name: '关闭后台分析' }).click();
  await chooseGraphMode(page, '显示方式', '画布');
  await page.getByRole('button', { name: '清除局部 / 路径' }).click();
  await expect(page.locator('.graph-details')).toHaveCount(0);
  await page.evaluate(() => {
    document.querySelectorAll('.graph-workspace, .main-content').forEach((element) => {
      element.scrollTop = 0;
    });
    window.scrollTo(0, 0);
  });
  await page.screenshot({
    path: `${graphArtifactRoot}/${info.project.name}-model-graph.png`,
    fullPage: true,
    animations: 'disabled',
  });
  await openGraphPanel(page, '问答');
  await ask
    .getByRole('button', { name: /容器技术笔记 · L/ })
    .first()
    .click();
  await expect(page).toHaveURL(new RegExp('note=' + note.id + '.*#L3'));
  await expect(page.locator('.cm-content').first()).toContainText('Docker 依赖 Linux 内核。');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(errors).toEqual([]);
  expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).toContain(
    'Docker 依赖 Linux 内核。',
  );
});
