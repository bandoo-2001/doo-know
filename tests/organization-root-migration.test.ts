import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { organizationFixture } from './support/organization-fixture.js';
import { organizationService } from '../packages/core/organization/service.js';
import { renameRootInPlace } from '../apps/server/platform/root-migration.js';

it('preserves a completed move journal and can undo it after an offline root rename', async () => {
  const f = organizationFixture();
  let service = organizationService(f.config, f.db, f.notes);
  try {
    const note = f.create('00-Inbox/keep.md', '# Preserve bytes\r\n');
    const context = service.context(f.p);
    const submitted = await service.submit(f.p, {
      requestId: 'before-root-rename',
      libraryId: context.libraryId,
      expectedStructureRevision: context.structureRevision,
      actions: [
        {
          type: 'move_note',
          ...note,
          toDirectoryId: f.directory('Topic').id,
          fileName: 'moved.md',
        },
      ],
    });
    await service.drain();
    expect(service.operation(f.p, { operationId: submitted.operation.operationId }).status).toBe(
      'succeeded',
    );
    await service.close();
    const identity = (
      f.db.prepare("SELECT value FROM index_meta WHERE key='root_identity'").get() as any
    ).value;
    const target = join(f.root, 'renamed-knowledge');
    renameRootInPlace(f.db, {
      oldRoot: f.config.knowledgeRoot,
      newRoot: target,
      expectedIdentity: identity,
    });
    f.config.knowledgeRoot = target;
    service = organizationService(f.config, f.db, f.notes);
    await service.recover();
    const undo = await service.undo(f.p, {
      operationId: submitted.operation.operationId,
      requestId: 'after-root-rename',
    });
    await service.drain();
    expect(service.operation(f.p, { operationId: undo.operation.operationId }).status).toBe(
      'succeeded',
    );
    expect(f.notes.row(note.noteId).path).toBe('00-Inbox/keep.md');
    expect(readFileSync(join(target, '00-Inbox/keep.md'), 'utf8')).toBe('# Preserve bytes\r\n');
  } finally {
    await service.close();
    f.close();
  }
});
