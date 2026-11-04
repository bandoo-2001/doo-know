import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { test, expect } from '../support/browser-test';
import {
  authenticateVisualContext,
  seedToDooVisual,
  VISUAL_NOW,
} from '../support/to-doo-visual-fixture';
import { expandToDooGroup, selectToDooOption } from '../support/to-doo-ant-controls';
import { openToDooTaskTools, selectToDooContext } from '../support/to-doo-navigation';

const output = resolve('docs/design/to-doo/two-level-implementation-2026-11-04/screenshots');
const design = JSON.parse(
  await readFile(
    'docs/design/to-doo/layout-redesign-two-level-2026-11-04/generation-plan.json',
    'utf8',
  ),
);
const sections = [
  'overview',
  'tasks',
  'board',
  'matrix',
  'calendar',
  'calendar',
  'timeline',
  'focus',
  'habits',
  'anniversaries',
  'stats',
  'notifications',
  'settings',
  'settings',
  'settings',
  'settings',
  'tasks',
  'tasks',
  'habits',
  'habits',
  'calendar',
  'anniversaries',
  'stats',
  'tasks',
  'overview',
  'settings',
  'focus',
  'settings',
];
let seed: Awaited<ReturnType<typeof seedToDooVisual>>;
let sourceEvidence: { commit: string; sha256: string; files: number };
test.beforeAll(async ({ browser }) => {
  await mkdir(output, { recursive: true });
  const files = [
    ...new Set(
      execFileSync(
        'git',
        ['ls-files', '-z', '-co', '--exclude-standard', '--', 'apps', 'packages', 'shared'],
        { encoding: 'utf8' },
      )
        .split('\0')
        .filter(Boolean),
    ),
  ].sort();
  const hash = createHash('sha256');
  for (const file of files)
    hash
      .update(file)
      .update('\0')
      .update(await readFile(file));
  sourceEvidence = {
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sha256: hash.digest('hex'),
    files: files.length,
  };
  const context = await browser.newContext();
  try {
    await authenticateVisualContext(context);
    seed = await seedToDooVisual(await context.newPage());
  } finally {
    await context.close();
  }
});
test.beforeEach(async ({ context, page }) => {
  await authenticateVisualContext(context);
  await page.clock.install({ time: new Date(VISUAL_NOW) });
});
const widths = process.env.DOOKNOW_TWO_LEVEL_CAPTURE_WIDTHS?.split(',').map(Number) || [
  1440, 390, 320,
];
for (const width of widths)
  for (const [index, scene] of design.scenes.entries()) {
    const n = index + 1,
      section = sections[index];
    test(`${width} ${scene.id}`, async ({ page }) => {
      test.setTimeout(60000);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.setViewportSize({ width, height: width > 700 ? 1000 : 844 });
      const params = new URLSearchParams({
        view: 'apps',
        app: 'to-doo',
        appSection: section,
        taskFilter: 'all',
        date: '2026-10-30',
      });
      if ([2, 3, 4, 17, 18, 24].includes(n)) params.set('taskFilter', 'upcoming');
      if (n === 5) params.set('calendarView', 'month');
      if (n === 6 || n === 21) params.set('calendarView', 'week');
      if (n >= 13 && n <= 16)
        params.set('appPage', ['preferences', 'connections', 'data', 'lists'][n - 13]);
      if (n === 26 || n === 28) params.set('appPage', 'lists');
      if (n === 2 || n === 24) {
        params.set('task', seed.taskId);
        params.set('occurrence', seed.occurrenceId);
      }
      await page.goto('/?' + params);
      const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
      await expect(app.locator('.todo-main')).toHaveAttribute('aria-busy', 'false');
      await expect(app.locator('.todo-content')).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      if (n === 8) await expect(app.locator('.todo-focus-workspace')).toBeVisible();
      if (n === 9)
        await expect(app.locator('.todo-habit-cards')).toHaveAttribute('aria-busy', 'false');
      if (n === 13) await expandToDooGroup(app, '日期与提醒');
      if (n === 15) {
        await expandToDooGroup(app, '导入选项');
        await selectToDooOption(app, '格式', '滴答 CSV');
        await app
          .getByLabel('或粘贴文件内容', { exact: true })
          .fill(
            'Title,Due Date,List Name\n' +
              Array.from(
                { length: 23 },
                (_, i) => `核对导入记录 ${i + 1},2026-11-05 09:00,工作与创造`,
              ).join('\n'),
          );
        await app.getByRole('button', { name: '预览导入', exact: true }).click();
        await expect(
          app.getByRole('button', { name: '确认导入 23 项', exact: true }),
        ).toBeVisible();
        await app.locator('.todo-import-preview').scrollIntoViewIfNeeded();
      }
      if (n === 17) {
        await openToDooTaskTools(page);
        await app
          .getByRole('textbox', { name: '搜索任务', exact: true })
          .fill('不会匹配的筛选验证内容');
        await expect(app.getByText('没有符合当前筛选的任务', { exact: true })).toBeVisible();
      }
      const actions: Record<number, string> = {
        18: '新建任务',
        19: '＋ 新建习惯',
        21: '＋ 时间安排',
        22: '＋ 新建纪念日',
        23: '＋ 写一篇复盘',
        25: '新建目标',
        26: '新建清单',
        27: '新建专注项目',
        28: '新建标签',
      };
      if (actions[n])
        await (n === 26 || n === 28 ? app.locator('.todo-content') : app)
          .getByRole('button', { name: actions[n], exact: true })
          .click();
      if (n === 20) {
        await selectToDooContext(page, '历史');
        await app
          .getByRole('button', { name: '阅读 2026-10-30 打卡，当前 10 页', exact: true })
          .click();
      }
      if (n === 24) {
        const detail = app.getByRole('complementary', { name: '任务详情', exact: true });
        await expandToDooGroup(detail, '完成标准与成果');
        await detail.getByRole('button', { name: '创建成果笔记并关联', exact: true }).click();
      }
      const names: Record<number, string> = {
        19: '新建习惯',
        20: '记录习惯数量',
        21: '新建时间安排',
        22: '新建纪念日',
        23: '新建复盘',
        24: '创建成果笔记',
        25: '新建目标',
        26: '新建清单',
        27: '新建专注项目',
        28: '新建标签',
      };
      const operation = names[n]
        ? page.getByRole('dialog', { name: names[n], exact: true })
        : n === 18 || n === 2
          ? app.getByRole('complementary', { name: '任务详情', exact: true })
          : undefined;
      let primaryAction;
      if (operation) {
        await expect(operation).toBeVisible();
        if (n === 18) {
          await operation.getByLabel('任务标题', { exact: true }).fill('为项目整理清晰的下一步');
          primaryAction = operation.getByRole('button', { name: '创建任务', exact: true });
        } else if (n === 24) {
          await operation
            .getByRole('textbox', { name: '成果正文（Markdown）', exact: true })
            .fill('# 本次行动的成果\n\n完成了下一步方案的整理，记录后续可执行的行动。');
          await operation.getByRole('button', { name: '预览成果正文', exact: true }).click();
          await expect(
            operation.getByRole('heading', { name: '本次行动的成果', exact: true }),
          ).toBeVisible();
          primaryAction = operation.getByRole('button', {
            name: '创建并关联成果笔记',
            exact: true,
          });
        } else if (n !== 2 && n !== 20) {
          await operation
            .getByLabel(n === 21 ? '安排标题' : '名称', { exact: true })
            .fill(
              n === 22 ? '中秋团圆' : n === 23 ? '本周行动复盘' : scene.title.replace('新建', ''),
            );
          primaryAction = operation.getByRole('button', { name: '保存', exact: true });
          if (n === 22) {
            await selectToDooOption(operation, '历法', '农历');
            await operation.getByRole('spinbutton', { name: '农历年', exact: true }).fill('2026');
            await selectToDooOption(operation, '农历月', '八月');
            await operation.getByRole('spinbutton', { name: '农历日', exact: true }).fill('15');
          }
        } else if (n === 20)
          primaryAction = operation.getByRole('button', { name: '记录', exact: true });
        else primaryAction = operation.getByRole('button', { name: '关闭任务详情', exact: true });
        await expect(primaryAction).toBeInViewport();
      }
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              document
                .getAnimations()
                .filter(
                  (a) =>
                    a.playState === 'running' &&
                    Number.isFinite(a.effect?.getComputedTiming().endTime),
                ).length,
          ),
        )
        .toBe(0);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
      ).toBeLessThanOrEqual(1);
      if (width > 1000) {
        const sidebar = app.locator(':scope > .todo-sidebar');
        await expect(sidebar).toBeVisible();
        expect((await sidebar.boundingBox())!.width).toBe(208);
        await expect(sidebar.locator('[aria-current="page"]')).toHaveCount(1);
      }
      const file = `${width}-${scene.file}`;
      const bytes = await page.screenshot({
        path: resolve(output, file),
        fullPage: false,
        animations: 'allow',
      });
      if (operation) await expect(operation).toBeVisible();
      if (primaryAction) await expect(primaryAction).toBeInViewport();
      expect(errors).toEqual([]);
      const record = {
        scene: scene.id,
        title: scene.title,
        section,
        width,
        height: width > 700 ? 1000 : 844,
        file,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        businessTime: VISUAL_NOW,
        source: sourceEvidence,
        url: page.url(),
        operation: names[n] || (n === 18 || n === 2 ? '任务详情' : null),
        operationBounds: operation ? await operation.boundingBox() : null,
        primaryActionReachable: primaryAction ? await primaryAction.isVisible() : null,
      };
      await writeFile(
        resolve(output, file.replace('.png', '.json')),
        JSON.stringify(record, null, 2) + '\n',
      );
    });
  }
