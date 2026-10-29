import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from '../../../shared/contracts.js';
import type { AppDatabase } from '../db.js';
import { safePath } from '../files.js';
import { fail } from '../knowledge/errors.js';
import { migrateOrganization, organizationPending } from './schema.js';
import { evidence, type OrganizationManifest } from './plan.js';
import { outputInventory } from './journal.js';
/** Only the verified, checksum-validated backup restore boundary may adopt copied identities. */
export function rebindRestoredOrganization(config: AppConfig, db: AppDatabase) {
  migrateOrganization(db);
  if (organizationPending(db)) fail(409, 'ORGANIZATION_RECOVERY_REQUIRED');
  const library = db.prepare('SELECT * FROM organization_library WHERE id=1').get() as any;
  if (!library) return;
  const root = lstatSync(config.knowledgeRoot, { bigint: true });
  if (!root.isDirectory() || root.isSymbolicLink()) fail(409, 'LIBRARY_BINDING_CHANGED');
  const bindingVersion = library.binding_version + 1;
  db.transaction(() => {
    for (const row of db
      .prepare('SELECT id,path FROM organization_directories WHERE active=1')
      .all() as any[]) {
      let s;
      try {
        s = lstatSync(safePath(config.knowledgeRoot, row.path, 'folder'), { bigint: true });
      } catch {
        db.prepare('UPDATE organization_directories SET active=0 WHERE id=?').run(row.id);
        continue;
      }
      if (!s.isDirectory() || s.isSymbolicLink()) fail(409, 'LIBRARY_BINDING_CHANGED');
      db.prepare('UPDATE organization_directories SET dev=?,ino=?,birthtime_ns=? WHERE id=?').run(
        String(s.dev),
        String(s.ino),
        String(s.birthtimeNs),
        row.id,
      );
    }
    db.prepare(
      "UPDATE organization_library SET root_identity=?,binding_version=?,inventory_hash='' WHERE id=1",
    ).run(
      JSON.stringify({
        path: realpathSync(config.knowledgeRoot),
        dev: String(root.dev),
        ino: String(root.ino),
      }),
      bindingVersion,
    );
    db.prepare(
      "UPDATE operations SET status='failed',error='RESTORED_ORGANIZATION_REQUIRES_AUTHORIZATION' WHERE id IN (SELECT id FROM organization_jobs WHERE status IN ('queued','running'))",
    ).run();
    db.prepare(
      "UPDATE organization_jobs SET status='failed',error='RESTORED_ORGANIZATION_REQUIRES_AUTHORIZATION',owner_pid=NULL,owner_start=NULL WHERE status IN ('queued','running')",
    ).run();
    for (const row of db
      .prepare("SELECT id,manifest FROM organization_jobs WHERE status='succeeded' AND cleaned=0")
      .all() as any[]) {
      try {
        const m = JSON.parse(row.manifest) as OrganizationManifest;
        if (
          !m.outputContentInventory ||
          m.outputContentInventory !== outputInventory(config, m, true)
        )
          throw Error('outputs changed');
        for (const o of m.objects) {
          if (o.kind === 'file')
            o.published = evidence(join(config.knowledgeRoot, o.to), o.afterHash);
          else if (o.kind === 'directory') o.published = evidence(join(config.knowledgeRoot, o.to));
        }
        m.bindingVersion = bindingVersion;
        m.outputInventory = outputInventory(config, m);
        db.prepare('UPDATE organization_jobs SET manifest=? WHERE id=?').run(
          JSON.stringify(m),
          row.id,
        );
      } catch {
        db.prepare('UPDATE organization_jobs SET cleaned=1,expires_at=0 WHERE id=?').run(row.id);
      }
    }
  }).immediate();
}
