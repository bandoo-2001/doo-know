import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve('docs/design/to-doo/audit-fixes-2026-11-03');
const names: Record<string, string> = {
  overview: '目标总览',
  tasks: '任务列表',
  board: '看板',
  matrix: '四象限',
  'calendar-month': '月日历',
  'calendar-week': '周日历',
  timeline: '时间线',
  focus: '专注',
  habits: '习惯',
  anniversaries: '纪念日',
  stats: '统计与复盘',
  notifications: '通知中心',
  settings: '偏好设置',
  'settings-connections': '提醒与连接',
  'settings-data': '数据与恢复',
  'task-detail': '任务详情',
  'task-dialog': '新建任务',
  'habit-dialog': '新建习惯',
  'schedule-dialog': '时间安排',
  'anniversary-dialog': '新建纪念日',
  'review-dialog': '写复盘',
  'outcome-dialog': '成果笔记',
};
type Capture = {
  id: string;
  file: string;
  device: string;
  width: number;
  height: number;
  theme: string;
};
type RecordFile = { fixedTime: string; head: string; captures: Capture[] };
const entities: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const escape = (text: string) => text.replace(/[&<>"']/g, (c) => entities[c]!);
const files = (await readdir(resolve(root, 'before')))
  .filter((file) => file.endsWith('.json'))
  .sort();
const pairs: {
  id: string;
  label: string;
  before: Capture;
  after: Capture;
  beforeHead: string;
  afterHead: string;
  fixedTime: string;
}[] = [];
for (const file of files) {
  const before = JSON.parse(await readFile(resolve(root, 'before', file), 'utf8')) as RecordFile;
  const after = JSON.parse(await readFile(resolve(root, 'after', file), 'utf8')) as RecordFile;
  const a = before.captures[0],
    b = after.captures[0];
  if (!a || !b) throw Error('Missing capture metadata: ' + file);
  if (
    before.fixedTime !== after.fixedTime ||
    ['width', 'height', 'theme', 'id', 'device'].some(
      (key) => a[key as keyof Capture] !== b[key as keyof Capture],
    )
  )
    throw Error('Inconsistent before/after capture: ' + file);
  pairs.push({
    id: `${a.device}-${a.id}`,
    label: (a.device === 'phone' ? '手机' : '桌面') + ' · ' + (names[a.id] || a.id),
    before: a,
    after: b,
    beforeHead: before.head,
    afterHead: after.head,
    fixedTime: before.fixedTime,
  });
}
const extras = (await readdir(resolve(root, 'after')))
  .filter((file) => /^(desktop-dark|phone-light)-.*\.png$/.test(file))
  .sort();
const image = (phase: string, capture: Capture) =>
  `<a href="${phase}/${encodeURIComponent(capture.file)}" target="_blank" rel="noopener"><img src="${phase}/${encodeURIComponent(capture.file)}" alt="${phase === 'before' ? '改前' : '改后'} ${escape(names[capture.id] || capture.id)}" loading="lazy" width="${capture.width}" height="${capture.height}"></a>`;
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ToDoo 全页修复对比</title><style>
*{box-sizing:border-box}body{margin:0;background:#f5f6f8;color:#272b3a;font:14px/1.65 system-ui,"Noto Sans CJK SC",sans-serif}header{padding:28px 24px;background:white;border-bottom:1px solid #e6e9f1}h1{margin:0 0 8px;font-size:25px}p{margin:0;color:#657084}nav{padding:16px 24px;display:flex;gap:8px;flex-wrap:wrap;position:sticky;top:0;background:#f5f6f8f5;z-index:1;border-bottom:1px solid #e6e9f1}nav a{padding:5px 10px;border:1px solid #e6e9f1;border-radius:6px;background:#fff;color:#4566c6;text-decoration:none}main{padding:0 24px 40px}.scene{scroll-margin-top:150px;margin:28px 0}.scene h2{font-size:18px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:16px;max-width:1600px}.scene[data-device="phone"] .pair{max-width:900px}figure{margin:0;background:white;border:1px solid #e6e9f1;border-radius:8px;overflow:hidden}figcaption{padding:8px 12px;background:#edf1ff;color:#4566c6}img{display:block;width:100%;height:auto}details{margin-top:32px}summary{cursor:pointer;font-size:18px;font-weight:600}.extras{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;margin-top:16px}.extras a{color:#4566c6}.extras img{max-height:500px;object-fit:contain;background:white}small{color:#657084}@media(max-width:640px){header,nav{padding:16px}main{padding:0 12px 24px}.pair{grid-template-columns:1fr}.scene{scroll-margin-top:210px}}
</style></head><body><header><h1>ToDoo 全页修复对比</h1><p>${pairs.length} 组同一数据、同一时间、同一尺寸的真实截图；左侧改前，右侧改后。点击图片查看原尺寸。</p><small>固定业务时间 ${escape(pairs[0]?.fixedTime || '')}；另附桌面深色与手机浅色检查。</small></header><nav>${pairs.map((pair) => `<a href="#${escape(pair.id)}">${escape(pair.label)}</a>`).join('')}</nav><main>${pairs.map((pair) => `<section class="scene" id="${escape(pair.id)}" data-device="${escape(pair.before.device)}"><h2>${escape(pair.label)}</h2><div class="pair"><figure><figcaption>改前 · ${escape(pair.beforeHead.slice(0, 7))}</figcaption>${image('before', pair.before)}</figure><figure><figcaption>改后 · ${escape(pair.afterHead.slice(0, 7))}</figcaption>${image('after', pair.after)}</figure></div></section>`).join('')}<details><summary>补充主题检查：${extras.length} 张</summary><div class="extras">${extras.map((file) => `<a href="after/${encodeURIComponent(file)}" target="_blank" rel="noopener"><img src="after/${encodeURIComponent(file)}" alt="${escape(file)}" loading="lazy">${escape(file)}</a>`).join('')}</div></details></main></body></html>`;
await writeFile(resolve(root, 'index.html'), html);
await writeFile(
  resolve(root, 'comparisons.json'),
  JSON.stringify({ pairs, extras }, null, 2) + '\n',
);
process.stdout.write(
  `Created ${pairs.length} comparisons and ${extras.length} extra theme captures in ${root}\n`,
);
