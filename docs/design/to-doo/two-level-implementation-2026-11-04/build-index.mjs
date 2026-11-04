import { readFile, writeFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = dirname(fileURLToPath(import.meta.url));
const plan = JSON.parse(
  await readFile(
    join(root, '../layout-redesign-two-level-2026-11-04/generation-plan.json'),
    'utf8',
  ),
);
const metadata = (await readdir(join(root, 'screenshots'))).filter((f) => f.endsWith('.json'));
const records = await Promise.all(
  metadata.map(async (f) => JSON.parse(await readFile(join(root, 'screenshots', f), 'utf8'))),
);
if (
  records.length !== 84 ||
  records.some((record) => !record.source?.sha256) ||
  new Set(records.map((record) => record.source.sha256)).size !== 1
)
  throw Error('Expected 84 real captures from one verified application source tree');
for (const width of [1440, 390, 320])
  for (const scene of plan.scenes) {
    const record = records.find((r) => r.scene === scene.id && r.width === width);
    if (!record) throw Error(`Missing real screenshot: ${width} ${scene.id}`);
    const bytes = await readFile(join(root, 'screenshots', record.file));
    if (createHash('sha256').update(bytes).digest('hex') !== record.sha256)
      throw Error('Hash mismatch: ' + record.file);
  }
const escape = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ToDoo 两级菜单真实页面验收</title><style>
*{box-sizing:border-box}body{margin:0;background:#f5f7fb;color:#263147;font:15px/1.6 system-ui,sans-serif}header,main{max-width:1500px;margin:auto;padding:24px}h1{font-size:26px;margin:0}p{color:#64718a}nav{position:sticky;top:0;z-index:1;background:#fff;padding:12px 24px;border-block:1px solid #dfe5ef;display:flex;gap:12px;align-items:center;flex-wrap:wrap}button,input{padding:8px 14px;border:1px solid #ccd6e8;border-radius:7px;background:white;color:inherit;font:inherit}button[aria-pressed=true]{background:#4566c6;color:white}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px}article{border:1px solid #dfe5ef;border-radius:10px;background:white;overflow:hidden}article[hidden]{display:none}article img{width:100%;height:260px;object-fit:contain;background:#ecf0f7}article div{padding:14px}h2{font-size:16px;margin:0}a{color:#4566c6}small{color:#64718a}@media(max-width:1100px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:640px){.grid{grid-template-columns:1fr}header,main{padding:16px}nav{padding:12px}input{width:100%}}
</style><header><h1>ToDoo 两级菜单 · 真实页面与交互验收</h1><p>28 个场景 × 1440 / 390 / 320px。截图来自隔离数据库中的真实 Vue 页面，含操作窗口；设计图仅作为对照。业务时钟固定为 2026-10-30T09:00:00Z。</p><a href="http://100.93.35.65:5180/?view=apps&amp;app=to-doo&amp;appSection=tasks&amp;taskFilter=upcoming">打开可操作 ToDoo</a> · <a href="README.md">实施说明与验证记录</a> · <a href="../layout-redesign-two-level-2026-11-04/index.html">已确认设计稿</a></header><nav aria-label="筛选实际截图">${[1440, 390, 320].map((w) => `<button data-width="${w}" aria-pressed="${w === 1440}">${w}px</button>`).join('')}<input aria-label="搜索场景" placeholder="搜索任务、农历、设置…"><span id="count"></span></nav><main class="grid">${plan.scenes
  .flatMap((scene) =>
    [1440, 390, 320].map((width) => {
      const r = records.find((r) => r.scene === scene.id && r.width === width);
      return `<article data-width="${width}" data-title="${escape(scene.title + ' ' + scene.id)}" ${width !== 1440 ? 'hidden' : ''}><a href="screenshots/${r.file}"><img loading="lazy" src="screenshots/${r.file}" alt="${escape(scene.title)} ${width}px真实页面"></a><div><h2>${escape(scene.id.slice(0, 2))} · ${escape(scene.title)}</h2><small>${width}px · ${r.operation ? escape(r.operation) : '主页面'}</small><p><a href="screenshots/${r.file}">实际截图</a> · <a href="../layout-redesign-two-level-2026-11-04/${scene.file}">设计稿</a> · <a href="screenshots/${r.file.replace('.png', '.json')}">验证记录</a></p></div></article>`;
    }),
  )
  .join(
    '',
  )}</main><script>let width='1440';function update(){const q=document.querySelector('input').value.toLowerCase();let count=0;document.querySelectorAll('article').forEach(el=>{el.hidden=el.dataset.width!==width||!el.dataset.title.toLowerCase().includes(q);if(!el.hidden)count++});document.querySelector('#count').textContent=count+' 个场景'}document.querySelectorAll('button').forEach(b=>b.onclick=()=>{width=b.dataset.width;document.querySelectorAll('button').forEach(a=>a.setAttribute('aria-pressed',String(a===b)));update()});document.querySelector('input').oninput=update;update()</script></html>`;
await writeFile(join(root, 'index.html'), html);
await writeFile(
  join(root, 'captures.json'),
  JSON.stringify(
    records.sort((a, b) => a.width - b.width || a.scene.localeCompare(b.scene)),
    null,
    2,
  ) + '\n',
);
console.log(`Validated ${records.length} real screenshots and wrote index.html`);
