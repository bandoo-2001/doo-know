<script setup lang="ts">
import { computed, onMounted, ref, useId } from 'vue';
import { Alert as AAlert, Button as AButton, Checkbox as ACheckbox, Select as ASelect, Switch as ASwitch } from 'ant-design-vue';
import type { PermissionPolicy } from '../../../shared/permissions';
import { api } from '../api';
import { selectableDomains, domainPreset, domainResourceMode, type PermissionEditorState } from '../mcp-permissions';
const props=defineProps<{modelValue?:PermissionPolicy;initialPolicy?:PermissionPolicy;ceiling?:PermissionPolicy;disabled?:boolean;consent?:boolean}>();
const componentId=useId();
const emit=defineEmits<{ 'update:modelValue':[value:PermissionPolicy] }>();
const state=ref<PermissionEditorState>(),error=ref('');
const policy=computed(()=>{
  const current=props.modelValue ?? props.initialPolicy ?? state.value?.policy;
  if(!current || props.ceiling || props.consent || !state.value?.policy)return current;
  const domains={...current.domains};
  for(const definition of selectableDomains){
    const available=state.value.policy.domains[definition.id];
    if(!domains[definition.id] && available)
      domains[definition.id]={...available,enabled:false,actions:[]};
  }
  return {...current,domains};
});
const domains=computed(()=>selectableDomains.filter(domain=>policy.value?.domains[domain.id] && (!props.ceiling || props.ceiling.domains[domain.id])));
async function load(){try{state.value=await api<PermissionEditorState>('/api/platform/mcp/permissions');error.value='';}catch{error.value='暂时无法读取资源范围，请重试。';}}
onMounted(load);
function update(domain:string,change:(grant:PermissionPolicy['domains'][string])=>void){if(!policy.value || props.disabled)return;const next=JSON.parse(JSON.stringify(policy.value)) as PermissionPolicy;change(next.domains[domain]);emit('update:modelValue',next);}
function preset(value:string){if(!policy.value || props.disabled)return;const next=domainPreset(policy.value,value);const allowed=props.ceiling?.domains.knowledge?.actions;if(allowed)next.domains.knowledge.actions=next.domains.knowledge.actions.filter(a=>allowed.includes(a));emit('update:modelValue',next);}
function selectedPreset(){const actions=policy.value?.domains.knowledge?.actions||[];return actions.includes('organize')?'organize':actions.includes('write')?'edit':'read';}
function mode(domain:string,value:string){if(!policy.value || props.disabled)return;if(value==='all' && props.ceiling?.domains[domain]?.resources.mode==='selected')return;emit('update:modelValue',domainResourceMode(policy.value,domain,value));}
const key=(ref:{kind:string;id:string})=>JSON.stringify([ref.kind,ref.id]);
function options(domain:string){const grant=policy.value?.domains[domain],ceiling=props.ceiling?.domains[domain]?.resources;const selected=grant?.resources.mode==='selected'?grant.resources.resources:[];let available=state.value?.resources[domain]||[];
  if(ceiling?.mode==='selected')available=available.filter(ref=>ceiling.resources.some(allowed=>key(allowed)===key(ref)));
  const entries=new Map(available.map(ref=>[key(ref),{value:key(ref),label:ref.label}]));
  for(const ref of selected)if(!entries.has(key(ref)))entries.set(key(ref),{value:key(ref),label:`${ref.kind} · ${ref.id}（当前不可用或未加载）`});
  return [...entries.values()];}
