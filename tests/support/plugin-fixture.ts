import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { PluginCatalogEntry } from '../../packages/plugin-contracts/index.js';
export async function pluginFixture(root: string): Promise<PluginCatalogEntry> {
  const code = join(root, 'counter-source');
  await mkdir(join(code, 'server'), { recursive: true }); await mkdir(join(code, 'web'), { recursive: true });
  const manifest = { id: 'counter', version: '1.0.0', apiVersion: '^1.0.0', title: '计数验收插件',
    capabilities: [], server: 'server/index.mjs', web: 'web/index.mjs',
    styles: ['web/style.css'],
    configSchema: { type: 'object', additionalProperties: false, properties: { label: { type: 'string', default: '计数' } } },
    contributions: [{ id: 'counter.navigation', slot: 'navigation' as const, title: '计数验收', component: 'counter.page' }] };
  await writeFile(join(code, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(code, 'server/index.mjs'), `export function activate(ctx) {
    ctx.registerProvider('counter.state', async () => ({ count: ctx.storage.get('count') || 0 }));
    ctx.registerCommand('counter.increment', async () => { const count = (ctx.storage.get('count') || 0) + 1; ctx.storage.set('count',count); return {count}; });
  }`);
  await writeFile(join(code, 'web/label.mjs'), `export const label = '插件计数';`);
  await writeFile(join(code, 'web/style.css'), '.dooknow-plugin-counter { border-top: 5px solid rgb(42, 90, 123) !important; }');
  await writeFile(join(code, 'web/index.mjs'), `import {defineComponent,h,ref,onMounted} from 'vue';
    import {NButton} from '@dooknow/plugin-ui'; import {label} from './label.mjs';
    export function activate(api) { return api.registerComponent('counter.page', defineComponent({setup() {
      const count=ref(0); onMounted(async()=>{ count.value=(await api.call('provider','counter.state',{})).count; });
      return ()=>h(NButton,{class:'dooknow-plugin-counter',onClick:async()=>{count.value=(await api.call('command','counter.increment',{})).count;}},()=>label+' '+count.value);
    }})); }`);
  const artifact = join(root, 'counter.tar.gz');
  execFileSync('tar', ['--format=ustar', '-czf', artifact, '-C', code, '.']);
  return { ...manifest, description: '仅在自动化测试中提供的真实预构建插件', artifact: {
    url: pathToFileURL(artifact).href, sha256: createHash('sha256').update(await readFile(artifact)).digest('hex') } };
}
