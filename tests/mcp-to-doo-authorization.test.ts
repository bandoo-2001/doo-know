import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../packages/core/db';
import { platformPolicy } from '../packages/core/auth/grants';
import { oauthGrantStore } from '../apps/server/platform/oauth-grants';

it('requires explicit task access and writable policy without widening old grants', async () => {
  const root = await mkdtemp(join(tmpdir(), 'to-doo-grants-'));
  const db = openDatabase(root);
  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS user(id TEXT PRIMARY KEY); INSERT INTO user(id) VALUES('fixture-owner'); CREATE TABLE platform_plugins(id TEXT PRIMARY KEY,installed INTEGER,state TEXT,config_json TEXT)",
    );
    db.prepare("INSERT INTO platform_plugins VALUES('mcp',1,'enabled','{}')").run();
    const store = oauthGrantStore(db);
    const grant = store.approve(
      'fixture-owner',
      'new-todo-client',
      ['to-doo:read', 'to-doo:write'],
      ['00-Inbox'],
    );
    const p = {
      id: 'fixture-owner',
      clientId: grant.clientId,
      scopes: grant.scopes,
      allowedPrefixes: grant.allowedPrefixes,
      grantId: grant.id,
      grantVersion: grant.version,
      tokenIssuedAt: grant.notBefore,
      pluginId: 'mcp',
    };
    const policy = (value: Record<string, unknown>) => {
      db.prepare("UPDATE platform_plugins SET config_json=? WHERE id='mcp'").run(
        JSON.stringify({ allowedPrefixes: ['00-Inbox'], ...value }),
      );
      return platformPolicy(db, p)?.scopes || [];
    };
    expect(policy({ readOnly: false })).not.toContain('to-doo:read');
    expect(policy({ readOnly: true, allowToDoo: true, allowToDooWrite: true })).toContain(
      'to-doo:read',
    );
    expect(policy({ readOnly: true, allowToDoo: true, allowToDooWrite: true })).not.toContain(
      'to-doo:write',
    );
    expect(policy({ readOnly: false, allowToDoo: true, allowToDooWrite: false })).not.toContain(
      'to-doo:write',
    );
    expect(policy({ readOnly: false, allowToDoo: true, allowToDooWrite: true })).toContain(
      'to-doo:write',
    );
    const old = store.approve(
      'fixture-owner',
      'old-knowledge-client',
      ['knowledge:read', 'knowledge:write'],
      ['00-Inbox'],
    );
    expect(
      platformPolicy(db, {
        ...p,
        clientId: old.clientId,
        scopes: old.scopes,
        grantId: old.id,
        grantVersion: old.version,
      })?.scopes,
    ).not.toContain('to-doo:read');
    expect(store.approve('fixture-owner', 'tasks-only-client', ['to-doo:read'], []).allowedPrefixes).toEqual([]);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
