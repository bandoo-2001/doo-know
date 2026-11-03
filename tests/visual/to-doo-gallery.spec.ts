import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { Page } from '@playwright/test';
import { test, expect } from '../support/browser-test';
import {
  authenticateVisualContext,
  seedToDooVisual,
  VISUAL_NOW,
  VISUAL_ORIGIN,
} from '../support/to-doo-visual-fixture';
import { expandToDooGroup } from '../support/to-doo-ant-controls';
import { openToDooFocusHistory } from '../support/to-doo-navigation';

const output = resolve('docs/design/to-doo/unified-ui-v2/verification/current-ui');
const cases = [
  { id: '01-tasks', section: 'tasks', label: '所有任务与详情', ready: '.todo-tree' },
  { id: '02-board', section: 'board', label: '任务看板', ready: '.todo-board' },
  { id: '03-goals', section: 'overview', label: '目标总览', ready: '.todo-goals' },
  {
    id: '04-calendar-week',
    section: 'calendar',
    label: '日历周视图',
    query: { calendarView: 'week', date: '2026-10-30' },
    ready: '.todo-week:visible, .todo-mobile-agenda:visible',
  },
  {
    id: '05-calendar-month',
    section: 'calendar',
    label: '日历月视图',
    query: { calendarView: 'month', date: '2026-10-30' },
    ready: '.todo-month:visible, .todo-mobile-agenda:visible',
  },
  {
    id: '06-timeline',
    section: 'timeline',
    label: '时间线',
    query: { date: '2026-10-30' },
    ready: '.todo-timeline',
  },
  { id: '07-matrix', section: 'matrix', label: '四象限', ready: '.todo-quadrants' },
  { id: '08-focus', section: 'focus', label: '专注与历史', ready: '.todo-focus-workspace' },
  {
    id: '09-habits',
    section: 'habits',
    label: '习惯数量记录',
    ready: '.todo-habit-cards[aria-busy="false"]',
  },
  { id: '10-anniversaries', section: 'anniversaries', label: '纪念日', ready: '.todo-anniversary' },
  { id: '11-review', section: 'stats', label: '统计与复盘', ready: '.todo-review-statistics' },
  { id: '12-notifications', section: 'notifications', label: '通知', ready: '.todo-page-heading' },
  { id: '13-settings', section: 'settings', label: '设置', ready: '.todo-settings' },
] as const;
type Theme = 'light' | 'dark';
let seeded: Awaited<ReturnType<typeof seedToDooVisual>>;

