import { validateRelative } from './files.js';
import type { AppDatabase } from './db.js';
import { createKnowledgeDataDomain } from './knowledge-data.js';
import { ASSET_ALIASES_FILE, type StorageAssetAlias } from './storage-asset-aliases.js';
import { DOO_ASSETS_DIRECTORY } from '../../shared/storage-paths.js';

type Alias = StorageAssetAlias & { assetId?: string };
type State = { version: 1; aliases: Alias[] };
/** Keep legacy references following stable asset identities through later folder moves/restores. */
export function storageAssetAliasState(config: { knowledgeRoot: string }, db: AppDatabase) {
  db.exec(
    'CREATE TABLE IF NOT EXISTS storage_asset_aliases(root TEXT NOT NULL,from_path TEXT NOT NULL,asset_id TEXT,target_path TEXT NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(root,from_path))',
  );
  const root = config.knowledgeRoot;
  const domain = createKnowledgeDataDomain<State>(config, db, ASSET_ALIASES_FILE, {
    tables: ['storage_asset_aliases', 'assets'],
    rows: { storage_asset_aliases: { column: 'root', value: root } },
    read(root) {
      const rows = db
        .prepare(
          'SELECT x.from_path,x.target_path,x.asset_id,x.hash,a.path AS current_path FROM storage_asset_aliases x LEFT JOIN assets a ON a.id=x.asset_id WHERE x.root=? ORDER BY x.from_path',
        )
        .all(root) as {
        from_path: string;
        target_path: string;
        asset_id: string | null;
        hash: string;
        current_path: string | null;
      }[];
      return {
        version: 1,
        aliases: rows.map((row) => ({
          from: row.from_path,
          to: row.current_path || row.target_path,
          sha256: row.hash,
          ...(row.asset_id ? { assetId: row.asset_id } : {}),
        })),
      };
    },
    validate(value) {
      const state = value as State;
      if (!state || state.version !== 1 || !Array.isArray(state.aliases))
        throw Error('资源迁移映射无效');
      const seen = new Set<string>();
      for (const entry of state.aliases) {
        const relative = (path: string) =>
          typeof path === 'string' &&
          path
            .split('/')
            .every(
              (part) =>
                !!part &&
                part !== '.' &&
                part !== '..' &&
                !part.startsWith('.') &&
                !/[\\\x00-\x1f]/.test(part),
            );
        if (
          !entry ||
          !relative(entry.from) ||
          !relative(entry.to) ||
          !entry.from.split('/').includes('assets') ||
          !entry.to.split('/').includes(DOO_ASSETS_DIRECTORY) ||
          !/^([a-f0-9]{64})$/.test(entry.sha256) ||
          seen.has(entry.from) ||
          (entry.assetId !== undefined &&
            (typeof entry.assetId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(entry.assetId)))
        )
          throw Error('资源迁移映射无效');
        validateRelative(entry.from, 'asset');
        validateRelative(entry.to, 'asset');
        seen.add(entry.from);
      }
      return state;
    },
    write(state, root) {
      db.prepare('DELETE FROM storage_asset_aliases WHERE root=?').run(root);
      const insert = db.prepare('INSERT INTO storage_asset_aliases VALUES(?,?,?,?,?)');
      for (const entry of state.aliases) {
        let identity = entry.assetId;
        if (identity) {
          const existing = db.prepare('SELECT id FROM assets WHERE path=?').get(entry.to) as
            | { id: string }
            | undefined;
          if (existing) identity = existing.id;
          else if (!db.prepare('SELECT 1 FROM assets WHERE id=?').get(identity))
            db.prepare('INSERT INTO assets(id,path) VALUES(?,?)').run(identity, entry.to);
        }
        insert.run(root, entry.from, identity || null, entry.to, entry.sha256);
      }
    },
  });
  domain.refresh();
  return domain;
}
