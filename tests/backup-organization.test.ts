import { expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pluginRuntimeFixture } from './support/plugin-runtime.js';
import { backup, restore } from '../apps/server/backup.js';
import {
  currentBlogInstanceId,
  currentToDooInstanceId,
} from '../packages/core/auth/permissions.js';

it('retains organization recovery material and rebinds stable directory identities during verified restore', async () => {
  const f = await pluginRuntimeFixture();
  try {
    const dir = f.db
      .prepare("SELECT id FROM organization_directories WHERE path='00-Inbox' AND active=1")
      .get() as { id: string };
    const blogInstance = currentBlogInstanceId(f.db);
    const toDooInstance = currentToDooInstanceId(f.db);
    await f.platform.close();
    const retained = join(f.config.dataRoot, 'organization', 'retained-job');
    await mkdir(retained, { recursive: true });
    await writeFile(join(retained, 'original.before'), 'before body\n');
    const destination = join(f.root, 'backup');
    await backup(f.config, destination);
    expect(
      await readFile(join(destination, 'data/organization/retained-job/original.before'), 'utf8'),
    ).toBe('before body\n');
    const restored = {
      ...f.config,
      dataRoot: join(f.root, 'restored-data'),
      knowledgeRoot: join(f.root, 'restored-knowledge'),
    };
    await restore(destination, restored);
    const { openDatabase } = await import('../packages/core/db.js');
    const db = openDatabase(restored.dataRoot);
    try {
      expect(currentBlogInstanceId(db)).toBe(blogInstance);
      expect(currentToDooInstanceId(db)).toBe(toDooInstance);
      const found = db
        .prepare("SELECT id FROM organization_directories WHERE path='00-Inbox' AND active=1")
        .get() as { id: string };
      expect(found.id).toBe(dir.id);
      const { syncDirectoryCatalog } = await import('../packages/core/organization/catalog.js');
      expect(() => syncDirectoryCatalog(restored, db)).not.toThrow();
      expect(
        (
          db
            .prepare("SELECT id FROM organization_directories WHERE path='00-Inbox' AND active=1")
            .get() as any
        ).id,
      ).toBe(dir.id);
    } finally {
      db.close();
    }
  } finally {
    await f.close();
  }
});
