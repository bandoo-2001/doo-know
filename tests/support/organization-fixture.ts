import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '../../shared/contracts.js';
import type { Principal } from '../../shared/knowledge-contracts.js';
import { openDatabase } from '../../packages/core/db.js';
import { noteService } from '../../packages/core/notes.js';
import { sha256 } from '../../packages/core/knowledge/operations.js';
import { syncDirectoryCatalog, directoryByPath } from '../../packages/core/organization/catalog.js';
export function organizationFixture(embedded = true) {
  const root = mkdtempSync(join(tmpdir(), 'dooknow-organize-')),
    p: Principal = {
      id: 'test-agent',
      clientId: 'test-client',
      scopes: ['knowledge:read', 'knowledge:write', 'knowledge:organize'],
      allowedPrefixes: ['00-Inbox', 'Topic'],
      knowledgeAll: true,
    } as Principal;
  const config: AppConfig = {
    knowledgeRoot: join(root, 'knowledge'),
    dataRoot: join(root, 'data'),
    secret: 'test-organization-secret-long-enough',
    origin: 'http://localhost',
    fileTasks: { embedded },
    agent: {
      serviceToken: 'test-only',
      assertionSecret: 'test-only',
      issuer: 'test',
      audience: 'test',
      policies: [p],
    },
  };
  mkdirSync(join(config.knowledgeRoot, '00-Inbox'), { recursive: true });
  mkdirSync(join(config.knowledgeRoot, 'Topic'));
  const db = openDatabase(config.dataRoot),
    notes = noteService(config, db);
  function create(path: string, content: string) {
    writeFileSync(join(config.knowledgeRoot, path), content);
    notes.scan();
    syncDirectoryCatalog(config, db);
    const row = db.prepare('SELECT id FROM notes WHERE path=? AND active=1').get(path) as any;
    return {
      noteId: row.id,
      expectedModifiedAt: statSync(join(config.knowledgeRoot, path), {
        bigint: true,
      }).mtimeNs.toString(),
      expectedContentHash: sha256(content),
    };
  }
  return {
    root,
    config,
    db,
    notes,
    p,
    create,
    directory: (path: string) => directoryByPath(db, path)!,
    close() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
