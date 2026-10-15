import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '../../shared/contracts.js';
import { initializeOwner } from '../../server/auth.js';
import { openDatabase } from '../../server/db.js';
import { platformRuntime } from '../../server/platform/runtime.js';
import { pluginServices } from '../../server/plugins/services.js';
import { testPassword } from './credentials.js';
export async function pluginRuntimeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'dooknow-plugin-runtime-'));
  const config: AppConfig = { knowledgeRoot: join(root, 'knowledge'), dataRoot: join(root, 'data'),
    origin: 'http://localhost:3010', secret: 'plugin-runtime-test-secret-at-least-thirty-two-characters',
    indexing: { enabled: false, watch: false }, fileTasks: { embedded: true } };
  await mkdir(join(config.knowledgeRoot, '00-Inbox'), { recursive: true });
  await initializeOwner(config, 'owner', testPassword);
  const db = openDatabase(config.dataRoot);
  const owner = (db.prepare('SELECT id FROM user').get() as any).id;
  const principal = { id: owner, clientId: 'mcp-fixture',
    scopes: ['knowledge:read', 'knowledge:write', 'knowledge:index'], allowedPrefixes: ['00-Inbox'] };
  config.agent = { serviceToken: 'fixture-only-service-token', assertionSecret: 'fixture-only-assertion-secret',
    issuer: 'fixture', audience: 'fixture', policies: [principal] };
  const platform = platformRuntime(config, db); await platform.activate();
  const services = pluginServices(platform, db, 'mcp', principal.scopes,
    { ownerId: owner, principal, channel: 'mcp' });
  return { root, config, db, platform, principal, services,
    close: async () => { await platform.close(); db.close(); await rm(root, { recursive: true, force: true }); } };
}
