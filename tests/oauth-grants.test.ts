import { it, expect } from 'vitest';
import { createFixture, loginFixtureOwner } from './support/fixture.js';
import { openDatabase } from '../server/db.js';
import { oauthGrantStore } from '../server/platform/oauth-grants.js';
import { resetOwnerPassword } from '../server/auth.js';
it('binds an immutable grant version to an authorization and rejects old refresh references after reconsent', async () => {
  const f = await createFixture(); const db = openDatabase(f.dataRoot);
  try {
    await loginFixtureOwner(f); const owner = (db.prepare('SELECT id FROM user').get() as any).id;
    const grants = oauthGrantStore(db);
    const first = grants.approve(owner, 'client', ['knowledge:read'], ['00-Inbox']);
    expect(grants.requireExact(first.reference, owner, 'client', ['knowledge:read']).allowedPrefixes).toEqual(['00-Inbox']);
    expect(() => grants.requireExact(first.reference, owner, 'other-client', ['knowledge:read'])).toThrow();
    expect(() => grants.requireExact(first.reference, owner, 'client', ['knowledge:write'])).toThrow();
    grants.revoke(owner, 'client');
    const renewed = grants.approve(owner, 'client', ['knowledge:read', 'knowledge:write'], ['00-Inbox']);
    expect(renewed.reference).not.toBe(first.reference);
    expect(() => grants.requireExact(first.reference, owner, 'client', ['knowledge:read'])).toThrow();
    expect(grants.requireExact(renewed.reference, owner, 'client', ['knowledge:write']).scopes).toContain('knowledge:write');
  } finally { db.close(); await f.close(); }
});

it('password reset invalidates authorization versions as well as browser sessions', async () => {
  const f = await createFixture(); const db = openDatabase(f.dataRoot);
  try {
    await loginFixtureOwner(f); const owner = (db.prepare('SELECT id FROM user').get() as any).id;
    const grants = oauthGrantStore(db), previous = grants.approve(owner, 'reset-client', ['knowledge:read'], ['00-Inbox']);
    await resetOwnerPassword(f.config, 'replacement-fixture-password-only');
    expect(() => grants.requireExact(previous.reference, owner, 'reset-client', ['knowledge:read'])).toThrow();
    expect(grants.activeReference(owner, 'reset-client')).toBeUndefined();
  } finally { db.close(); await f.close(); }
});
