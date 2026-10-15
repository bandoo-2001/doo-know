import { it, expect, vi } from 'vitest';
import { writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture } from '../support/fixture.js';
import { loadConfig } from '../../apps/server/config.js';
it('loads machine credentials from private external files and rejects unsafe policy permissions', async () => {
  const f = await createFixture();
  try {
    const authFile = join(f.root, 'auth.key'),
      tokenFile = join(f.root, 'agent.token'),
      keyFile = join(f.root, 'assertion.key'),
      policy = join(f.root, 'agent.json');
    await writeFile(authFile, 'fixture-auth-at-least-thirty-two-characters', { mode: 0o600 });
    await writeFile(tokenFile, 'fixture-service-at-least-thirty-two-characters', { mode: 0o600 });
    await writeFile(keyFile, 'fixture-assertion-at-least-thirty-two-characters', { mode: 0o600 });
    await writeFile(
      policy,
      JSON.stringify({
        serviceTokenFile: tokenFile,
        assertionKeyFile: keyFile,
        issuer: 'doo-know-bridge',
        audience: 'doo-know-web',
        policies: [
          {
            id: 'owner',
            clientId: 'client',
            scopes: ['knowledge:read'],
            allowedPrefixes: ['00-Inbox'],
          },
        ],
      }),
      { mode: 0o600 },
    );
    for (const [k, v] of Object.entries({
      KNOWLEDGE_ROOT: f.knowledgeRoot,
      DATA_ROOT: f.dataRoot,
      AUTH_SECRET_FILE: authFile,
      APP_ORIGIN: f.config.origin,
      AGENT_CONFIG_FILE: policy,
    }))
      vi.stubEnv(k, v);
    const config = loadConfig();
    expect(config.agent?.issuer).toBe('doo-know-bridge');
    expect(config.agent?.policies[0].scopes).toEqual(['knowledge:read']);
    await chmod(policy, 0o644);
    expect(() => loadConfig()).toThrow();
  } finally {
    vi.unstubAllEnvs();
    await f.close();
  }
});
