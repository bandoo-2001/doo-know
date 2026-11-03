import { afterEach, expect, it } from 'vitest';
import { createFixture, loginFixtureOwner } from './support/fixture.js';
import { openDatabase } from '../packages/core/db.js';
import { platformPolicy } from '../packages/core/auth/grants.js';
import { invalidateRemoteAuth } from '../packages/core/auth/remote-auth.js';
import * as keys from '../apps/server/platform/mcp-api-keys.js';
import type { PermissionPolicy } from '../shared/permissions.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function setup() {
  const f = await createFixture();
  const headers = await loginFixtureOwner(f);
  const db = openDatabase(f.dataRoot);
  cleanup.push(async () => {
    db.close();
    await f.close();
  });
  const owner = (db.prepare('SELECT id FROM user').get() as { id: string }).id;
  db.prepare(
    "INSERT INTO platform_plugins(id,installed_version,installed,manifest_json,files_json,state,config_json) VALUES('mcp','1.4.0',1,'{}','{}','enabled',?)",
  ).run(
    JSON.stringify({
      oauthEnabled: true,
      apiKeyEnabled: true,
      readOnly: false,
      allowedPrefixes: ['00-Inbox'],
    }),
  );
  const inventory = await f.app.inject({ url: '/api/platform/mcp/permissions', headers });
  expect(inventory.statusCode).toBe(200);
  const policy: PermissionPolicy = {
    version: 2,
    domains: { knowledge: inventory.json().policy.domains.knowledge },
  };
  db.prepare("UPDATE platform_plugins SET config_json=? WHERE id='mcp'").run(
    JSON.stringify({ oauthEnabled: true, apiKeyEnabled: true, permissionPolicy: policy }),
  );
  const readOnly: PermissionPolicy = structuredClone(policy);
  readOnly.domains.knowledge.actions = ['read'];
  return { f, db, owner, headers, policy, readOnly };
}

it('authenticates valid keys when optional usage bookkeeping meets an active SQLite writer', async () => {
  const { db, owner, f, readOnly } = await setup();
  const made = keys.createMcpApiClient(db, owner, { name: 'Reader', permissionPolicy: readOnly });
  const writer = openDatabase(f.dataRoot);
  db.pragma('busy_timeout = 1');
  writer.exec('BEGIN IMMEDIATE');
  try {
    expect(keys.authenticateMcpApiKey(db, 'Bearer ' + made.key).scopes).toEqual(['knowledge:read']);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(1);
    expect(keys.listMcpApiClients(db, owner)[0].key?.lastUsedAt).toBeNull();
  } finally {
    writer.exec('ROLLBACK');
    writer.close();
  }
  expect(keys.authenticateMcpApiKey(db, 'Bearer ' + made.key).scopes).toEqual(['knowledge:read']);
  expect(keys.listMcpApiClients(db, owner)[0].key?.lastUsedAt).not.toBeNull();
});

it('issues a hashed key once, keeps clients isolated and applies a 90 day default', async () => {
  const { db, owner, readOnly } = await setup();
  const before = Date.now();
  const first = keys.createMcpApiClient(db, owner, { name: 'Desktop', permissionPolicy: readOnly });
  const second = keys.createMcpApiClient(db, owner, {
    name: 'Script',
    permissionPolicy: readOnly,
    expiresAt: null,
  });
  expect(first.key).toMatch(/^dk_mcp_/);
  expect(first.client.key?.expiresAt).not.toBeNull();
  expect(Date.parse(first.client.key!.expiresAt!)).toBeGreaterThanOrEqual(before + 90 * 86400000);
  expect(second.client.key?.expiresAt).toBeNull();
  const a = keys.authenticateMcpApiKey(db, 'Bearer ' + first.key);
  const b = keys.authenticateMcpApiKey(db, 'Bearer ' + second.key);
  expect(a.clientId).not.toBe(b.clientId);
  expect(a.scopes).toEqual(['knowledge:read']);
  expect(a.credentialKind).toBe('api-key');
  expect(JSON.stringify(keys.listMcpApiClients(db, owner))).not.toContain(first.key);
  expect(JSON.stringify(db.prepare('SELECT * FROM mcp_api_keys').all())).not.toContain(first.key);
  expect(() => keys.authenticateMcpApiKey(db, 'Bearer ' + first.key + 'x')).toThrow();
  expect(() =>
    keys.updateMcpApiClient(db, 'another-owner', a.clientId, {
      name: 'Stolen',
      expectedVersion: 1,
    }),
  ).toThrow();
});