async function sourceFingerprint() {
  const files = [
    ...new Set(
      execFileSync(
        'git',
        [
          'ls-files',
          '-z',
          '-co',
          '--exclude-standard',
          '--',
          'apps',
          'packages',
          'shared',
          'plugins',
          'scripts',
          'tests',
          'package.json',
          'package-lock.json',
          'vite.config.ts',
          'playwright.config.ts',
          'playwright.to-doo-visual.config.ts',
        ],
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
  return {
    sha256: hash.digest('hex'),
    files: files.length,
    head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  };
}
async function theme(page: Page, selected: Theme) {
  await page.evaluate(async (selected) => {
    const modulePath = '/preferences.ts';
    const preferences = await import(modulePath);
    preferences.setEditorPreferences({ theme: selected });
  }, selected);
  await expect(page.locator('html')).toHaveAttribute('data-theme', selected);
}
async function settle(page: Page) {
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
  await expect(app).toBeVisible();
  await expect(app.locator('.todo-main')).toHaveAttribute('aria-busy', 'false');
  await expect(app.locator('.todo-loading')).toHaveCount(0);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  return app;
}
async function visit(
  page: Page,
  section: string,
  selectedTheme: Theme,
  query: Record<string, string> = {},
) {
  const params = new URLSearchParams({
    view: 'apps',
    app: 'to-doo',
    appSection: section,
    taskFilter: 'all',
    ...query,
  });
  await page.goto('/?' + params);
  await settle(page);
  await theme(page, selectedTheme);
  return settle(page);
}
function closeTo(actual: number, expected: number, label: string) {
  expect(Math.abs(actual - expected), label + ' (CSS pixels, tolerance 1px)').toBeLessThanOrEqual(
    1,
  );
}

test.beforeAll(async ({ browser }) => {
  await mkdir(output, { recursive: true });
  await writeFile(
    resolve(output, 'status.json'),
    JSON.stringify({ status: 'running', fixedTime: VISUAL_NOW }, null, 2),
  );
  const context = await browser.newContext({ baseURL: VISUAL_ORIGIN });
  try {
    await authenticateVisualContext(context);
    seeded = await seedToDooVisual(await context.newPage());
  } finally {
    await context.close();
  }
});
test.beforeEach(async ({ context, page }) => {
  await authenticateVisualContext(context);
  await page.clock.install({ time: new Date(VISUAL_NOW) });
});

type VisualJob = {
  key: string;
  width: number;
  theme: Theme;
  view?: (typeof cases)[number];
  editor?: string;
};
const jobs: VisualJob[] = [
  ...[1440, 1873, 1024, 768, 390, 320].flatMap((width) =>
    (['light', 'dark'] as const).flatMap((theme) =>
      cases.map((view) => ({ key: `${width}-${theme}-${view.id}`, width, theme, view })),
    ),
  ),
  ...(['light', 'dark'] as const).flatMap((theme) =>
    ['task', 'habit', 'anniversary', 'schedule', 'outcome', 'review'].map((editor) => ({
      key: `editor-${theme}-${editor}`,
      width: 1440,
      theme,
      editor,
    })),
  ),
];
for (const job of jobs)
  test(`native ${job.key}`, async ({ page, context, browser }) => {
    const selectedWidth = job.width,
      batchTheme = job.theme;
    const source = await sourceFingerprint();
    const geometry: Record<string, unknown>[] = [],
      images: {
        id: string;
        label: string;
        theme: Theme;
        width: number;
        height: number;
        file: string;
        category: string;
      }[] = [];
    async function capture(
      subject: Page,
      id: string,
      label: string,
      selectedTheme: Theme,
      category: string,
    ) {
      const viewport = subject.viewportSize()!;
      const filename = `${category}-${id}-${selectedTheme}.png`;
      await subject.mouse.move(1, 1);
      await subject.screenshot({
        path: resolve(output, filename),
        fullPage: false,
        animations: 'disabled',
        scale: 'css',
      });
      images.push({ id, label, theme: selectedTheme, ...viewport, file: filename, category });
    }
    for (const width of [selectedWidth])
      for (const selectedTheme of [batchTheme]) {
        await page.setViewportSize({ width, height: 1000 });
        for (const item of job.view ? [job.view] : []) {
          const withDetail = item.section === 'tasks' && width >= 1280;
          const query: Record<string, string> = {
            ...('query' in item ? item.query : {}),
            ...(withDetail ? { task: seeded.taskId, occurrence: seeded.occurrenceId } : {}),
          };
          const app = await visit(page, item.section, selectedTheme, query);
          await expect(app.locator(item.ready).first()).toBeVisible();
          if (item.section === 'focus')
            await expect(app.locator('.todo-focus-history-item')).toHaveCount(3);
          if (item.section === 'notifications')
            await expect(
              app
                .locator('.todo-page-heading')
                .getByRole('button', { name: '全部标为已读', exact: true }),
            ).toBeEnabled();
          if (item.section === 'settings')
            await expect(app.getByLabel('显示时区', { exact: true })).toBeVisible();
          if (withDetail)
            await expect(
              app.getByRole('complementary', { name: '任务详情', exact: true }),
            ).toBeVisible();
          const rect = await app.boundingBox(),
            header = await app.locator('.todo-topbar').boundingBox(),
            heading = await app.locator('.todo-page-heading h1').boundingBox();
          const rail = page.locator('.workspace-main-menu[data-menu-id="to-doo"]');
          const railVisible = await rail.isVisible();
          const sidebar = app.locator(':scope > .todo-sidebar');
          const sidebarVisible = await sidebar.isVisible();
          closeTo(header!.height, 56, item.id + ': header height');
          closeTo(header!.y, 0, item.id + ': header top');
          closeTo(header!.x, railVisible ? 64 : 0, item.id + ': header left');
          if (railVisible)
            closeTo((await rail.boundingBox())!.width, 64, item.id + ': primary menu');
          if (sidebarVisible) {
            closeTo((await sidebar.boundingBox())!.width, 180, item.id + ': context width');
            closeTo((await sidebar.boundingBox())!.y, 56, item.id + ': context top');
          }
          const padding = width <= 1000 ? 16 : 24;
          closeTo(
            heading!.x,
            rect!.x + (sidebarVisible ? 180 : 0) + padding,
            item.id + ': title/content start',
          );
          closeTo(heading!.y, 56 + padding, item.id + ': title top');
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - innerWidth,
          );
          expect(overflow, item.id + ': outer horizontal overflow').toBeLessThanOrEqual(1);
          if (withDetail)
            closeTo(
              (await app
                .getByRole('complementary', { name: '任务详情', exact: true })
                .boundingBox())!.width,
              420,
              'detail width',
            );
          geometry.push({
            id: item.id,
            theme: selectedTheme,
            width,
            height: 1000,
            railVisible,
            sidebarVisible,
            header,
            heading,
            overflow,
            font: await app
              .locator('.todo-page-heading h1')
              .evaluate((element) => getComputedStyle(element).fontFamily),
          });
          if (width === 1440) await capture(page, item.id, item.label, selectedTheme, 'desktop');
          if (width === 390 && ['tasks', 'focus', 'habits'].includes(item.section)) {
            await page.setViewportSize({ width, height: 844 });
            if (item.section === 'focus') await openToDooFocusHistory(page);
            await capture(page, item.id, item.label, selectedTheme, 'phone');
            if (item.section === 'tasks') {
              await app.getByRole('button', { name: '整理项目的下一步', exact: true }).click();
              await expect(
                app.getByRole('complementary', { name: '任务详情', exact: true }),
              ).toBeVisible();
              await capture(page, 'task-detail', '手机任务详情', selectedTheme, 'phone');
            }
            await page.setViewportSize({ width, height: 1000 });
          }
        }
      }
    for (const selectedTheme of job.editor ? [batchTheme] : [])
      for (const editor of [job.editor!]) {
        const subject = await context.newPage();
        try {
          await subject.clock.install({ time: new Date(VISUAL_NOW) });
          await subject.setViewportSize({ width: 1440, height: 1000 });
          if (editor === 'task' || editor === 'outcome') {
            const app = await visit(subject, 'tasks', selectedTheme, {
              task: seeded.taskId,
              occurrence: seeded.occurrenceId,
            });
            const detail = app.getByRole('complementary', { name: '任务详情', exact: true });
            await expect(detail).toBeVisible();
            if (editor === 'task') {
              await detail
                .getByLabel('任务标题', { exact: true })
                .fill('整理项目的下一步：细化为可执行的步骤');
              await expect(
                detail.getByRole('button', { name: '保存任务', exact: true }),
              ).toBeVisible();
            } else {
              await expandToDooGroup(detail, '完成标准与成果');
              await detail.getByRole('button', { name: '创建成果笔记并关联', exact: true }).click();
              const dialog = subject.getByRole('dialog', { name: '创建成果笔记', exact: true });
              await dialog
                .getByLabel('成果正文（Markdown）', { exact: true })
                .fill('完成了核心整理，并明确了接下来的一步。');
            }
          } else {
            const section =
              editor === 'habit'
                ? 'habits'
                : editor === 'anniversary'
                  ? 'anniversaries'
                  : editor === 'schedule'
                    ? 'calendar'
                    : 'stats';
            const app = await visit(subject, section, selectedTheme);
            const label =
              editor === 'habit'
                ? '＋ 新建习惯'
                : editor === 'anniversary'
                  ? '＋ 新建纪念日'
                  : editor === 'schedule'
                    ? '＋ 时间安排'
                    : '＋ 写一篇复盘';
            const create = app.getByRole('button', { name: label, exact: true });
            await expect(create).toBeEnabled();
            await create.click();
            const dialog = subject.getByRole('dialog');
            await expect(dialog).toBeVisible();
            if (editor === 'habit') {
              await dialog.getByLabel('名称', { exact: true }).fill('每天读一点');
              await dialog.getByRole('spinbutton', { name: '目标数量', exact: true }).fill('20');
              await dialog.getByLabel('单位', { exact: true }).fill('页');
            }
            if (editor === 'anniversary')
              await dialog.getByLabel('名称', { exact: true }).fill('值得记住的一天');
            if (editor === 'schedule')
              await dialog.getByLabel('安排标题', { exact: true }).fill('安静的阅读时间');
            if (editor === 'review') {
              await dialog.getByLabel('名称', { exact: true }).fill('本周的收获与下一步');
              await dialog
                .getByLabel('复盘内容', { exact: true })
                .fill('持续阅读，减少分心。为重要的事留出完整时间。');
            }
          }
          await capture(
            subject,
            editor,
            {
              task: '任务编辑',
              habit: '习惯编辑',
              anniversary: '纪念日编辑',
              schedule: '时间安排',
              outcome: '成果笔记',
              review: '复盘编辑',
            }[editor]!,
            selectedTheme,
            'editor',
          );
        } finally {
          await subject.close();
        }
      }
    expect(await sourceFingerprint()).toEqual(source);
    await writeFile(
      resolve(output, `batch-${job.key}.json`),
      JSON.stringify({ datasetId: seeded.datasetId, source, geometry, images }, null, 2),
    );
  });

test('complete native screenshot index', async ({ browser }) => {
  const source = await sourceFingerprint();
  const paths = jobs.map((job) => resolve(output, `batch-${job.key}.json`));
  const results = await Promise.allSettled(
    paths.map(async (path) => JSON.parse(await readFile(path, 'utf8'))),
  );
  const batches = results
    .flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
    .filter(
      (batch) => batch.datasetId === seeded?.datasetId && batch.source.sha256 === source.sha256,
    );
  const geometry = batches.flatMap((batch) => batch.geometry),
    images = batches.flatMap((batch) => batch.images);
  await writeFile(
    resolve(output, 'status.json'),
    JSON.stringify(
      {
        status: batches.length === jobs.length ? 'checking' : 'failed',
        matchingBatches: batches.length,
        fixedTime: VISUAL_NOW,
        source,
      },
      null,
      2,
    ),
  );
  expect(geometry).toHaveLength(156);
  expect(images.filter((image) => image.category === 'desktop')).toHaveLength(26);
  expect(images.filter((image) => image.category === 'editor')).toHaveLength(12);
  expect(images.filter((image) => image.category === 'phone')).toHaveLength(8);
  const metadata = {
    status: 'passed',
    fixedTime: VISUAL_NOW,
    browser: browser.version(),
    source,
    datasetId: seeded.datasetId,
    fonts: execFileSync('fc-match', ['-f', '%{family} | %{file}\n', 'sans:lang=zh'], {
      encoding: 'utf8',
    }).trim(),
    geometry,
    images,
  };
  await writeFile(resolve(output, 'index.json'), JSON.stringify(metadata, null, 2) + '\n');
  const groups = ['desktop', 'editor', 'phone']
    .map(
      (category) =>
        `<section><h2>${{ desktop: '13个桌面视图', editor: '六类编辑界面', phone: '四个手机状态' }[category]}</h2><div class="grid">${images
          .filter((image) => image.category === category)
          .map(
            (image) =>
              `<figure><a href="${image.file}"><img src="${image.file}" loading="lazy" alt="${image.label}"></a><figcaption>${image.label} · ${image.theme} · ${image.width}×${image.height}</figcaption></figure>`,
          )
          .join('')}</div></section>`,
    )
    .join('');
  await writeFile(
    resolve(output, 'index.html'),
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>To Doo真实界面验收</title><style>body{font:14px/1.6 Arial,sans-serif;margin:24px;background:#f5f6f8;color:#272b3a}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:16px}figure{margin:0;background:white;border:1px solid #dfe3eb;border-radius:8px;overflow:hidden}img{display:block;width:100%;height:auto}figcaption{padding:8px 12px}h2{margin:32px 0 16px}@media(max-width:600px){.grid{grid-template-columns:1fr}body{margin:16px}}</style><h1>To Doo真实浏览器界面验收</h1><p>固定业务时间 ${VISUAL_NOW} · ${browser.version()} · 6个宽度 × 深浅色 · 156次页面布局检查。图片来自同一隔离测试数据；几何容差1个CSS像素。</p>${groups}</html>`,
  );
  await writeFile(
    resolve(output, 'index.md'),
    '# To Doo 真实浏览器验收\n\n固定业务时间：' +
      VISUAL_NOW +
      '。浏览器：' +
      browser.version() +
      '。156次页面布局检查；桌面26张、编辑12张、手机8张。\n\n[浏览完整图册](index.html) · [几何、环境与来源](index.json)\n\n' +
      images
        .map(
          (image) =>
            `- [${image.label} · ${image.theme} · ${image.width}×${image.height}](${image.file})`,
        )
        .join('\n') +
      '\n',
  );
  await writeFile(
    resolve(output, 'status.json'),
    JSON.stringify(
      {
        status: 'passed',
        fixedTime: VISUAL_NOW,
        source,
        index: relative(output, resolve(output, 'index.html')),
      },
      null,
      2,
    ),
  );
});
