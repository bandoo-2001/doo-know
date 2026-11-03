import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'docs/design/to-doo/cohesion-2026-11-01');
const pairs = [
  ['01-overview', '目标总览'],
  ['02-calendar-month', '月日历'],
  ['03-calendar-week', '周日历'],
  ['04-timeline', '时间线'],
  ['05-matrix', '四象限'],
  ['06-focus', '专注'],
  ['07-anniversaries', '纪念日'],
  ['08-statistics', '统计与复盘'],
  ['09-notifications', '通知中心'],
  ['10-settings', '设置'],
  ['11-recovery', '数据与恢复'],
] as const;
type Capture = {
  id: string;
  label: string;
  file: string;
  width: number;
  height: number;
  theme: string;
};
type Pair = {
  id: string;
  label: string;
  before: Capture;
  after: Capture;
  beforeURL: string;
  afterURL: string;
};
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );
async function loadPair(device: string, id: string, label: string): Promise<Pair> {
  const captures: Capture[] = [];
  const urls: string[] = [];
  const clocks: string[] = [];
  for (const phase of ['before', 'after']) {
    const record = JSON.parse(
      await readFile(resolve(output, phase, device + '-' + id + '.json'), 'utf8'),
    );
    const capture = record.screenshots[0] as Capture;
    clocks.push(record.fixedTime);
    captures.push(capture);
    urls.push(
      'data:image/png;base64,' +
        (await readFile(resolve(output, phase, capture.file))).toString('base64'),
    );
  }
  if (
    clocks[0] !== clocks[1] ||
    ['width', 'height', 'theme', 'id'].some(
      (key) => captures[0][key as keyof Capture] !== captures[1][key as keyof Capture],
    )
  )
    throw Error('Inconsistent before/after scene: ' + device + ' ' + id);
  return {
    id,
    label,
    before: captures[0],
    after: captures[1],
    beforeURL: urls[0],
    afterURL: urls[1],
  };
}
function comparisonDocument(title: string, rows: Pair[]) {
  const width = rows[0].before.width;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}body{margin:0;width:${width * 2 + 60}px;background:#f3f5f8;color:#272b3a;font-family:"Noto Sans CJK SC","Microsoft YaHei",sans-serif}
    header{padding:22px 20px 18px;display:flex;align-items:baseline;gap:18px}h1{margin:0;font-size:24px;font-weight:600}header span{font-size:14px;color:#657084}
    section{padding:0 20px 24px}h2{font-size:17px;font-weight:550;margin:0 0 10px}.pair{display:grid;grid-template-columns:repeat(2,${width}px);gap:20px}
    figure{margin:0;width:${width}px;box-shadow:0 2px 10px #26344812;border-radius:8px;overflow:hidden;background:white}
    figcaption{height:34px;display:flex;align-items:center;padding:0 14px;font-size:14px;color:#657084;background:#e9edf3}.after figcaption{color:#3453b0;background:#e7edff}
    img{display:block;width:${width}px;height:auto}
  </style></head><body><header><h1>${escape(title)}</h1><span>同一数据 · 同一尺寸 · 左改前 / 右改后</span></header>${rows.map((row) => `<section><h2>${escape(row.label)}</h2><div class="pair"><figure><figcaption>改前</figcaption><img src="${row.beforeURL}" alt="${escape(row.label)}改前"></figure><figure class="after"><figcaption>改后</figcaption><img src="${row.afterURL}" alt="${escape(row.label)}改后"></figure></div></section>`).join('')}</body></html>`;
}

await mkdir(resolve(output, 'comparisons'), { recursive: true });
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  ),
);
const libraries = resolve(root, '.local/browser-deps/root/usr/lib/x86_64-linux-gnu');
if (existsSync(libraries))
  env.LD_LIBRARY_PATH = libraries + (env.LD_LIBRARY_PATH ? delimiter + env.LD_LIBRARY_PATH : '');
const browser = await chromium.launch({ headless: true, env });
const metadata: { file: string; title: string; pages: string[] }[] = [];
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const captured = new Map<string, Pair>();
  async function render(file: string, title: string, rows: Pair[]) {
    await page.setViewportSize({ width: rows[0].before.width * 2 + 60, height: 1100 });
    await page.setContent(comparisonDocument(title, rows));
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all([...document.images].map((image) => image.decode()));
    });
    await page.screenshot({ path: resolve(output, file), fullPage: true, animations: 'disabled' });
    metadata.push({ file, title, pages: rows.map((row) => row.id) });
  }
  for (const device of ['desktop', 'phone'])
    for (const [id, label] of pairs) {
      const pair = await loadPair(device, id, label);
      captured.set(device + '-' + id, pair);
      await render(
        'comparisons/' + device + '-' + id + '.png',
        label + (device === 'phone' ? ' · 手机深色' : ''),
        [pair],
      );
    }
  for (const [file, title, ids] of [
    ['01-planning.png', '目标与执行', ['01-overview', '05-matrix']],
    ['02-calendar.png', '日历与时间线', ['02-calendar-month', '03-calendar-week', '04-timeline']],
    ['03-life.png', '专注与纪念日', ['06-focus', '07-anniversaries']],
    [
      '04-management.png',
      '统计、通知与设置',
      ['08-statistics', '09-notifications', '10-settings', '11-recovery'],
    ],
  ] as const)
    await render(
      file,
      title,
      ids.map((id) => captured.get('desktop-' + id)!),
    );
  await render(
    '05-mobile.png',
    '手机深色界面',
    ['02-calendar-month', '06-focus', '09-notifications', '10-settings'].map(
      (id) => captured.get('phone-' + id)!,
    ),
  );
  await writeFile(
    resolve(output, 'comparisons.json'),
    JSON.stringify(
      {
        method: 'Native browser screenshots arranged as HTML; original UI pixels unchanged',
        images: metadata,
      },
      null,
      2,
    ),
  );
  await writeFile(
    resolve(output, 'index.html'),
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>ToDoo 改前改后对比</title><style>body{font:15px sans-serif;background:#f3f5f8;margin:24px;color:#272b3a}section{margin:24px 0}img{width:100%;display:block;border-radius:8px}a{color:#4566c6}</style><h1>ToDoo 改前改后对比</h1><p>左改前 / 右改后；相同数据、时间、主题与窗口尺寸。</p>${metadata
      .filter((item) => item.file.startsWith('comparisons/'))
      .map(
        (item) =>
          `<section><h2>${escape(item.title)}</h2><a href="${escape(item.file)}"><img loading="lazy" src="${escape(item.file)}" alt="${escape(item.title)}"></a></section>`,
      )
      .join('')}</html>`,
  );
} finally {
  await browser.close();
}
process.stdout.write(`Created ${metadata.length} actual before/after comparison images.\n`);
