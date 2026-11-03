import { expect, it } from 'vitest';
import { pluginRuntimeFixture } from './support/plugin-runtime.js';
import { oauthGrantStore } from '../apps/server/platform/oauth-grants.js';
import { platformPolicy } from '../packages/core/auth/grants.js';
import { createMcpApiClient, authenticateMcpApiKey, setMcpApiClientPermissions } from '../apps/server/platform/mcp-api-keys.js';
import { checkTokenCutoff } from '../packages/core/agent/auth.js';
import { pluginHost } from '../apps/server/plugins/host.js';

const scopes = ['knowledge:read', 'knowledge:write', 'blog:publish'];
it('requires an explicit publication grant and both publication config controls without expanding old grants', async () => {
  const f = await pluginRuntimeFixture();
  pluginHost(f.config, f.db);
  try {
    const configure = (readOnly: boolean, allowPublish: boolean) => {
      f.db.prepare("UPDATE platform_plugins SET config_json=? WHERE id='mcp'").run(JSON.stringify({ readOnly, allowPublish, allowedPrefixes: ['00-Inbox'] }));
    };
    f.db.prepare("INSERT INTO platform_plugins(id,installed_version,installed,manifest_json,files_json,state,config_json) VALUES('mcp','1.1.0',1,'{}','{}','enabled','{}')").run();
    const grant = oauthGrantStore(f.db).approve(f.principal.id, 'explicit-blog', scopes, ['00-Inbox']);
    const p = { id: f.principal.id, clientId: grant.clientId, scopes, allowedPrefixes: grant.allowedPrefixes, grantId: grant.id, grantVersion: grant.version, tokenIssuedAt: grant.notBefore, pluginId: 'mcp' };
    for (const [readOnly, allowPublish] of [[true, true], [false, false], [true, false]]) {
      configure(readOnly, allowPublish); expect(platformPolicy(f.db, p)?.scopes).not.toContain('blog:publish');
    }
    configure(false, true); expect(platformPolicy(f.db, p)?.scopes).toContain('blog:publish');
    const previous = oauthGrantStore(f.db).approve(f.principal.id, 'old-client', ['knowledge:read', 'knowledge:write'], ['00-Inbox']);
    expect(platformPolicy(f.db, { ...p, clientId: previous.clientId, grantId: previous.id, grantVersion: previous.version })?.scopes).not.toContain('blog:publish');
    oauthGrantStore(f.db).revoke(f.principal.id, grant.clientId); expect(platformPolicy(f.db, p)).toBeUndefined();
  } finally { await f.close(); }
});

it('keeps API Key publication disabled after ceiling expansion until owner grants it', async () => {
  const f = await pluginRuntimeFixture();
  pluginHost(f.config, f.db);
  try {
    const { currentLibraryIdentity, currentBlogInstanceId } = await import('../packages/core/auth/permissions.js');
    const knowledge = {enabled:true,ownerId:f.principal.id,instanceId:currentLibraryIdentity(f.db)!.libraryId,actions:['read','write'],resources:{mode:'all' as const}};
    const base = {version:2 as const,domains:{knowledge}};
    const expanded = {version:2 as const,domains:{knowledge,blog:{enabled:true,ownerId:f.principal.id,instanceId:currentBlogInstanceId(f.db),actions:['read','publish'],resources:{mode:'all' as const}}}};
    const configure = (permissionPolicy: unknown) => f.db.prepare("UPDATE platform_plugins SET config_json=? WHERE id='mcp'").run(JSON.stringify({apiKeyEnabled:true,permissionPolicy}));
    f.db.prepare("INSERT INTO platform_plugins(id,installed_version,installed,manifest_json,files_json,state,config_json) VALUES('mcp','1.4.0',1,'{}','{}','enabled','{}')").run();
    configure(base);
    const issued=createMcpApiClient(f.db,f.principal.id,{name:'Blog client',permissionPolicy:base});
    const call=()=>authenticateMcpApiKey(f.db,'Bearer '+issued.key);
    expect(call().scopes).not.toContain('blog:publish');
    configure(expanded);
    expect(call().scopes).not.toContain('blog:publish');
    setMcpApiClientPermissions(f.db,f.principal.id,issued.client.clientId,{permissionPolicy:expanded,expectedGrantVersion:issued.client.grantVersion});
    expect(call().scopes).toContain('blog:publish');
    configure(base);
    expect(call().scopes).not.toContain('blog:publish');
  } finally { await f.close(); }
});

it('rejects an admitted actor once its token expires before a later authorization check', async () => {
  const f = await pluginRuntimeFixture();
  try {
    const p = { ...f.principal, tokenExpiresAt: Math.floor(Date.now() / 1000) - 1 };
    expect(() => checkTokenCutoff(f.db, p)).toThrowError();
  } finally { await f.close(); }
});
