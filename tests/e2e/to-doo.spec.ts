import { readFile, mkdir } from 'node:fs/promises';
import type { Locator } from '@playwright/test';
import { test, expect } from '../support/browser-test';
import { goToToDooSection } from '../support/to-doo-navigation';
import {
  confirmToDooAction,
  expandToDooGroup,
  expectToDooSelection,
  fillToDooDate,
  selectToDooOption,
} from '../support/to-doo-ant-controls';

async function showCompletedTasks(app: Locator) {
  const show = app.getByRole('button', { name: '显示已完成任务', exact: true });
  if (await show.isVisible()) await show.click();
}

test('To Doo creates a real goal and task, preserves edits, completes and survives refresh', async ({
  page,
  context,
}, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.goto('/?view=apps&app=to-doo&appSection=overview');
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间' });
  await expect(app.getByRole('heading', { name: '目标总览', exact: true })).toBeVisible();
  await app.getByRole('button', { name: '新建目标', exact: true }).click();
  const editor = page.getByRole('dialog');
  const name = '浏览器目标 ' + info.project.name + '-' + Date.now();
  await editor.getByLabel('名称', { exact: true }).fill(name);
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(app.locator('.todo-goals').getByRole('button', { name, exact: true })).toBeVisible();
  await app.getByRole('button', { name: '新建任务', exact: true }).first().click();
  await app.getByLabel('任务标题', { exact: true }).fill('验证真实任务持久保存 ' + name);
  await selectToDooOption(app, '目标或清单', name);
  await fillToDooDate(
    app.getByLabel('计划日期', { exact: true }),
    new Date().toISOString().slice(0, 10),
  );
  await expandToDooGroup(app.getByRole('complementary', { name: '任务详情' }), '更多选项');
  await app.getByLabel('完成标准', { exact: true }).fill('确认真实持久化与资料关联');
  await app.getByRole('button', { name: '创建任务', exact: true }).click();
  const detail = app.getByRole('complementary', { name: '任务详情' });
  await expect(detail.getByRole('button', { name: '保存任务', exact: true })).toBeVisible();
  await detail.getByLabel('任务说明', { exact: true }).fill('刷新后应该仍能读到这段记录');
  await detail.getByRole('button', { name: '保存任务', exact: true }).click();
  await expect(app.getByRole('status')).toContainText('任务已保存');
  await expandToDooGroup(detail, '任务附件');
  await detail.getByLabel('上传任务附件', { exact: true }).setInputFiles({
    name: 'task-evidence.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Task evidence from the isolated browser fixture'),
  });
  await expect(app.getByText('附件已上传', { exact: true })).toBeVisible();
  await expect(detail.locator('.todo-attachment')).toContainText('task-evidence.txt');
  const attachmentDownload = page.waitForEvent('download');
  await detail.getByRole('link', { name: '下载', exact: true }).click();
  expect((await attachmentDownload).suggestedFilename()).toBe('task-evidence.txt');
  await detail.getByRole('button', { name: '标记完成', exact: true }).click();
  await expectToDooSelection(detail, '状态', '已完成');
  const taskId = new URL(page.url()).searchParams.get('task');
  await detail.getByRole('button', { name: '关闭任务详情', exact: true }).click();
  for (const [section, label] of [
    ['tasks', '所有任务'],
    ['board', '看板'],
    ['matrix', '四象限'],
    ['overview', '目标总览'],
  ]) {
    await goToToDooSection(page, section!);
    await expect(app.getByRole('heading', { name: label!, exact: true })).toBeVisible();
    await expect(page.getByText('正在载入…', { exact: true })).not.toBeVisible();
    await showCompletedTasks(app);
    const current = await (await page.request.get('/api/to-doo/state?taskIds=' + taskId)).json();
    expect(current.occurrences.find((o: any) => o.taskId === taskId)?.status).toBe('done');
    if (section === 'board')
      await expect(
        app
          .locator('.todo-board-column')
          .filter({ has: page.getByRole('heading', { name: /已完成/ }) }),
      ).toContainText('验证真实任务持久保存 ' + name);
    if (section === 'tasks')
      await expect(
        app.locator('.todo-task-row.is-done').filter({ hasText: '验证真实任务持久保存 ' + name }),
      ).toBeVisible();
  }
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&task=' + taskId);
  await page.reload();
  await expect(app.getByRole('complementary', { name: '任务详情' })).toContainText('已完成');
  await expect(app.getByLabel('任务说明', { exact: true })).toHaveValue(
    '刷新后应该仍能读到这段记录',
  );
});

