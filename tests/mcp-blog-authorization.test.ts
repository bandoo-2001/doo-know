import { expect, it } from 'vitest';
import { pluginRuntimeFixture } from './support/plugin-runtime.js';
import { oauthGrantStore } from '../apps/server/platform/oauth-grants.js';
import { platformPolicy } from '../packages/core/auth/grants.js';
import { tunnelPrincipal } from '../apps/server/platform/tunnel-identity.js';
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

it('gives Tunnel publication permission only after explicit allowPublish with writable access', async () => {
  const f = await pluginRuntimeFixture();
  pluginHost(f.config, f.db);
  try {
    f.db.prepare("INSERT INTO platform_plugins(id,installed_version,installed,manifest_json,files_json,state,config_json) VALUES('mcp','1.1.0',1,'{}','{}','enabled',?)").run(JSON.stringify({ readOnly: false, allowedPrefixes: ['00-Inbox'] }));
    const credential = { reference: 'fixture-ref', createdAt: Date.now(), authGeneration: 0 };
    expect(tunnelPrincipal(f.db, f.principal.id, credential).scopes).not.toContain('blog:publish');
    f.db.prepare("UPDATE platform_plugins SET config_json=? WHERE id='mcp'").run(JSON.stringify({ readOnly: false, allowPublish: true, allowedPrefixes: ['00-Inbox'] }));
    expect(tunnelPrincipal(f.db, f.principal.id, credential).scopes).toContain('blog:publish');
    f.db.prepare("UPDATE platform_plugins SET config_json=? WHERE id='mcp'").run(JSON.stringify({ readOnly: true, allowPublish: true, allowedPrefixes: ['00-Inbox'] }));
    expect(tunnelPrincipal(f.db, f.principal.id, credential).scopes).not.toContain('blog:publish');
  } finally { await f.close(); }
});

it('rejects an admitted actor once its token expires before a later authorization check', async () => {
  const f = await pluginRuntimeFixture();
  try {
    const p = { ...f.principal, tokenExpiresAt: Math.floor(Date.now() / 1000) - 1 };
    expect(() => checkTokenCutoff(f.db, p)).toThrowError();
  } finally { await f.close(); }
});
