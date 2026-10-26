import { it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
// @ts-expect-error build tool is plain ESM
import { buildPlugins } from '../scripts/build-plugins.mjs';
import { createFixture, loginFixtureOwner } from './support/fixture.js';
import { resetOwnerPassword } from '../apps/server/auth.js';
import { testPassword } from './support/credentials.js';
import { openDatabase } from '../packages/core/db.js';
import { createAuth } from '../apps/server/auth.js';
import { oauthGrantStore } from '../apps/server/platform/oauth-grants.js';
it('installs the official prebuilt MCP, isolates transports, observes calls without contents, and revokes unused static credentials on reset', async () => {
  const artifacts = await mkdtemp(join(tmpdir(), 'mcp-build-'));
  const catalog = await buildPlugins({ output: artifacts, ids: ['mcp'], baseURL: pathToFileURL(artifacts + '/').href });
  const f = await createFixture({ pluginCatalog: catalog });
  const token = 'fixture-static-credential-never-printed-in-observation';
  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    const headers = await loginFixtureOwner(f);
    const post = (url: string, payload: any) => f.app.inject({ method: 'POST', url, headers, payload });
    expect((await post('/api/platform/plugins/mcp/install', {})).statusCode).toBe(200);
    const configure = await f.app.inject({ method: 'PUT', url: '/api/platform/plugins/mcp/config', headers,
      payload: { configVersion: 0, values: { mode: 'both', compatPort: 15179, tunnelToken: token } } });
    expect(configure.statusCode).toBe(200);
    const enable = await post('/api/platform/plugins/mcp/enable', {}); expect(enable.statusCode).toBe(200);
    const rpc = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
    const external = { authorization: 'Bearer ' + token, accept: 'application/json, text/event-stream' };
    const wrongEntry = await f.app.inject({ method: 'POST', url: '/mcp', headers: {...external,host:'localhost:3010'}, payload: rpc });
    expect(wrongEntry.statusCode).toBe(401);
    const legacy = await fetch('http://127.0.0.1:15179/api/v1/tools/list_notes', { method: 'POST', headers: { ...external, 'content-type': 'application/json' }, body: '{}' });
    expect(legacy.status).toBe(200); expect(await legacy.json()).toMatchObject({ data: { items: [] } });
    const privateMcp = await fetch('http://127.0.0.1:15179/mcp', { method: 'POST', headers: { ...external, 'content-type': 'application/json' }, body: JSON.stringify(rpc) });
    expect(privateMcp.status).toBe(200); expect((await privateMcp.json()).result.tools.length).toBe(18);
    db = openDatabase(f.dataRoot); const owner = (db.prepare('SELECT id FROM user').get() as any).id;
    const auth = await createAuth(f.config, db);
    const grant = oauthGrantStore(db).approve(owner, 'transport-fixture', ['knowledge:read'], ['00-Inbox']);
    const { token: accessToken } = await auth.api.signJWT({body:{payload:{sub:owner,client_id:grant.clientId,
      iat:Math.floor(Date.now()/1000),scope:'knowledge:read',dk_grant_id:grant.id,dk_grant_version:grant.version,
      iss:f.config.origin+'/api/auth',aud:f.config.origin+'/mcp'}}});
    const oauthResponse = await f.app.inject({method:'POST',url:'/mcp',headers:{...external,host:'localhost:3010',authorization:'Bearer '+accessToken},payload:rpc});
    expect(oauthResponse.statusCode).toBe(200); expect(oauthResponse.json().result.tools.length).toBe(18);
    const deniedOAuthOnTunnel=await fetch('http://127.0.0.1:15179/mcp',{method:'POST',headers:{...external,authorization:'Bearer '+accessToken,'content-type':'application/json'},body:JSON.stringify(rpc)});
    expect(deniedOAuthOnTunnel.status).toBe(401);
    const status = await post('/api/plugins/mcp/call', { kind: 'provider', id: 'mcp.status', input: {} });
    expect(status.statusCode).toBe(200); expect(status.json().connection.oauth.ready).toBe(false);
    const logs = await post('/api/plugins/mcp/call', { kind: 'provider', id: 'mcp.calls', input: {} });
    expect(logs.json().items.some((r: any) => r.tool === 'list_notes')).toBe(true);
    expect(JSON.stringify(logs.json())).not.toContain(token);
    await post('/api/platform/plugins/mcp/disable', {});
    await expect(fetch('http://127.0.0.1:15179/health')).rejects.toThrow();
    // Rotate a credential but never use it before resetting the owner in the same second.
    await f.app.inject({ method: 'PUT', url: '/api/platform/plugins/mcp/config', headers,
      payload: { configVersion: 1, values: { tunnelToken: token + '-new' } } });
    await post('/api/platform/plugins/mcp/enable', {});
    await resetOwnerPassword(f.config, testPassword + '-changed');
    const denied = await fetch('http://127.0.0.1:15179/mcp', { method: 'POST', headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer ' + token + '-new',
    }, body: JSON.stringify(rpc) });
    expect(denied.status).toBe(401);
    const login=await f.app.inject({method:'POST',url:'/api/auth/sign-in/username',headers:{origin:f.config.origin},payload:{username:'owner',password:testPassword+'-changed'}});
    const cookie=login.cookies.map(c=>`${c.name}=${c.value}`).join('; ');
    const csrf=await f.app.inject({url:'/api/security/csrf',headers:{cookie}});
    const newHeaders={origin:f.config.origin,cookie:cookie+'; '+csrf.cookies.map(c=>`${c.name}=${c.value}`).join('; '),'x-csrf-token':csrf.json().token};
    const rotated=await f.app.inject({method:'PUT',url:'/api/platform/plugins/mcp/config',headers:newHeaders,payload:{configVersion:2,values:{tunnelToken:token+'-rotated'}}});
    expect(rotated.statusCode).toBe(200);
    const restored=await fetch('http://127.0.0.1:15179/mcp',{method:'POST',headers:{'content-type':'application/json',accept:external.accept,authorization:'Bearer '+token+'-rotated'},body:JSON.stringify(rpc)});
    expect(restored.status).toBe(200); await restored.arrayBuffer();

    expect(grant.active).toBe(true);
  } finally { db?.close(); await f.close(); await rm(artifacts, { recursive: true, force: true }); }
}, 60000);
