import { afterEach, expect, it } from 'vitest';
import { cpSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { organizationFixture } from './support/organization-fixture.js';
import { organizationService } from '../packages/core/organization/service.js';
import { openDatabase } from '../packages/core/db.js';
import {
  rebindRestoredOrganization,
  syncDirectoryCatalog,
  directoryByPath,
} from '../packages/core/organization/catalog.js';
const closes: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closes.length) await closes.pop()!();
});
it('adopts copied directory evidence only at verified restore and preserves valid undo', async () => {
  const f = organizationFixture(),
    s = organizationService(f.config, f.db, f.notes);
  closes.push(async () => {
    await s.close();
    f.close();
  });
  const n = f.create('00-Inbox/a.md', '# a'),
    context = s.context(f.p),
    original = f.directory('Topic').id,
    r = await s.submit(f.p, {
      libraryId: context.libraryId,
      expectedStructureRevision: context.structureRevision,
      requestId: 'move',
      actions: [{ type: 'move_note', ...n, toDirectoryId: original, fileName: 'a.md' }],
    });
  await s.drain();
  const knowledgeRoot = join(f.root, 'copy-knowledge'),
    dataRoot = join(f.root, 'copy-data');
  cpSync(f.config.knowledgeRoot, knowledgeRoot, { recursive: true });
  mkdirSync(dataRoot);
  await f.db.backup(join(dataRoot, 'app.sqlite'));
  cpSync(join(f.config.dataRoot, 'organization'), join(dataRoot, 'organization'), {
    recursive: true,
  });
  const config = { ...f.config, knowledgeRoot, dataRoot },
    db = openDatabase(dataRoot);
  try {
    expect(() => syncDirectoryCatalog(config, db)).toThrow();
    rebindRestoredOrganization(config, db);
    syncDirectoryCatalog(config, db);
    expect(directoryByPath(db, 'Topic')?.id).toBe(original);
    const row = db
      .prepare('SELECT cleaned,manifest FROM organization_jobs WHERE id=?')
      .get(r.operation.operationId) as any;
    expect(row.cleaned).toBe(0);
    expect(JSON.parse(row.manifest).bindingVersion).toBe(2);
  } finally {
    db.close();
  }
});
it('invalidates undo rather than adopting modified restored outputs', async () => {
  const f = organizationFixture(),
    s = organizationService(f.config, f.db, f.notes);
  closes.push(async () => {
    await s.close();
    f.close();
  });
  const n = f.create('00-Inbox/a.md', '# a'),
    c = s.context(f.p),
    r = await s.submit(f.p, {
      libraryId: c.libraryId,
      expectedStructureRevision: c.structureRevision,
      requestId: 'move',
      actions: [
        { type: 'move_note', ...n, toDirectoryId: f.directory('Topic').id, fileName: 'a.md' },
      ],
    });
  await s.drain();
  writeFileSync(join(f.config.knowledgeRoot, 'Topic/a.md'), '# modified after operation');
  rebindRestoredOrganization(f.config, f.db);
  expect(
    f.db.prepare('SELECT cleaned FROM organization_jobs WHERE id=?').get(r.operation.operationId),
  ).toEqual({ cleaned: 1 });
});
