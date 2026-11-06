#!/usr/bin/env node
/** Build the offline concept gallery. No packages or local server required. */
import { readFile, writeFile, access } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const strict = process.argv.includes('--require-complete');
const [plan, prompts] = await Promise.all([
  readFile(join(directory, 'generation-plan.json'), 'utf8').then(JSON.parse),
  readFile(join(directory, 'generation-prompts.json'), 'utf8').then(JSON.parse),
]);
const escape = (value) => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const exists = async (file) => access(join(directory, file)).then(() => true, () => false);
const categories = [
  { id: 'pages', title: '主页面', description: '目标、任务、时间、生活记录与设置的完整工作区。' },
  { id: 'empty', title: '空状态', description: '附加筛选无结果：保留范围与筛选上下文，提供清除筛选和查看所有任务。' },
  { id: 'windows', title: '操作窗口', description: '在对应工作区内完成创建、记录、复盘与成果关联。' },
];
const notes = {
  '01': '目标与今日行动放在同一工作区，突出下一步。',
  '02': '列表使用弹性主区域；选中任务后才展开详情。',
  '03': '按状态分组的看板，完整使用可用宽度。',
  '04': '象限分类与任务优先级独立呈现。',
  '05': '月视图结合安排、截止与纪念日。',
  '06': '周视图按真实时间与时长排列安排。',
  '07': '固定任务列与可横向滚动的日期区域。',
  '08': '计时项目与历史记录筛选分别设置。',
  '09': '展示习惯、今日记录与持续情况。',
  '10': '纪念日与倒计时共用清晰的日期表达。',
  '11': '在统计上下文中查看记录与复盘。',
  '12': '集中查看提醒及其关联事项。',
  '13': '个人偏好按用途组织。',
  '14': '提醒与连接配置明确展示当前状态。',
  '15': '数据导入、导出与恢复入口集中管理。',
  '16': '管理清单、目标与标签的基础结构。',
  '17': '附加筛选无结果，与全库无任务、时间范围为空区分。',
  '18': '新建任务并填写任务所需的信息。',
  '19': '配置习惯名称、频率与记录方式。',
  '20': '对习惯进行记录或更正。',
  '21': '为事项添加日期、开始时间与时长。',
  '22': '农历纪念日保留日期与提醒语义。',
  '23': '保存复盘内容及当时的统计快照。',
  '24': '预览 Markdown 成果笔记并关联任务。',
  '25': '目标以期望结果与完成标准表达。',
  '26': '普通清单保持简洁的创建流程。',
  '27': '专注项目的创建与开始计时分别操作。',
  '28': '使用名称与颜色创建分类标签。',
};
const entries = [
  ...plan.scenes.map((entry) => ({ ...entry, promptFile: 'generation-plan.json' })),
  ...prompts.assets.map((entry) => ({ ...entry, promptFile: 'generation-prompts.json' })),
].map((entry) => {
  if (basename(entry.file) !== entry.file || !/^\d{2}-[a-z0-9-]+\.png$/.test(entry.file)) throw new Error(`Unexpected asset filename: ${entry.file}`);
  const number = Number(entry.file.slice(0, 2));
  return { ...entry, number, anchor: entry.file.slice(0, -4), category: number <= 16 ? 'pages' : number === 17 ? 'empty' : 'windows' };
}).sort((left, right) => left.number - right.number);
if (entries.length !== 28 || entries.some((entry, index) => entry.number !== index + 1)) {
  throw new Error('The gallery requires exactly one numbered concept for every number from 01 to 28.');
}
for (const entry of entries) {
  entry.ready = await exists(entry.file);
  entry.recordFile = `${entry.anchor}.json`;
  entry.hasRecord = await exists(entry.recordFile);
  if (entry.ready) {
    const buffer = await readFile(join(directory, entry.file));
    if (buffer.length < 24 || buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error(`Invalid PNG: ${entry.file}`);
    entry.width = buffer.readUInt32BE(16);
    entry.height = buffer.readUInt32BE(20);
  }
}
const ready = entries.filter((entry) => entry.ready).length;
const pending = entries.filter((entry) => !entry.ready);
if (strict && pending.length) throw new Error(`Missing ${pending.length} concept image(s): ${pending.map((entry) => entry.file).join(', ')}`);
const card = (entry) => {
  const title = `${String(entry.number).padStart(2, '0')} · ${entry.title}`;
  const image = entry.ready
    ? `<a class="preview" href="./${escape(entry.file)}" target="_blank" rel="noopener" aria-label="打开${escape(title)}原图"><img src="./${escape(entry.file)}" alt="${escape(entry.title)}桌面浅色概念图" width="${entry.width}" height="${entry.height}" loading="lazy" decoding="async"></a>`
    : '<div class="preview pending" role="img" aria-label="概念图生成中"><span class="pending-icon" aria-hidden="true">◌</span><span>生成中</span><small>图片完成后重新运行生成器</small></div>';
  return `<article class="card" id="${escape(entry.anchor)}" data-category="${entry.category}" data-search="${escape(`${title} ${entry.file} ${notes[String(entry.number).padStart(2, '0')]}`.toLowerCase())}">
${image}
<div class="card-body"><div class="card-heading"><h3>${escape(title)}</h3><span class="badge${entry.ready ? '' : ' badge-pending'}">${entry.ready ? '已生成' : '生成中'}</span></div><p>${escape(notes[String(entry.number).padStart(2, '0')])}</p><div class="card-links">${entry.ready ? `<a href="./${escape(entry.file)}" target="_blank" rel="noopener">查看原图 ↗</a><span class="dimensions">${entry.width} × ${entry.height}</span>` : '<span>原图生成中</span>'}<a href="./${entry.promptFile}" target="_blank" rel="noopener">提示词清单 ↗</a>${entry.hasRecord ? `<a href="./${entry.recordFile}" target="_blank" rel="noopener">生成记录 ↗</a>` : ''}</div></div>
</article>`;
};
const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>ToDoo · 全套布局概念图</title>
<style>
:root{color-scheme:light;--ink:#263544;--muted:#627182;--line:#dfe5ec;--paper:#fff;--canvas:#f4f6f9;--blue:#3e6c9c;--pale:#edf3fa;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC","Microsoft YaHei",sans-serif}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--canvas);color:var(--ink);font-size:15px;line-height:1.65}a{color:var(--blue);text-decoration:none}a:hover{text-decoration:underline}button,input{font:inherit}button,a,input{touch-action:manipulation}button:focus-visible,a:focus-visible,input:focus-visible{outline:3px solid #93b7de;outline-offset:3px}button{cursor:pointer}.shell{max-width:1660px;margin:auto;padding:40px 32px 28px}.eyebrow{margin:0 0 8px;color:var(--blue);font-size:12px;font-weight:650;letter-spacing:.1em}.masthead{display:flex;justify-content:space-between;align-items:flex-start;gap:24px}.masthead h1{margin:0;font-size:clamp(26px,3vw,38px);font-weight:650;line-height:1.25;letter-spacing:-.035em}.intro{margin:12px 0 0;max-width:880px;color:var(--muted)}.edition{padding:7px 12px;border:1px solid var(--line);border-radius:7px;background:var(--paper);white-space:nowrap;color:var(--muted);font-size:13px}.principles{display:flex;gap:10px;flex-wrap:wrap;margin:20px 0}.principles span{font-size:13px;background:#eaf0f5;color:#53667a;padding:3px 10px;border-radius:5px}.toolbar{display:flex;align-items:center;justify-content:space-between;gap:18px;flex-wrap:wrap;margin-top:24px;padding:15px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.filters{display:flex;gap:7px;flex-wrap:wrap}.filters button{background:transparent;color:var(--muted);border:1px solid transparent;border-radius:6px;padding:6px 12px}.filters button[aria-pressed="true"]{color:#2c5989;background:#e5eef8;border-color:#cbdcec}.search{display:flex;align-items:center;gap:10px;color:var(--muted);font-size:13px;white-space:nowrap}.search input{width:245px;border:1px solid var(--line);background:var(--paper);border-radius:6px;padding:7px 10px;color:var(--ink)}.index{margin-top:16px;background:var(--paper);border:1px solid var(--line);border-radius:8px;padding:10px 14px}.index summary{cursor:pointer;font-size:13px;color:var(--muted)}.index nav{display:flex;flex-wrap:wrap;align-content:flex-start;gap:5px 14px;max-height:160px;overflow:auto;margin-top:10px;padding:3px 2px 8px;font-size:12px}.index nav a{padding:2px 0}.index nav a[hidden]{display:none}.results{display:flex;justify-content:space-between;gap:12px;color:var(--muted);font-size:13px;margin:20px 0}.results p{margin:0}.group{margin:26px 0 38px}.group-header{margin-bottom:14px}.group h2{font-size:20px;margin:0 0 3px;font-weight:620}.group-description{margin:0;color:var(--muted);font-size:13px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}.card{background:var(--paper);border:1px solid var(--line);border-radius:9px;overflow:hidden;scroll-margin-top:22px;box-shadow:0 2px 8px #243a4e04}.card:target{outline:3px solid #9bb9d8;outline-offset:4px}.preview{display:flex;aspect-ratio:1568/1003;align-items:center;justify-content:center;overflow:hidden;border-bottom:1px solid var(--line);background:#edf0f4}.preview img{display:block;width:100%;height:100%;object-fit:contain}.preview:hover img{filter:brightness(.98)}.pending{flex-direction:column;gap:3px;color:#7b8c9e}.pending-icon{font-size:30px;line-height:1.4}.pending small{font-size:12px;color:#8b98a6}.card-body{padding:15px 17px 16px}.card-heading{display:flex;justify-content:space-between;align-items:center;gap:8px}.card h3{font-size:15px;margin:0;font-weight:620}.card-body p{font-size:13px;margin:7px 0 12px;color:var(--muted)}.badge{flex-shrink:0;font-size:11px;background:#edf3f9;color:#58779a;padding:1px 6px;border-radius:4px}.badge-pending{background:#f1f2f4;color:#8994a0}.card-links{display:flex;align-items:center;flex-wrap:wrap;gap:5px 13px;font-size:12px;color:#8b97a3}.dimensions{font-variant-numeric:tabular-nums}#no-results{padding:40px 20px;text-align:center;background:var(--paper);border:1px solid var(--line);border-radius:9px;color:var(--muted)}[hidden]{display:none!important}.footer{border-top:1px solid var(--line);padding-top:18px;color:var(--muted);font-size:12px}.footer p{margin:5px 0}.footer a{margin-right:14px}@media(min-width:1400px){.grid{grid-template-columns:repeat(3,minmax(0,1fr))}}@media(max-width:700px){.shell{padding:24px 16px}.masthead{display:block}.edition{display:inline-block;margin-top:16px;font-size:12px}.toolbar{gap:12px}.search{width:100%}.search input{width:auto;flex:1;min-width:0}.filters{gap:3px}.filters button{padding:6px 9px}.grid{grid-template-columns:minmax(0,1fr);gap:16px}.results{display:block}.results p+p{margin-top:3px}.group{margin-bottom:30px}.card-body{padding:13px 14px}.index nav{max-height:160px}.intro{font-size:14px}}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}@media print{body{background:white}.toolbar,.index{display:none}.shell{max-width:none;padding:0}.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.card{break-inside:avoid;box-shadow:none}.group{break-before:auto}.card-links{display:none}}
</style>
</head>
<body>
<main class="shell">
<header class="masthead"><div><p class="eyebrow">DOOKNOW / TO DOO · DESIGN STUDY</p><h1>让工作区回到事情本身</h1><p class="intro">ToDoo 桌面浅色布局概念图。用统一导航连接目标、任务与记录，让内容获得足够空间，并在需要时展开详情。</p></div><span class="edition">2026.11.04 · 28 张概念图</span></header>
<div class="principles" aria-label="共同布局原则"><span>统一导航</span><span>弹性内容</span><span>按需详情</span><span>区分空状态</span></div>
<div class="toolbar"><div class="filters" role="group" aria-label="筛选图集分类"><button type="button" data-filter="all" aria-pressed="true">全部 28</button>${categories.map((category) => `<button type="button" data-filter="${category.id}" aria-pressed="false">${category.title} ${entries.filter((entry) => entry.category === category.id).length}</button>`).join('')}</div><label class="search">查找图稿<input id="search" type="search" placeholder="标题、编号或文件名" autocomplete="off"></label></div>
<details class="index"><summary>按编号快速跳转 · 01—28</summary><nav aria-label="概念图目录">${entries.map((entry) => `<a href="#${entry.anchor}" data-category="${entry.category}" data-number="${entry.number}">${String(entry.number).padStart(2, '0')} ${escape(entry.title)}</a>`).join('')}</nav></details>
<div class="results"><p id="result-count" aria-live="polite">显示 28 张 · 已生成 ${ready} 张${pending.length ? ` · 生成中 ${pending.length} 张` : ''}</p><p>点击预览打开原图 · 示例数据不对应真实账号</p></div>
${categories.map((category) => `<section class="group" data-group="${category.id}" aria-labelledby="heading-${category.id}"><div class="group-header"><h2 id="heading-${category.id}">${category.title}</h2><p class="group-description">${category.description}</p></div><div class="grid">${entries.filter((entry) => entry.category === category.id).map(card).join('\n')}</div></section>`).join('\n')}
<p id="no-results" hidden>没有匹配的图稿。试试其他名称，或切换到“全部”。</p>
<footer class="footer"><p>这是本地静态文档附件；尚未部署为产品 UI。图中的原图风格不是唯一实现约束，落地仍需验证真实响应式布局与交互。</p><p>品牌 / 工作空间菜单保留返回目标总览与知识库的入口。空状态分别处理全库无任务、时间范围为空及附加筛选无结果；第 17 张展示附加筛选无结果。</p><p><a href="./README.md">图稿说明</a><a href="./generation-plan.json">后续场景提示词</a><a href="./generation-prompts.json">基础图稿提示词</a><a href="./build-gallery.mjs">图集生成器</a></p></footer>
</main>
<script>
(() => {
  const buttons = [...document.querySelectorAll('[data-filter]')];
  const cards = [...document.querySelectorAll('.card')];
  const groups = [...document.querySelectorAll('[data-group]')];
  const links = [...document.querySelectorAll('.index nav a')];
  const search = document.querySelector('#search');
  let category = 'all';
  function update() {
    const query = search.value.trim().toLowerCase();
    let visible = 0;
    cards.forEach((card, index) => {
      const match = (category === 'all' || card.dataset.category === category) && (!query || card.dataset.search.includes(query));
      card.hidden = !match;
      links[index].hidden = !match;
      if (match) visible++;
    });
    groups.forEach((group) => { group.hidden = !group.querySelector('.card:not([hidden])'); });
    buttons.forEach((button) => { button.setAttribute('aria-pressed', String(button.dataset.filter === category)); });
    document.querySelector('#no-results').hidden = visible !== 0;
    document.querySelector('#result-count').textContent = '显示 ' + visible + ' / 28 张 · 已生成 ${ready} 张${pending.length ? ` · 生成中 ${pending.length} 张` : ''}';
  }
  buttons.forEach((button) => button.addEventListener('click', () => { category = button.dataset.filter; update(); }));
  search.addEventListener('input', update);
  function revealHash() {
    const target = document.getElementById(location.hash.slice(1));
    if (target?.classList.contains('card') && target.hidden) { category = 'all'; search.value = ''; update(); target.scrollIntoView(); }
  }
  window.addEventListener('hashchange', revealHash);
  update();
  revealHash();
})();
</script>
</body>
</html>
`;
await writeFile(join(directory, 'index.html'), html);
console.log(`Built index.html: ${entries.length} concepts (${ready} generated, ${pending.length} pending).`);