function select(domain:string,values:string[]){update(domain,grant=>{grant.resources={mode:'selected',resources:values.map(value=>{const [kind,id]=JSON.parse(value);return {kind,id};})};});}
function actions(domain:string){return selectableDomains.find(d=>d.id===domain)!.actions.filter(action=>action.implemented && (!props.ceiling || props.ceiling.domains[domain]?.actions.includes(action.id)));}
function toggleAction(domain:string,action:string,checked:boolean){update(domain,grant=>{grant.actions=checked?[...new Set([...grant.actions,action])]:grant.actions.filter(value=>value!==action);});}
</script>
<template>
  <section class="domain-permissions" aria-label="分域权限">
    <AAlert v-if="error" type="warning" :message="error"><template #action><AButton size="small" :disabled="disabled" @click="load">重试</AButton></template></AAlert>
    <p v-if="!policy && !error">正在读取业务权限…</p>
    <article v-for="domain in domains" :key="domain.id" class="domain-card" :aria-label="domain.title+'权限'">
      <header><h3>{{domain.title}}</h3><ASwitch :checked="policy!.domains[domain.id].enabled" :disabled="disabled" :aria-label="'启用'+domain.title+'权限'" @update:checked="value=>update(domain.id,grant=>{grant.enabled=!!value})" /></header>
      <template v-if="policy!.domains[domain.id].enabled">
        <div v-if="domain.id==='knowledge'" class="domain-field"><label :for="componentId+'-preset'">知识库能力预设</label>
          <ASelect :id="componentId+'-preset'" :value="selectedPreset()" :disabled="disabled" aria-label="知识库能力预设" @update:value="value=>preset(String(value))">
            <ASelect.Option value="read">只读</ASelect.Option>
            <ASelect.Option value="edit" :disabled="ceiling && !ceiling.domains.knowledge?.actions.includes('write')">内容编辑</ASelect.Option>
            <ASelect.Option value="organize" :disabled="ceiling && !ceiling.domains.knowledge?.actions.includes('organize')">自主整理</ASelect.Option>
          </ASelect>
        </div>
        <div class="domain-field"><label :for="componentId+'-scope-'+domain.id">{{domain.title}}资源范围</label>
          <ASelect :id="componentId+'-scope-'+domain.id" :value="policy!.domains[domain.id].resources.mode" :disabled="disabled" :aria-label="domain.title+'资源范围'" @update:value="value=>mode(domain.id,String(value))">
            <ASelect.Option value="all" :disabled="ceiling?.domains[domain.id]?.resources.mode==='selected'">{{domain.id==='knowledge'?'整个知识库':domain.id==='to-doo'?'全部清单':'全站'}}</ASelect.Option>
            <ASelect.Option value="selected">{{domain.id==='knowledge'?'指定目录/笔记':domain.id==='to-doo'?'指定清单':'指定文章'}}</ASelect.Option>
          </ASelect>
        </div>
        <label v-if="policy!.domains[domain.id].resources.mode==='selected'" :for="componentId+'-resources-'+domain.id">选择{{domain.title}}资源</label>
        <ASelect :id="componentId+'-resources-'+domain.id" v-if="policy!.domains[domain.id].resources.mode==='selected'" mode="multiple" :value="(policy!.domains[domain.id].resources as any).resources.map(key)" :options="options(domain.id)" :disabled="disabled" :aria-label="'选择'+domain.title+'资源'" @update:value="values=>select(domain.id,values as string[])" />
        <p v-if="domain.id==='knowledge'">目录授权跟随身份并覆盖后代；自主整理允许直接创建、移动和改名。归档和维护索引独立设置。</p>
        <p v-else-if="domain.id==='to-doo'">清单范围与允许的内容类别同时生效；任务授权不会开放笔记原文。读取和编辑分别授权。</p>
        <p v-else>公开发布需要读取原文和附件；不会要求知识库写入。修改私有笔记不会自动更新公开文章。</p>
        <details :open="domain.id==='blog'"><summary>{{domain.id==='knowledge'?'独立权限与高级选项':domain.id==='to-doo'?'任务能力':'博客能力'}}</summary>
          <ACheckbox v-for="action in actions(domain.id)" :key="action.id" :checked="policy!.domains[domain.id].actions.includes(action.id)" :disabled="disabled" @update:checked="value=>toggleAction(domain.id,action.id,!!value)">{{action.title}}</ACheckbox>
        </details>
      </template>
    </article>
    <p v-if="policy && !consent">插件权限是客户端能力上限。收窄后下次调用立即受限；扩大后已有客户端须重新授权一次。</p>
  </section>
</template>
<style scoped>
.domain-permissions{display:grid;gap:12px;grid-column:1/-1;min-width:0}.domain-card{border:1px solid var(--border);border-radius:8px;padding:16px;min-width:0}.domain-card header{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}.domain-card h3{margin:0;font-size:15px}.domain-card .domain-field{display:grid;gap:6px;margin:12px 0}.domain-card label{display:block;margin:6px 0}.domain-card :deep(.ant-select){width:100%;min-width:0}.domain-card p,.domain-permissions>p{font-size:12px;line-height:1.7;color:var(--muted)}.domain-card details :deep(.ant-checkbox-wrapper){margin-top:10px;margin-inline-start:0;margin-right:14px}
</style>
