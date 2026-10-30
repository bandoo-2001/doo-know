import { expect, it, vi } from 'vitest';
import { createOperations } from '../plugins/mcp/server/operations.js';
import { hostClient } from '../plugins/mcp/server/service.js';
import { createPluginDraft, serializePluginDraft } from '../apps/web/plugin-config.js';
const principal = { id: 'owner', clientId: 'agent', scopes: ['knowledge:read','knowledge:write','knowledge:organize'], allowedPrefixes: [], knowledgeAll: true };
const registry = (services: any = {}) => createOperations({ objectIdSecret: 'test-organization-secret-at-least-thirty-two-characters' }, hostClient(() => ({ knowledge: {}, ...services } as any), () => ({})));
it('discovers five organization tools and refuses missing host services without falling back', async () => {
  const r = registry();
  expect(r.operations.map(o => o.name)).toEqual(expect.arrayContaining(['get_mcp_context','list_directories','organize_library','list_organization_history','undo_organization']));
  await expect(r.execute('get_mcp_context', { ...principal, scopes: [] }, {})).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' });
});
it('requires organization authority before any host submission', async () => {
  const submit = vi.fn();
  await expect(registry({ knowledgeOrganization: { submit } }).execute('organize_library', { ...principal, scopes: ['knowledge:read','knowledge:write'] }, {})).rejects.toMatchObject({ code: 'INSUFFICIENT_SCOPE', requiredScope: 'knowledge:organize' });
  expect(submit).not.toHaveBeenCalled();
});
it('validates bounded organization actions before entering the host', async () => {
  const submit = vi.fn(); const r = registry({ knowledgeOrganization: { submit } });
  const base = { requestId: 'one', libraryId: 'library', expectedStructureRevision: '1' };
  for (const actions of [[], Array.from({length: 51}, () => ({ type:'create_directory',parentId:null,name:'A' })), [{type:'move_note',noteId:'n',toDirectoryId:null,fileName:'a.md'}], [{type:'create_directory',parentId:null,name:'A',extra:true}]]) {
    await expect(r.execute('organize_library', principal, { ...base, actions })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  }
  expect(submit).not.toHaveBeenCalled();
});
it('does not give content editors archive or blog-read authority', async () => {
  const r = registry();
  await expect(r.execute('archive_note', { ...principal, scopes: ['knowledge:read','knowledge:write'] }, {})).rejects.toMatchObject({ code:'INSUFFICIENT_SCOPE',requiredScope:'knowledge:archive' });
  await expect(r.execute('get_blog_status', { ...principal, scopes: ['knowledge:read'] }, {})).rejects.toMatchObject({ code:'INSUFFICIENT_SCOPE',requiredScope:'blog:read' });
});
it('accepts directory identities including explicit root without a legacy path', () => {
  const input = registry().operations.find(o => o.name === 'create_note')!.input;
  const base = {fileName:'A.md',content:'hello',requestId:'one'};
  expect(input.safeParse({...base,directoryId:'directory'}).success).toBe(true);
  expect(input.safeParse({...base,directoryId:null}).success).toBe(true);
  expect(input.safeParse({...base,directory:'00-Inbox'}).success).toBe(true);
  expect(input.safeParse(base).success).toBe(false);
  expect(input.safeParse({...base,directoryId:''}).success).toBe(false);
});
it('keeps permission drafts structured and isolated from installed configuration', () => {
  const permissionPolicy = {version:2,domains:{knowledge:{enabled:true,ownerId:'owner',instanceId:'library',actions:['read','write','organize'],resources:{mode:'all'}}}};
  const plugin = {id:'mcp',configVersion:1,config:{permissionPolicy},manifest:{configSchema:{properties:{permissionPolicy:{type:'object'}}}},configuredSecrets:[]} as any;
  const draft = createPluginDraft(plugin);
  expect(draft.values.permissionPolicy).toEqual(permissionPolicy);
  draft.values.permissionPolicy.domains.knowledge.actions.push('index');
  expect(permissionPolicy.domains.knowledge.actions).not.toContain('index');
  expect(serializePluginDraft(draft,plugin).values.permissionPolicy).toEqual(draft.values.permissionPolicy);
});
it('accepts a legacy path input under a host-signed v2 all grant',async()=>{
  const p={...principal,knowledgeAll:undefined,permissionPolicy:{version:2 as const,domains:{knowledge:{enabled:true,ownerId:'owner',instanceId:'library',actions:['read','write','organize'],resources:{mode:'all' as const}}}}};
  const r=registry({knowledge:{create:async()=>({id:'note',relativePath:'00-Inbox/a.md',modifiedAt:'123',contentHash:'a'.repeat(64),sizeBytes:1,indexState:'pending'})}});
  expect(await r.execute('create_note',p,{directory:'00-Inbox',fileName:'a.md',content:'A',requestId:'path-with-all'})).toMatchObject({data:{relativePath:'00-Inbox/a.md'}});
});
it('lets the host resolve selected directory identities before checking a legacy path',async()=>{
  const p={...principal,knowledgeAll:undefined,permissionPolicy:{version:2 as const,domains:{knowledge:{enabled:true,ownerId:'owner',instanceId:'library',actions:['read','write'],resources:{mode:'selected' as const,resources:[{kind:'directory',id:'stable-directory'}]}}}}};
  const r=registry({knowledge:{create:async()=>({id:'note',relativePath:'Moved/a.md',modifiedAt:'123',contentHash:'a'.repeat(64),sizeBytes:1,indexState:'pending'})}});
  expect(await r.execute('create_note',p,{directory:'Moved',fileName:'a.md',content:'A',requestId:'selected-current-path'})).toMatchObject({data:{relativePath:'Moved/a.md'}});
});
it('refuses plugin policies that request unimplemented domains',async()=>{
  const {activate}=await import('../plugins/mcp/server/index.js');
  const config={allowedPrefixes:['00-Inbox'],permissionPolicy:{version:2,domains:{todo:{enabled:true,ownerId:'owner',instanceId:'tasks',actions:['write'],resources:{mode:'all'}}}}};
  const context={config:()=>config,secrets:{getOrCreate:()=> 'test-secret'},storage:{get:()=>undefined,set:()=>{}},registerProvider:()=>{},registerCommand:()=>{},registerProtocol:()=>{},onConfigure:()=>{},onDispose:()=>{}} as any;
  expect(()=>activate(context)).toThrowError(expect.objectContaining({code:'INVALID_CONFIGURATION'}));
});
