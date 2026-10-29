import { expect, it } from 'vitest';
import { reactive } from 'vue';
import { domainPreset, domainResourceMode, selectableDomains, defaultConsentPolicy, describePermissionPolicy } from '../apps/web/mcp-permissions.js';
const policy = () => ({version:2 as const,domains:{knowledge:{enabled:true,ownerId:'owner',instanceId:'library',actions:['read'],resources:{mode:'selected' as const,resources:[{kind:'directory',id:'inbox'}]}},blog:{enabled:false,ownerId:'owner',instanceId:'blog',actions:[],resources:{mode:'selected' as const,resources:[]}}}});
it('offers only implemented domains and independent knowledge presets', () => {
  expect(selectableDomains.map(d=>d.id)).toEqual(['knowledge','blog','to-doo']);
  const initial=policy(), edited=domainPreset(initial,'organize');
  expect(edited.domains.knowledge.actions).toEqual(['read','write','organize']);
  expect(edited.domains.knowledge.resources).toEqual(initial.domains.knowledge.resources);
  expect(edited.domains.blog).toEqual(initial.domains.blog);
  expect(initial.domains.knowledge.actions).toEqual(['read']);
});
it('changes scope explicitly and preserves selected identities when changing actions', () => {
  const initial=policy();
  expect(domainResourceMode(initial,'knowledge','all').domains.knowledge.resources).toEqual({mode:'all'});
  expect(domainResourceMode(initial,'knowledge','selected').domains.knowledge.resources).toEqual(initial.domains.knowledge.resources);
  expect(domainResourceMode(domainResourceMode(initial,'knowledge','all'),'knowledge','selected').domains.knowledge.resources).toEqual({mode:'selected',resources:[]});
});
it('consent defaults to reading without archive, organize, index or public disclosure', () => {
  const ceiling=domainPreset(policy(),'organize'); ceiling.domains.knowledge.actions.push('archive','index'); ceiling.domains.blog={...ceiling.domains.blog,enabled:true,actions:['read','publish']};
  const selected=defaultConsentPolicy(ceiling,['knowledge:read','knowledge:write','knowledge:organize','knowledge:archive','blog:read','blog:publish']);
  expect(selected.domains.knowledge.actions).toEqual(['read']);
  expect(selected.domains.blog.enabled).toBe(false);
  expect(selected.domains.blog.actions).toEqual([]);
});
it('renders actual domain rights and full versus selected scopes', () => {
  const initial=domainResourceMode(domainPreset(policy(),'organize'),'knowledge','all');
  expect(describePermissionPolicy(initial)).toContain('自主整理');
  expect(describePermissionPolicy(initial)).toContain('整个知识库');
  expect(describePermissionPolicy(initial)).not.toContain('公开发布');
});

it('edits a reactive policy without mutating the saved Vue state',()=>{const saved=reactive(policy());const edited=domainPreset(saved,'edit');expect(edited.domains.knowledge.actions).toEqual(['read','write']);expect(saved.domains.knowledge.actions).toEqual(['read']);});