it('rejects expired keys at the boundary, malformed expiration and unsupported authority', async () => {
  const { db, owner, readOnly } = await setup();
  for (const expiresAt of ['bad', '2000-01-01T00:00:00Z', 123 as any])
    expect(() =>
      keys.createMcpApiClient(db, owner, { name: 'Bad', permissionPolicy: readOnly, expiresAt }),
    ).toThrow();
  const made = keys.createMcpApiClient(db, owner, {
    name: 'Short',
    permissionPolicy: readOnly,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  });
  const actor = keys.authenticateMcpApiKey(db, 'Bearer ' + made.key);
  db.prepare('UPDATE mcp_api_keys SET expires_at=? WHERE id=?').run(
    Date.now(),
    actor.credentialRef,
  );
  expect(() => keys.authenticateMcpApiKey(db, 'Bearer ' + made.key)).toThrow();
  expect(platformPolicy(db, actor)).toBeUndefined();
  const invalid = structuredClone(readOnly);
  invalid.domains.knowledge.ownerId = 'another-owner';
  expect(() =>
    keys.createMcpApiClient(db, owner, { name: 'Other', permissionPolicy: invalid }),
  ).toThrow();
});

it('rotates atomically, preserves identity and grant, and rejects stale queued actors', async () => {
  const { db, owner, readOnly } = await setup();
  const made = keys.createMcpApiClient(db, owner, { name: 'Desktop', permissionPolicy: readOnly });
  const actor = keys.authenticateMcpApiKey(db, 'Bearer ' + made.key);
  const rotated = keys.rotateMcpApiKey(db, owner, actor.clientId, {
    expectedVersion: made.client.version,
    expiresAt: null,
  });
  const next = keys.authenticateMcpApiKey(db, 'Bearer ' + rotated.key);
  expect(next).toMatchObject({
    id: actor.id,
    clientId: actor.clientId,
    grantId: actor.grantId,
    grantVersion: actor.grantVersion,
  });
  expect(next.credentialRef).not.toBe(actor.credentialRef);
  expect(() => keys.authenticateMcpApiKey(db, 'Bearer ' + made.key)).toThrow();
  expect(platformPolicy(db, actor)).toBeUndefined();
  expect(platformPolicy(db, next)?.scopes).toEqual(['knowledge:read']);
  expect(() =>
    keys.rotateMcpApiKey(db, owner, actor.clientId, { expectedVersion: made.client.version }),
  ).toThrow();
});

it('requires explicit reauthorization after global invalidation without reviving revoked clients', async () => {
  const { db, owner, readOnly } = await setup();
  const made = keys.createMcpApiClient(db, owner, {
    name: 'Forever',
    permissionPolicy: readOnly,
    expiresAt: null,
  });
  const revoked = keys.createMcpApiClient(db, owner, {
    name: 'Revoked',
    permissionPolicy: readOnly,
  });
  keys.revokeMcpApiClient(db, owner, revoked.client.clientId);
  const actor = keys.authenticateMcpApiKey(db, 'Bearer ' + made.key);
  db.transaction(() => invalidateRemoteAuth(db))();
  expect(() => keys.authenticateMcpApiKey(db, 'Bearer ' + made.key)).toThrow();
  expect(platformPolicy(db, actor)).toBeUndefined();
  const client = keys.listMcpApiClients(db, owner).find((x) => x.clientId === actor.clientId)!;
  expect(client.status).toBe('requires_reauthorization');
  expect(() =>
    keys.rotateMcpApiKey(db, owner, actor.clientId, { expectedVersion: client.version }),
  ).toThrow();
  const restored = keys.reauthorizeMcpApiClient(db, owner, actor.clientId, {
    permissionPolicy: readOnly,
    expiresAt: null,
    expectedVersion: client.version,
    expectedGrantVersion: client.grantVersion,
  });
  expect(keys.authenticateMcpApiKey(db, 'Bearer ' + restored.key)).toMatchObject({
    clientId: actor.clientId,
    id: actor.id,
  });
  const denied = keys
    .listMcpApiClients(db, owner)
    .find((x) => x.clientId === revoked.client.clientId)!;
  expect(denied.status).toBe('revoked');
  expect(() =>
    keys.reauthorizeMcpApiClient(db, owner, denied.clientId, {
      permissionPolicy: readOnly,
      expectedVersion: denied.version,
      expectedGrantVersion: denied.grantVersion,
    }),
  ).toThrow();
});

