import { permissionDomains, type PermissionPolicy, type ResourceRef } from '../../shared/permissions';
export const selectableDomains = permissionDomains.filter(domain => domain.implemented);
export type PermissionResourceOption = ResourceRef & { label: string };
export type PermissionEditorState = { policy: PermissionPolicy; resources: Record<string, PermissionResourceOption[]>; bindings?: Record<string, { ownerId: string; instanceId: string }> };
export function domainPreset(policy: PermissionPolicy, preset: string): PermissionPolicy {
  const next = JSON.parse(JSON.stringify(policy)) as PermissionPolicy, knowledge = next.domains.knowledge;
  if (!knowledge) return next;
  const core = preset === 'organize' ? ['read','write','organize'] : preset === 'edit' ? ['read','write'] : ['read'];
  knowledge.enabled = true;
  knowledge.actions = [...core,...knowledge.actions.filter(a => ['archive','index'].includes(a))];
  return next;
}
export function domainResourceMode(policy: PermissionPolicy, domain: string, mode: string): PermissionPolicy {
  const next = JSON.parse(JSON.stringify(policy)) as PermissionPolicy, grant = next.domains[domain];
  if (grant) grant.resources = mode === 'all' ? {mode:'all'} : grant.resources.mode === 'selected' ? grant.resources : {mode:'selected',resources:[]};
  return next;
}
export function defaultConsentPolicy(policy: PermissionPolicy, scopes: string[]): PermissionPolicy {
  const next=JSON.parse(JSON.stringify(policy)) as PermissionPolicy;
  for (const [domain,grant] of Object.entries(next.domains)) {
    grant.actions=['knowledge','to-doo'].includes(domain) && scopes.includes(`${domain}:read`) && grant.actions.includes('read') ? ['read'] : [];
    grant.enabled=grant.enabled && grant.actions.length > 0;
  }
  return next;
}
export function policyScopes(policy?: PermissionPolicy): string[] {
  return Object.entries(policy?.domains || {}).flatMap(([domain,grant]) => grant.enabled ? grant.actions.map(action => `${domain}:${action}`) : []);
}
export function validConsentPolicy(policy?: PermissionPolicy): boolean {
  const active=Object.values(policy?.domains || {}).filter(grant => grant.enabled);
  const scopes=policyScopes(policy);
  return active.length>0 && active.every(grant => grant.actions.length>0 && (grant.resources.mode==='all' || grant.resources.resources.length>0)) && (!scopes.includes('blog:publish') || scopes.includes('knowledge:read')) && (!scopes.includes('to-doo:write') || scopes.includes('to-doo:read'));
}
export function describePermissionPolicy(policy: PermissionPolicy|undefined): string {
  return selectableDomains.flatMap(domain => {
    const grant=policy?.domains[domain.id];
    if (!grant?.enabled) return [];
    const actions=domain.actions.filter(action => grant.actions.includes(action.id)).map(action=>action.title).join('、');
    const scope=grant.resources.mode==='all' ? domain.id==='knowledge' ? '整个知识库' : domain.id==='to-doo' ? '全部清单' : '全站' : `${grant.resources.resources.length} 个指定资源`;
    return [`${domain.title}：${actions}（${scope}）`];
  }).join('；') || '当前不可访问';
}
