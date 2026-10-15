import type { AppDatabase } from '../db.js';
import type { Principal } from '../../shared/knowledge-contracts.js';
import { categories } from '../files.js';
export function initializeGrants(db: AppDatabase) {
  db.exec(`CREATE TABLE IF NOT EXISTS platform_grants (
    id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,client_id TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,
    version INTEGER NOT NULL DEFAULT 1,scopes_json TEXT NOT NULL,prefixes_json TEXT NOT NULL,
    not_before INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,UNIQUE(owner_id,client_id));`);
}
export function platformPolicy(db: AppDatabase, p: Principal): Principal | undefined {
  if (p.clientId.startsWith('plugin-web:')) {
    const id = p.clientId.slice('plugin-web:'.length);
    if (db.prepare('SELECT id FROM user WHERE id=?').get(p.id)
      && db.prepare("SELECT id FROM platform_plugins WHERE id=? AND installed=1 AND state='enabled'").get(id))
      return { ...p, scopes: ['knowledge:read', 'knowledge:write', 'knowledge:index'], allowedPrefixes: ['README.md', ...categories] };
    return;
  }
  if (!p.grantId) return;
  initializeGrants(db);
  const grant = db.prepare('SELECT * FROM platform_grants WHERE id=? AND owner_id=? AND client_id=? AND active=1')
    .get(p.grantId, p.id, p.clientId) as any;
  if (!grant || grant.version !== p.grantVersion || (p.tokenIssuedAt ?? 0) < grant.not_before) return;
  let scopes: string[] = JSON.parse(grant.scopes_json), prefixes: string[] = JSON.parse(grant.prefixes_json);
  if (p.pluginId) {
    const plugin = db.prepare("SELECT config_json FROM platform_plugins WHERE id=? AND installed=1 AND state='enabled'").get(p.pluginId) as any;
    if (!plugin) return;
    if (p.pluginId === 'mcp') {
      const c = JSON.parse(plugin.config_json);
      scopes = scopes.filter(s => (s !== 'knowledge:write' || c.readOnly === false) && (s !== 'knowledge:index' || c.allowIndex === true));
      const allowed: string[] = c.allowedPrefixes || ['README.md', ...categories];
      prefixes = prefixes.flatMap(a => allowed.flatMap(b => a === b || a.startsWith(b + '/') ? [a] : b.startsWith(a + '/') ? [b] : []));
    }
  }
  return { ...p, scopes, allowedPrefixes: [...new Set(prefixes)] };
}