it('never widens an existing grant when service ceiling grows and applies reductions immediately', async () => {
  const { db, owner, policy, readOnly } = await setup();
  const made = keys.createMcpApiClient(db, owner, { name: 'Read', permissionPolicy: readOnly });
  const actor = keys.authenticateMcpApiKey(db, 'Bearer ' + made.key);
  expect(actor.scopes).not.toContain('knowledge:write');
  const edited = keys.setMcpApiClientPermissions(db, owner, actor.clientId, {
    permissionPolicy: policy,
    expectedGrantVersion: made.client.grantVersion,
  });
  expect(edited.grantVersion).toBeGreaterThan(made.client.grantVersion);
  expect(platformPolicy(db, actor)).toBeUndefined();
  const writable = keys.authenticateMcpApiKey(db, 'Bearer ' + made.key);
  expect(writable.scopes).toContain('knowledge:write');
  db.prepare("UPDATE platform_plugins SET config_json=? WHERE id='mcp'").run(
    JSON.stringify({ apiKeyEnabled: true, permissionPolicy: readOnly }),
  );
  expect(platformPolicy(db, writable)?.scopes).toEqual(['knowledge:read']);
  expect(() =>
    keys.setMcpApiClientPermissions(db, owner, actor.clientId, {
      permissionPolicy: policy,
      expectedGrantVersion: edited.grantVersion,
    }),
  ).toThrow();
});

it('keeps management behind owner sessions, CSRF and optimistic versions', async () => {
  const { f, db, headers, owner, readOnly } = await setup();
  const url = '/api/platform/mcp/api-clients';
  expect((await f.app.inject({ url })).statusCode).toBe(401);
  const denied = await f.app.inject({
    method: 'POST',
    url,
    headers: { ...headers, 'x-csrf-token': 'bad' },
    payload: { name: 'Bad', permissionPolicy: readOnly },
  });
  expect(denied.statusCode).toBe(403);
  const created = await f.app.inject({
    method: 'POST',
    url,
    headers,
    payload: { name: 'Web', permissionPolicy: readOnly, expiresAt: null },
  });
  expect(created.statusCode, created.body).toBe(200);
  const made = created.json();
  const external = { authorization: 'Bearer ' + made.key };
  expect((await f.app.inject({ url, headers: external })).statusCode).toBe(401);
  const listing = await f.app.inject({ url, headers });
  expect(listing.json().items).toHaveLength(1);
  expect(listing.body).not.toContain(made.key);
  const updated = await f.app.inject({
    method: 'PATCH',
    url: url + '/' + made.client.clientId,
    headers,
    payload: { name: 'Renamed', expectedVersion: made.client.version },
  });
  expect(updated.statusCode, updated.body).toBe(200);
  const conflict = await f.app.inject({
    method: 'PATCH',
    url: url + '/' + made.client.clientId,
    headers,
    payload: { name: 'Overwrite', expectedVersion: made.client.version },
  });
  expect(conflict.statusCode).toBe(409);
  keys.revokeMcpApiClient(db, owner, made.client.clientId);
  keys.revokeMcpApiClient(db, owner, made.client.clientId);
  expect(() => keys.authenticateMcpApiKey(db, 'Bearer ' + made.key)).toThrow();
});