test('all To Doo sections are reachable on narrow and dark workspaces without overflow', async ({
  page,
  context,
}, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const sections = [
    'overview',
    'tasks',
    'board',
    'calendar',
    'timeline',
    'matrix',
    'focus',
    'habits',
    'anniversaries',
    'stats',
    'notifications',
    'settings',
  ];
  await page.goto('/?view=apps&app=to-doo&appSection=overview');
  await expect(page.getByRole('region', { name: 'To Doo 行动工作空间' })).toBeVisible();
  const labels = [
    '目标总览',
    '所有任务',
    '看板',
    '日历',
    '时间线',
    '四象限',
    '专注',
    '习惯',
    '纪念日',
    '统计与复盘',
    '通知中心',
    '设置',
  ];
  for (const [index, section] of sections.entries()) {
    await goToToDooSection(page, section);
    await expect(page.getByRole('region', { name: 'To Doo 行动工作空间' })).toBeVisible();
    await expect(page.locator('.todo-page h1')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    if (['overview', 'board', 'calendar'].includes(section)) {
      await expect(page.getByText('正在载入…', { exact: true })).not.toBeVisible();
      await mkdir('.sdd/to-doo-full/screenshots', { recursive: true });
      const viewport = page.viewportSize();
      if (info.project.name === 'desktop')
        await page.setViewportSize({ width: 1280, height: 1100 });
      await page.screenshot({
        path: '.sdd/to-doo-full/screenshots/' + info.project.name + '-' + section + '.png',
        fullPage: true,
      });
      if (viewport) await page.setViewportSize(viewport);
    }
  }
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.setViewportSize({ width: 320, height: 844 });
  for (const [index, section] of sections.entries()) {
    await goToToDooSection(page, section);
    await expect(page.locator('.todo-page h1')).toHaveText(labels[index]!);
    await expect(page.getByText('正在载入…', { exact: true })).not.toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await page.screenshot({
    path: '.sdd/to-doo-full/screenshots/' + info.project.name + '-320-dark-settings.png',
    fullPage: true,
  });
});

test('focus, habit check-ins, anniversary and real CSV import/export use durable server data', async ({
  page,
  context,
}) => {
  test.setTimeout(60000);
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.goto('/?view=apps&app=to-doo&appSection=focus');
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间' });
  await expect(app.getByRole('heading', { name: '专注', exact: true })).toBeVisible();
  await expect(page.getByText('正在载入…', { exact: true })).not.toBeVisible();
  await app.getByRole('button', { name: '开始专注', exact: true }).click();
  await app.getByRole('button', { name: '暂停', exact: true }).click();
  await app.getByRole('button', { name: '继续', exact: true }).click();
  await app.getByRole('button', { name: '结束并保存', exact: true }).click();
  await expect(app.getByText('本次专注已保存', { exact: true })).toBeVisible();
  const go = async (section: string, label: string) => {
    await goToToDooSection(page, section);
    await expect(page.locator('.todo-page h1')).toHaveText(label);
    await expect(page.getByText('正在载入…', { exact: true })).not.toBeVisible();
  };
  await go('habits', '习惯');
  await app
    .getByRole('button', { name: /新建习惯/ })
    .first()
    .click();
  const name = '阅读验证 ' + Date.now();
  await page.getByRole('dialog').getByLabel('名称', { exact: true }).fill(name);
  await page.getByRole('dialog').getByLabel('单位', { exact: true }).fill('页');
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  await expect(app.getByRole('button', { name, exact: true })).toBeVisible();
  const today = new Date().toISOString().slice(0, 10);
  await app
    .getByRole('button', { name: name + ' ' + today + ' 打卡，当前 0 页', exact: true })
    .click();
  const habitCount = page.getByRole('dialog', { name: '记录习惯数量', exact: true });
  await habitCount.getByRole('spinbutton', { name: '习惯数量', exact: true }).fill('2');
  await habitCount.getByRole('button', { name: '保存', exact: true }).click();
  await expect(habitCount).not.toBeVisible();
  await expect(
    app.getByRole('button', { name: name + ' ' + today + ' 打卡，当前 2 页', exact: true }),
  ).toHaveText('✓');
  await app.getByRole('button', { name, exact: true }).click();
  const habitEditor = page.getByRole('dialog', { name: '编辑习惯', exact: true });
  await expect(habitEditor).toBeVisible();
  await page
    .getByRole('dialog')
    .getByRole('spinbutton', { name: '目标数量', exact: true })
    .fill('3');
  await fillToDooDate(
    page.getByRole('dialog').getByLabel('规则生效日期', { exact: true }),
    new Date(Date.now() + 86400000).toISOString().slice(0, 10),
  );
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  await expect(
    app.getByRole('button', { name: name + ' ' + today + ' 打卡，当前 2 页', exact: true }),
  ).toHaveText('✓');
  await go('anniversaries', '纪念日');
  await app
    .getByRole('button', { name: /新建纪念日/ })
    .first()
    .click();
  await page
    .getByRole('dialog')
    .getByLabel('名称', { exact: true })
    .fill('重要日子 ' + name);
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  await expect(app.getByRole('heading', { name: '重要日子 ' + name, exact: true })).toBeVisible();
  await go('settings', '设置');
  const download = page.waitForEvent('download');
  await app.getByRole('button', { name: '导出 JSON', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('to-doo.json');
  await selectToDooOption(app, '格式', '滴答 CSV');
  await app
    .getByLabel('或粘贴文件内容', { exact: true })
    .fill('Title,Status\nImported ' + name + ',todo\n');
  await app.getByRole('button', { name: '预览导入', exact: true }).click();
  await expect(app.locator('.todo-import-preview')).toContainText('Imported ' + name);
  await app.getByRole('button', { name: /确认导入 \d+ 项/ }).click();
  await expect(app.getByText('导入已保存', { exact: true })).toBeVisible();
  await go('tasks', '所有任务');
  await app.getByRole('textbox', { name: '搜索任务', exact: true }).fill('Imported ' + name);
  await app.getByRole('button', { name: '执行搜索', exact: true }).click();
  await expect(app.getByRole('button', { name: 'Imported ' + name, exact: true })).toBeVisible();
});

test.describe('To Doo source and evidence', () => {
  test.use({ sourceEditorPreference: true });
  test('an unsaved note can create a linked action and a real outcome note without overwriting its source', async ({
    page,
    context,
  }) => {
    await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
    const csrf = await (await page.request.get('/api/security/csrf')).json();
    const headers = { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token };
    const savedContent = '# 来源验证\n\n原始资料保持不变。\n';
    const response = await page.request.post('/api/notes', {
      headers,
      data: {
        folderPath: '00-Inbox',
        fileName: 'to-doo-source-' + Date.now() + '.md',
        content: savedContent,
        requestId: crypto.randomUUID(),
      },
    });
    expect(response.ok()).toBe(true);
    const note = await response.json();
    await page.goto('/?note=' + encodeURIComponent(note.id));
    await expect(page.locator('.cm-content')).toBeVisible();
    await page.locator('.cm-content').fill('# 来源验证\n\n- [ ] 草稿中的跟进行动\n');
    await page.locator('.cm-content').press('End');
    await page.getByRole('button', { name: '更多操作', exact: true }).click();
    await page.getByRole('button', { name: '创建关联任务', exact: true }).click();
    const capture = page.locator('.to-doo-capture-form');
    await expect(capture).toBeVisible();
    const taskTitle = '从资料推进 ' + Date.now();
    await capture.getByRole('textbox', { name: '任务标题', exact: true }).fill(taskTitle);
    await capture.getByRole('button', { name: '创建任务', exact: true }).click();
    const app = page.getByRole('region', { name: 'To Doo 行动工作空间' }),
      detail = app.getByRole('complementary', { name: '任务详情' });
    await expect(detail.getByRole('button', { name: '保存任务', exact: true })).toBeVisible();
    const taskId = new URL(page.url()).searchParams.get('task');
    expect(taskId).toBeTruthy();
    const state = await (
      await page.request.get('/api/to-doo/state?taskIds=' + taskId + '&includeTree=true')
    ).json();
    const task = state.tasks.find((t: any) => t.id === taskId);
    expect(task.source.noteId).toBe(note.id);
    expect(task.source.draft).toBe(true);
    expect(task.source.quote).toContain('草稿中的跟进行动');
    await expandToDooGroup(detail, '完成标准与成果');
    await detail.getByRole('button', { name: '创建成果笔记并关联', exact: true }).click();
    const outcome = page.getByRole('dialog', { name: '创建成果笔记', exact: true });
    await outcome.getByLabel('笔记标题', { exact: true }).fill('已验证成果 ' + taskTitle);
    await outcome
      .getByLabel('成果正文（Markdown）', { exact: true })
      .fill('# 成果证据\n\n完成了一次真实的行动与成果关联。\n');
    await outcome.getByRole('checkbox', { name: '同时完成这次行动', exact: true }).check();
    const sourceOccurrence = state.occurrences.find((o: any) => o.taskId === taskId);
    const changed = await page.request.post('/api/to-doo/commands', {
      headers,
      data: {
        requestId: crypto.randomUUID(),
        action: 'set_occurrence_status',
        payload: {
          id: sourceOccurrence.id,
          expectedRevision: sourceOccurrence.revision,
          status: 'doing',
        },
      },
    });
    expect(changed.ok()).toBe(true);
    await outcome.getByRole('button', { name: '创建并关联成果笔记', exact: true }).click();
    await expect(outcome.getByRole('alert')).toContainText('版本');
    await outcome.getByRole('button', { name: '核对当前任务版本后继续', exact: true }).click();
    await confirmToDooAction(page);

    await expect(app.getByText('成果笔记已创建并关联', { exact: true })).toBeVisible();
    const after = await (
      await page.request.get('/api/to-doo/state?taskIds=' + taskId + '&includeTree=true')
    ).json();
    const occurrence = after.occurrences.find((o: any) => o.taskId === taskId);
    expect(occurrence.status).toBe('done');
    const evidence = after.outcomes.find((o: any) => o.occurrenceId === occurrence.id);
    expect(evidence.evidenceRefs).toHaveLength(1);
    const output = await (
      await page.request.get('/api/notes/' + evidence.evidenceRefs[0].noteId)
    ).json();
    expect(output.content).toContain('完成了一次真实的行动与成果关联');
    const source = await (await page.request.get('/api/notes/' + note.id)).json();
    expect(source.content).toBe(savedContent);
    await app.getByRole('button', { name: '打开成果笔记', exact: true }).click();
    await page.getByRole('button', { name: '放弃修改', exact: true }).click();
    await expect(page.locator('.cm-content')).toContainText('完成了一次真实的行动与成果关联');
    // The original prepared intent survives a browser restart before any note exists.
    const pendingCreate = await page.request.post('/api/to-doo/commands', {
      headers,
      data: {
        requestId: crypto.randomUUID(),
        action: 'create_task',
        payload: { title: '恢复成果 ' + taskTitle },
      },
    });
    expect(pendingCreate.ok()).toBe(true);
    const pendingData = await pendingCreate.json(),
      pendingTask = pendingData.snapshot.tasks.find(
        (t: any) => t.title === '恢复成果 ' + taskTitle,
      ),
      pendingOccurrence = pendingData.snapshot.occurrences.find(
        (o: any) => o.taskId === pendingTask.id,
      );
    const folder = '00-Inbox/outcome-recovery-' + Date.now(),
      pendingTitle = '中断后继续 ' + taskTitle;
    const failed = await page.request.post('/api/to-doo/outcome-note', {
      headers,
      data: {
        requestId: crypto.randomUUID(),
        occurrenceId: pendingOccurrence.id,
        expectedRevision: pendingOccurrence.revision,
        title: pendingTitle,
        folderPath: folder,
        content: '# 原正文保持不变\n\n准备状态也能恢复。',
        verification: 'practice',
        complete: true,
        criteriaResults: [],
      },
    });
    expect(failed.ok()).toBe(false);
    const pendingState = await (
      await page.request.get('/api/to-doo/state?kind=operation&limit=50')
    ).json();
    const pendingOperation = pendingState.operations.find((o: any) => o.title === pendingTitle);
    expect(pendingOperation).toBeTruthy();
    expect(pendingOperation.noteId).toBeNull();
    const createdFolder = await page.request.post('/api/folders', {
      headers,
      data: { parent: '00-Inbox', name: folder.split('/').at(-1) },
    });
    expect(createdFolder.ok()).toBe(true);
    await page.goto('/?view=apps&app=to-doo&appSection=settings');
    const recovery = app
      .locator('.todo-setting-row')
      .filter({ has: page.getByRole('heading', { name: pendingTitle, exact: true }) });
    await expect(recovery).toBeVisible();
    await recovery.getByRole('button', { name: '核对并继续', exact: true }).click();
    await expect(outcome.getByLabel('成果正文（Markdown）', { exact: true })).toHaveValue(
      '# 原正文保持不变\n\n准备状态也能恢复。',
    );
    await outcome.getByRole('button', { name: '核对当前任务版本后继续', exact: true }).click();
    await confirmToDooAction(page);
    await expect(app.getByText('成果笔记已创建并关联', { exact: true })).toBeVisible();
    const recovered = await (
      await page.request.get('/api/to-doo/state?kind=operation&limit=50')
    ).json();
    const original = recovered.operations.find((o: any) => o.id === pendingOperation.id);
    expect(original.state).toBe('completed');
    expect(recovered.operations.filter((o: any) => o.title === pendingTitle)).toHaveLength(1);
  });
});

test('bulk and cascade completion freeze execution membership and persist their actual states', async ({
  page,
  context,
}, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const csrf = await (await page.request.get('/api/security/csrf')).json(),
    headers = { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token };
  const suffix = info.project.name + '-' + Date.now();
  const seed = async (title: string, parentTaskId?: string) => {
    const response = await page.request.post('/api/to-doo/commands', {
      headers,
      data: {
        requestId: crypto.randomUUID(),
        action: 'create_task',
        payload: { title, ...(parentTaskId ? { parentTaskId } : {}) },
      },
    });
    expect(response.ok()).toBe(true);
    const data = await response.json();
    return data.snapshot.tasks.find((t: any) => t.title === title);
  };
  const parent = await seed('级联父项 ' + suffix);
  await seed('级联子项 ' + suffix, parent.id);
  const batchParent = await seed('批量父项 ' + suffix);
  await seed('批量子项 ' + suffix, batchParent.id);
  const cancelled = await seed('批量取消 ' + suffix);
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&task=' + parent.id);
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间' }),
    detail = app.getByRole('complementary', { name: '任务详情' });
  await expect(detail.getByLabel('任务标题', { exact: true })).toHaveValue(parent.title);
  const cascadeRequest = page.waitForRequest(
    (r) => r.method() === 'POST' && r.url().endsWith('/api/to-doo/commands'),
  );
  await detail.getByRole('button', { name: '标记完成', exact: true }).click();
  await confirmToDooAction(page);
  const cascadeBody = (await cascadeRequest).postDataJSON();
  expect(cascadeBody.payload.expectedOccurrenceIds).toHaveLength(2);
  expect(Object.keys(cascadeBody.payload.expectedRevisions)).toHaveLength(4);
  await expectToDooSelection(detail, '状态', '已完成');
  await detail.getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await app.getByRole('button', { name: '任务管理', exact: true }).click();
  await page.getByRole('menuitem', { name: '多选', exact: true }).click();
  await app.getByRole('checkbox', { name: '选择 ' + batchParent.title, exact: true }).check();
  const batchRequest = page.waitForRequest(
    (r) => r.method() === 'POST' && r.url().endsWith('/api/to-doo/commands'),
  );
  await app.getByRole('button', { name: '完成整棵子树', exact: true }).click();
  const batchBody = (await batchRequest).postDataJSON();
  expect(batchBody.payload.occurrenceIds).toHaveLength(2);
  expect(Object.keys(batchBody.payload.expectedRevisions)).toHaveLength(4);
  await expect(app.getByRole('status')).toContainText('批量操作已保存');
  await showCompletedTasks(app);
  await app.getByRole('checkbox', { name: '选择 ' + batchParent.title, exact: true }).uncheck();
  await app.getByRole('checkbox', { name: '选择 ' + cancelled.title, exact: true }).check();
  const cancelledResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().endsWith('/api/to-doo/commands') &&
      response.request().postDataJSON()?.payload?.operation === 'cancel',
  );
  await expandToDooGroup(app, '更多批量操作');
  await app.getByRole('button', { name: '取消', exact: true }).click();
  expect((await cancelledResponse).ok()).toBe(true);
  await expect(app.getByRole('status')).toContainText('批量操作已保存');
  await page.reload();
  for (const [taskId, status] of [
    [parent.id, 'done'],
    [batchParent.id, 'done'],
    [cancelled.id, 'cancelled'],
  ]) {
    const state = await (
      await page.request.get('/api/to-doo/state?taskIds=' + taskId + '&includeTree=true')
    ).json();
    expect(state.occurrences.length).toBeGreaterThan(0);
    expect(state.occurrences.every((o: any) => o.status === status)).toBe(true);
  }
});
