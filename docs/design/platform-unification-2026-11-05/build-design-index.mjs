import { readFile, writeFile, readdir, rename } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = dirname(fileURLToPath(import.meta.url));
const writeAtomic = async (path, value) => { const temporary = path + '.' + process.pid + '.tmp'; await writeFile(temporary, value); await rename(temporary, path); };
const read = async (path) => JSON.parse(await readFile(join(root, path), 'utf8'));
const optional = async (path) => { try { return await read(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const sha = (value) => createHash('sha256').update(value).digest('hex');
const plans = await Promise.all(['workspace', 'management-public'].map((name) => read(`design/${name}-asset-plan.json`)));
const inventory = await read('coverage-index.json');
const records = inventory.records;
const assets = plans.flatMap((p) => p.assets);
const assetsById = new Map(assets.map((a) => [a.id, a]));
const mappings = plans.flatMap((p) => p.mapping ?? []);
const states = plans.flatMap((p) => p.stateCoverage ?? []);
const responsive = plans.flatMap((p) => p.responsiveMappings ?? []);
const problems = [];
if (assetsById.size !== assets.length) problems.push('Duplicate design asset IDs');

function resolveReference(mapping, seen = new Set()) {
  if (!mapping?.assetId) return null;
  if (!mapping.assetId.startsWith('@source:')) return mapping;
  const source = mapping.assetId.slice(8);
  if (seen.has(source)) throw Error(`Circular shared design: ${source}`);
  seen.add(source);
  const target = mappings.find((m) => m.sourceId === source && !m.assetId?.startsWith('@source:') && m.coverage !== 'responsive')
    ?? mappings.find((m) => m.sourceId === source);
  if (!target) { problems.push(`Unresolved shared source ${source}`); return null; }
  return resolveReference({ ...mapping, assetId: target.assetId, panel: mapping.panel === '@canonical' ? target.panel : mapping.panel }, seen);
}
function validateReference(mapping, location) {
  const ref = resolveReference(mapping);
  if (!ref) return;
  const asset = assetsById.get(ref.assetId);
  if (!asset) { problems.push(`${location}: missing asset ${ref.assetId}`); return; }
  if (ref.panel && !['@canonical', '*'].includes(ref.panel) && !asset.panels?.some((p) => p.label === ref.panel))
    problems.push(`${location}: missing panel ${ref.assetId}/${ref.panel}`);
}
for (const m of mappings) {
  validateReference(m, m.sourceId);
  if (m.responsiveCoverage?.assetId) validateReference(m.responsiveCoverage, `${m.sourceId} responsive`);
  for (const part of m.visualParts ?? []) validateReference(part, `${m.sourceId} component-part`);
}
for (const m of states) if (m.assetId) validateReference(m, `${m.sourceId} state ${m.state}`);
for (const m of states) for (const part of m.visualParts ?? []) validateReference(part, `${m.sourceId} state-part ${m.state}`);
for (const m of responsive) if (m.assetId) validateReference(m, `${m.sourceId} responsive`);

const dormant = (r) => ['registered-only', 'source-only-unmounted'].includes(r.reachability?.status);
const coverage = records.map((record) => {
  const sourceMappings = mappings.filter((m) => m.sourceId === record.id);
  const stateMappings = states.filter((m) => m.sourceId === record.id);
  const missingStates = (record.importantStates ?? []).filter((state) => !stateMappings.some((m) => m.state === state));
  if (!dormant(record) && !sourceMappings.length) problems.push(`Unmapped source ${record.id}`);
  if (!dormant(record) && missingStates.length) problems.push(`${record.id}: ${missingStates.length} unmapped important states`);
  const references = [...sourceMappings, ...stateMappings, ...responsive.filter((m) => m.sourceId === record.id)]
    .flatMap((m) => [m, ...(m.responsiveCoverage?.assetId ? [m.responsiveCoverage] : []), ...(m.visualParts ?? [])])
    .map((mapping) => resolveReference(mapping)).filter(Boolean);
  return { sourceId: record.id, title: record.title, kind: record.kind, dormant: dormant(record),
    mappings: sourceMappings, stateMappings, missingStates, assetIds: [...new Set(references.map((m) => m.assetId))] };
});

let mappedFields = 0, mappedActions = 0;
const fieldActionGaps = [];
for (const row of coverage.filter((c) => !c.dormant)) {
  const source = records.find((r) => r.id === row.sourceId);
  const contractText = row.assetIds.map((id) => JSON.stringify(assetsById.get(id))).join('\n');
  for (const field of source.fields ?? []) {
    mappedFields++;
    if (!contractText.includes(field.name)) fieldActionGaps.push({ sourceId: source.id, type: 'field', label: field.name });
  }
  for (const action of source.actions ?? []) {
    mappedActions++;
    if (!contractText.includes(action.label)) fieldActionGaps.push({ sourceId: source.id, type: 'action', label: action.label });
  }
}
for (const gap of fieldActionGaps) problems.push(`${gap.sourceId}: unmapped ${gap.type} contract ${gap.label}`);
await writeAtomic(join(root, 'design/field-action-mapping-check.json'), JSON.stringify({
  activeSources: coverage.filter((c) => !c.dormant).length, fields: mappedFields, actions: mappedActions,
  stringCoverageGaps: fieldActionGaps.length, gaps: fieldActionGaps,
  method: 'Presence in mapped complete asset contracts and explicit shared-host aliases; not raster or behavior acceptance',
}, null, 2) + '\n');

const files = (await readdir(join(root, 'design/images'))).filter((f) => f.endsWith('.png'));
const selection = (await optional('design/selection.json')) ?? { 'WS-D001': 'PILOT-WS-001' };
const reviewSelection = (await optional('design/review-selection.json')) ?? {};
const outputs = [];
for (const asset of assets) {
  const selected = selection[asset.id];
  const revision = (file) => Number(file.match(/-v(\d+)\.png$/)?.[1] ?? 0);
  const candidates = files.filter((file) => file === `${asset.id}.png` || file.startsWith(`${asset.id}-v`) || file === `${selected}.png`)
    .sort((a, b) => revision(b) - revision(a));
  const versions = [];
  for (const file of candidates) {
    const stem = file.slice(0, -4), path = `design/images/${file}`;
    const metadataPath = `design/images/${stem}.json`;
    const metadata = await optional(metadataPath);
    const defaultReviewPath = `design/reviews/${stem}-review.json`;
    const reviewPath = reviewSelection[stem] ?? defaultReviewPath;
    if (!/^design\/reviews\/[A-Za-z0-9-]+-review\.json$/.test(reviewPath)) throw Error(`Invalid review selection for ${stem}`);
    const review = await optional(reviewPath);
    const metadataSha256 = metadata ? sha(await readFile(join(root, metadataPath))) : null;
    const reviewSha256 = review ? sha(await readFile(join(root, reviewPath))) : null;
    const metadataReviewBound = reviewPath === defaultReviewPath || review?.reviewedSidecarSha256 === metadataSha256;
    const bytes = await readFile(join(root, path));
    const hash = sha(bytes);
    const signatureOK = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    const sourceIds = metadata?.sourceIds ?? metadata?.surfaceIds ?? [];
    const modelOK = metadata?.model?.required === 'gpt-image-2'
      && metadata.model.actualTool === 'tools.image_gen__imagegen'
      && metadata.model.fallbackUsed === false
      && metadata.model.perCallModelIdentityReceiptExposed === false;
    const metadataOK = metadata?.sha256 === hash
      && Boolean(metadata.submittedPrompt ?? metadata.actualPrompt ?? metadata.prompt)
      && (metadata.source933 ?? metadata.sourceCommit) === inventory.baselineCommit
      && metadata.dimensions?.width === width && metadata.dimensions?.height === height
      && asset.sourceIds.every((id) => sourceIds.includes(id)) && modelOK;
    const reviewedHash = review?.reviewedImageSha256 ?? review?.imageSha256 ?? review?.artifactSha256;
    const pilotAccepted = stem === 'PILOT-WS-001' && metadata?.contentReview?.selected === true && metadata.contentReview.status.startsWith('passed') && review?.verdict.startsWith('pass') && reviewedHash === hash;
    const contentAccepted = metadataOK && signatureOK && metadataReviewBound && Boolean((review?.verdict === 'pass' && reviewedHash === hash) || pilotAccepted);
    // A recovered orphan can pass visual review while its request-to-file binding is unresolved.
    // This is different from the model-identity receipt the built-in tool never exposes.
    const replacementReceipt = metadata?.currentGenerationReceipt;
    const replacementClosesInterruption = replacementReceipt?.toolResultReceiptObserved === true
      && replacementReceipt.toolOutputFile === metadata?.toolOutputFile
      && typeof replacementReceipt.toolOutputHint === 'string'
      && replacementReceipt.toolOutputHint.includes(replacementReceipt.toolOutputFile)
      && typeof metadata?.toolOutputHint === 'string'
      && metadata.toolOutputHint.includes(metadata.toolOutputFile);
    const provenanceUnresolved = metadata?.interruptionRecovery?.toolResultReceiptObserved === false
      && !replacementClosesInterruption;
    const accepted = contentAccepted && !provenanceUnresolved;
    if (!metadataOK || !signatureOK) problems.push(`${file}: invalid PNG/provenance (hash, actual dimensions, full prompt, source IDs/commit or verified built-in model contract)`);
    versions.push({ file: path, metadata: metadataPath, review: review ? reviewPath : null,
      sha256: hash, metadataSha256, reviewSha256, width, height, accepted, contentAccepted, provenanceUnresolved,
      provenanceStatus: provenanceUnresolved ? 'unresolved-call-to-file-binding' : 'recorded-no-open-interruption-gap',
      status: contentAccepted && provenanceUnresolved ? 'provenance-unresolved' : accepted ? 'passed' : review?.verdict === 'needs-revision' && reviewedHash === hash ? 'needs-revision' : 'pending-review' });
  }
  const current = versions.find((v) => selected && v.file.endsWith(`/${selected}.png`)) ?? versions[0] ?? null;
  outputs.push({ id: asset.id, title: asset.title, kind: asset.kind, sourceIds: asset.sourceIds, panels: asset.panels,
    status: current?.status ?? 'missing', current, versions });
}
const digest = sha(JSON.stringify({ plans, outputs: outputs.map((o) => ({ id: o.id, sha: o.current?.sha256, metadata: o.current?.metadataSha256, review: o.current?.reviewSha256, status: o.status })) }));
const globalReview = await optional('design/reviews/global-design-review.json');
const summary = { sourceRecords: records.length, dormantRecords: coverage.filter((c) => c.dormant).length,
  plannedAssets: assets.length, generatedPlannedAssets: outputs.filter((o) => o.current).length,
  acceptedAssets: outputs.filter((o) => o.status === 'passed').length,
  staticContentReviewedAssets: outputs.filter((o) => o.current?.contentAccepted).length,
  provenanceUnresolvedAssets: outputs.filter((o) => o.current?.provenanceUnresolved).length,
  pendingReview: outputs.filter((o) => o.status === 'pending-review').length,
  needsRevision: outputs.filter((o) => o.status === 'needs-revision').length,
  missingAssets: outputs.filter((o) => o.status === 'missing').length,
  allGeneratedPNGsIncludingHistorical: files.length, mappingProblems: problems.length };
const gates = { modelVerified: inventory.gates.modelVerified,
  coverageComplete: problems.length === 0,
  allRequiredDesignsGenerated: outputs.every((o) => o.current),
  perDesignFunctionalReviewPassed: outputs.every((o) => o.current?.contentAccepted === true),
  generationProvenanceResolved: outputs.every((o) => o.current && !o.current.provenanceUnresolved),
  globalDesignReviewPassed: globalReview?.verdict === 'pass' && globalReview?.coverageDigest === digest };
gates.developmentPermitted = Object.values(gates).every(Boolean);
const catalog = { schema: 1, updatedAt: new Date().toISOString(), baselineCommit: inventory.baselineCommit,
  coverageDigest: digest, summary, gates, problems, coverage, outputs };
await writeAtomic(join(root, 'design/catalog.json'), JSON.stringify(catalog, null, 2) + '\n');

const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
const data = JSON.stringify(outputs).replace(/</g, '\\u003c');
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DooKnow 全平台设计进度</title><style>*{box-sizing:border-box}body{margin:0;background:#f7f8fa;color:#272b3a;font:14px/1.6 system-ui,sans-serif}header,main,nav{max-width:1440px;margin:auto;padding:20px}h1{font-size:25px;margin:0}p,small{color:#657084}a{color:#4566c6}nav{position:sticky;top:0;background:#fff;display:flex;flex-wrap:wrap;gap:10px;z-index:1;border-block:1px solid #e6e9f1}input,select,button{font:inherit;padding:8px 12px;border:1px solid #d9dfeb;border-radius:7px;background:white;color:inherit}input{flex:1;min-width:150px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}article{background:white;border:1px solid #e6e9f1;border-radius:8px;padding:16px;min-width:0}h2{font-size:16px;margin:0}code{overflow-wrap:anywhere}details{margin-top:12px}summary{cursor:pointer;color:#4566c6}img{display:block;max-width:100%;max-height:620px;object-fit:contain;margin-top:12px}.gate{padding:12px;border:1px solid #dfc68e;background:#fff8e7;border-radius:8px}.pager{display:flex;gap:12px;align-items:center;margin-bottom:16px}@media(max-width:650px){header,main,nav{padding:14px}.grid{grid-template-columns:1fr}h1{font-size:21px}input{width:100%;flex:auto}}</style><header><h1>DooKnow 全平台 · GPT-Image2 设计图稿</h1><p>已落地 ToDoo 只作为风格基准。本页记录本轮生成设计，不是新产品运行截图。</p><div class="gate">${gates.developmentPermitted ? '完整设计门槛已通过。' : '完整设计门槛尚未通过，产品 UI 开发未获放行。'} ${summary.plannedAssets} 个计划资产，已生成 ${summary.generatedPlannedAssets}，审查通过 ${summary.acceptedAssets}，待复核 ${summary.pendingReview}，待修 ${summary.needsRevision}，来源待核 ${summary.provenanceUnresolvedAssets}，缺图 ${summary.missingAssets}。</div><p><a href="../index.html">功能清单与真实改造前基线</a> · <a href="catalog.json">逐项覆盖及门槛</a> · <a href="style-contract.md">共享视觉合同</a></p></header><nav><input id="query" aria-label="搜索图稿" placeholder="编号、页面、来源ID"><select id="status" aria-label="审查状态"><option value="">全部状态</option><option>missing</option><option>pending-review</option><option>needs-revision</option><option>provenance-unresolved</option><option>passed</option></select><select id="group" aria-label="范围"><option value="">全部范围</option><option value="WS-">工作区</option><option value="MP-">设置与公共</option></select></nav><main><div class="pager"><button id="prev">上一页</button><span id="count"></span><button id="next">下一页</button></div><div class="grid" id="grid"></div></main><script>const rows=${data};let page=0;const size=12;const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));function update(){const q=document.querySelector('#query').value.toLowerCase(),status=document.querySelector('#status').value,group=document.querySelector('#group').value;const list=rows.filter(r=>(!status||r.status===status)&&(!group||r.id.startsWith(group))&&JSON.stringify([r.id,r.title,r.sourceIds]).toLowerCase().includes(q));page=Math.min(page,Math.max(0,Math.ceil(list.length/size)-1));document.querySelector('#grid').innerHTML=list.slice(page*size,(page+1)*size).map(r=>'<article><h2>'+esc(r.id+' · '+r.title)+'</h2><small>'+esc(r.kind+' · '+r.status)+'</small><p><code>'+esc(r.sourceIds.join(', '))+'</code></p>'+(r.current?'<a href="'+esc(r.current.metadata.replace('design/',''))+'">提示词与来源</a>'+(r.current.review?' · <a href="'+esc(r.current.review.replace('design/',''))+'">独立复核</a>':'')+'<details><summary>按需查看设计图（'+r.current.width+'×'+r.current.height+'）</summary><a href="'+esc(r.current.file.replace('design/',''))+'"><img data-src="'+esc(r.current.file.replace('design/',''))+'" alt="'+esc(r.title)+'" loading="lazy"></a></details>':'<p>尚未生成；保留全部功能与状态映射。</p>')+'</article>').join('');document.querySelector('#count').textContent=list.length+' 项 · '+(page+1)+' / '+Math.max(1,Math.ceil(list.length/size));document.querySelector('#prev').disabled=!page;document.querySelector('#next').disabled=(page+1)*size>=list.length;document.querySelectorAll('details').forEach(d=>d.ontoggle=()=>{if(d.open){const i=d.querySelector('img');if(!i.src)i.src=i.dataset.src}})}document.querySelector('#query').oninput=()=>{page=0;update()};for(const id of ['status','group'])document.querySelector('#'+id).onchange=()=>{page=0;update()};document.querySelector('#prev').onclick=()=>{page--;update()};document.querySelector('#next').onclick=()=>{page++;update()};update();</script></html>`;
await writeAtomic(join(root, 'design/index.html'), html);
console.log(JSON.stringify({ summary, gates, firstProblems: problems.slice(0, 8) }));
if (process.argv.includes('--require-complete') && !gates.developmentPermitted) process.exitCode = 1;