it('preserves selected directory identity through rename, path replacement and key rotation', async () => {
  const { db, owner, f, readOnly } = await setup();
  const { rename, mkdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { syncDirectoryCatalog } = await import('../packages/core/organization/catalog.js');
  const { canAccessPath } = await import('../packages/core/auth/permissions.js');
  const made = keys.createMcpApiClient(db, owner, { name: 'Selected', permissionPolicy: readOnly });
  await rename(join(f.knowledgeRoot, '00-Inbox'), join(f.knowledgeRoot, 'Renamed'));
  await mkdir(join(f.knowledgeRoot, '00-Inbox'));
  syncDirectoryCatalog(f.config as any, db);
  const rotated = keys.rotateMcpApiKey(db, owner, made.client.clientId, {
    expectedVersion: made.client.version,
  });
  const actor = keys.authenticateMcpApiKey(db, 'Bearer ' + rotated.key);
  expect(actor.allowedPrefixes).toEqual(['Renamed']);
  expect(canAccessPath(actor, 'Renamed/note.md')).toBe(true);
  expect(canAccessPath(actor, '00-Inbox/replacement.md')).toBe(false);
});

it('makes new keys usable under the default permission ceiling without silently widening it', async () => {
  const { db, owner, readOnly } = await setup();
  db.prepare("UPDATE platform_plugins SET config_json=? WHERE id='mcp'").run(
    JSON.stringify({ apiKeyEnabled: true, readOnly: true, allowedPrefixes: ['00-Inbox'] }),
  );
  const made = keys.createMcpApiClient(db, owner, { name: 'Default', permissionPolicy: readOnly });
  expect(keys.authenticateMcpApiKey(db, 'Bearer ' + made.key).scopes).toEqual(['knowledge:read']);
  db.prepare("UPDATE platform_plugins SET config_json=? WHERE id='mcp'").run(
    JSON.stringify({ apiKeyEnabled: true, readOnly: false, allowedPrefixes: ['00-Inbox'] }),
  );
  expect(keys.authenticateMcpApiKey(db, 'Bearer ' + made.key).scopes).toEqual(['knowledge:read']);
});

it('records credential management actions without storing the issued secret in audit events', async () => {
  const { db, owner, readOnly } = await setup();
  const made = keys.createMcpApiClient(db, owner, { name: 'Audited', permissionPolicy: readOnly });
  const rotated = keys.rotateMcpApiKey(db, owner, made.client.clientId, {
    expectedVersion: made.client.version,
  });
  keys.revokeMcpApiClient(db, owner, made.client.clientId);
  const events = db
    .prepare('SELECT action,client_id,key_id FROM mcp_api_events WHERE owner_id=? ORDER BY rowid')
    .all(owner);
  expect(events).toEqual([
    { action: 'created', client_id: made.client.clientId, key_id: made.client.key!.id },
    { action: 'rotated', client_id: made.client.clientId, key_id: rotated.client.key!.id },
    { action: 'revoked', client_id: made.client.clientId, key_id: rotated.client.key!.id },
  ]);
  expect(JSON.stringify(db.prepare('SELECT * FROM mcp_api_events').all())).not.toContain(made.key);
  expect(JSON.stringify(db.prepare('SELECT * FROM mcp_api_events').all())).not.toContain(
    rotated.key,
  );
});

it('keeps the owner permission inventory aligned with stable default selections after path replacement', async () => {
  const { db, owner, f, headers, readOnly } = await setup();
  const { rename, mkdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { syncDirectoryCatalog } = await import('../packages/core/organization/catalog.js');
  db.prepare("UPDATE platform_plugins SET config_json=? WHERE id='mcp'").run(JSON.stringify({apiKeyEnabled:true,readOnly:true,allowedPrefixes:['00-Inbox']}));
  keys.createMcpApiClient(db, owner, {name:'First',permissionPolicy:readOnly});
  await rename(join(f.knowledgeRoot,'00-Inbox'), join(f.knowledgeRoot,'Renamed'));
  await mkdir(join(f.knowledgeRoot,'00-Inbox'));
  syncDirectoryCatalog(f.config as any,db);
  const inventory = await f.app.inject({url:'/api/platform/mcp/permissions',headers});
  expect(inventory.json().policy.domains.knowledge.resources).toEqual(readOnly.domains.knowledge.resources);
  const issued = await f.app.inject({method:'POST',url:'/api/platform/mcp/api-clients',headers,payload:{name:'Second',permissionPolicy:{version:2,domains:{knowledge:inventory.json().policy.domains.knowledge}}}});
  expect(issued.statusCode,issued.body).toBe(200);
  expect(keys.authenticateMcpApiKey(db,'Bearer '+issued.json().key).allowedPrefixes).toEqual(['Renamed']);
});
