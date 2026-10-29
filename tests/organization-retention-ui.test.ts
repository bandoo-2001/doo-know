import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse, compileScript } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as Vue from 'vue';
const api=vi.fn();
const cleanup:Array<()=>void>=[];
afterEach(()=>{while(cleanup.length)cleanup.pop()!();api.mockReset();});
async function mount(){
  const file=new URL('../apps/web/components/OrganizationRetentionSettings.vue',import.meta.url);
  const descriptor=parse(readFileSync(file,'utf8')).descriptor;
  const code=ts.transpileModule(compileScript(descriptor,{id:'retention-test'}).content,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const module={exports:{} as any};
  new Function('require','module','exports',code)((id:string)=>{if(id==='vue')return Vue;if(id==='../api')return{api};if(id==='ant-design-vue')return{Alert:'aside',Button:'button',InputNumber:'input'};throw Error('Unexpected dependency '+id);},module,module.exports);
  const component=module.exports.default;component.render=()=>null;
  const renderer=Vue.createRenderer<any,any>({insert(){},remove(){},createElement:()=>({}),createText:()=>({}),createComment:()=>({}),setText(){},setElementText(){},parentNode:()=>null,nextSibling:()=>null,patchProp(){}});
  const app=renderer.createApp(component);app.mount({});cleanup.push(()=>app.unmount());await Vue.nextTick();return(app as any)._instance.setupState;
}
it('reads only on first expansion and persists a valid future-task retention duration',async()=>{
  let saved=30;
  api.mockImplementation(async(_url,method,body)=>{if(method==='PUT')saved=body.retentionDays;return{retentionDays:saved};});
  const view=await mount();expect(api).not.toHaveBeenCalled();
  await view.expand(false);expect(api).not.toHaveBeenCalled();
  await view.expand(true);expect(view.loaded).toBe(true);expect(view.retentionDays).toBe(30);
  view.retentionDays=7;await view.save();expect(view.notice).toContain('已保存');expect(saved).toBe(7);
  const count=api.mock.calls.length;await view.expand(false);await view.expand(true);expect(api.mock.calls.length).toBe(count);
  const reopened=await mount();await reopened.expand(true);expect(reopened.retentionDays).toBe(7);
});
it('rejects invalid durations locally and preserves the draft when saving fails',async()=>{
  api.mockResolvedValue({retentionDays:30});const view=await mount();await view.expand(true);
  for(const invalid of [0,3651,1.5,null]){view.retentionDays=invalid;await view.save();expect(view.error).toContain('1');}
  expect(api.mock.calls.filter(([,method])=>method==='PUT')).toHaveLength(0);
  view.retentionDays=60;api.mockRejectedValueOnce(Error('offline'));await view.save();expect(view.retentionDays).toBe(60);expect(view.error).toContain('核对');expect(view.notice).toBe('');
});
