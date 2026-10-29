import { afterEach, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { organizationFixture } from './support/organization-fixture.js';
import { organizationService } from '../packages/core/organization/service.js';
import { organizationPending } from '../packages/core/organization/schema.js';
import { assertOrganizationReadable } from '../packages/core/workspace/gate.js';
const closes: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closes.length) await closes.pop()!();
});
for (const point of ['publish', 'source_removed', 'metadata'])
  it(`recovers a real worker process exit at ${point} with one stable note identity`, async () => {
    const f = organizationFixture(),
      s = organizationService(f.config, f.db, f.notes);
    closes.push(async () => {
      await s.close();
      f.close();
    });
    const n = f.create('00-Inbox/a.md', '# source'),
      c = s.context(f.p),
      input = {
        libraryId: c.libraryId,
        expectedStructureRevision: c.structureRevision,
        requestId: point,
        actions: [
          { type: 'move_note', ...n, toDirectoryId: f.directory('Topic').id, fileName: 'moved.md' },
        ],
      };
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'tests/support/organization-crash-child.ts',
        JSON.stringify(f.config),
        JSON.stringify(input),
        point,
      ],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    expect(child.status, child.stderr).toBe(91);
    expect(organizationPending(f.db)).toBe(true);
    expect(() => assertOrganizationReadable(f.db)).toThrow();
    await s.recover();
    await s.drain();
    expect(s.operation(f.p, { requestId: point })).toMatchObject({ status: 'succeeded' });
    expect(f.notes.row(n.noteId).path).toBe('Topic/moved.md');
    expect(readFileSync(join(f.config.knowledgeRoot, 'Topic/moved.md'), 'utf8')).toBe('# source');
    expect(existsSync(join(f.config.knowledgeRoot, '00-Inbox/a.md'))).toBe(false);
    expect(f.db.prepare('SELECT count(*) AS n FROM notes WHERE active=1').get()).toEqual({ n: 1 });
    expect(organizationPending(f.db)).toBe(false);
  });
it('preserves conflicting external destination and all originals after a crashed publication', async () => {
  const f = organizationFixture(),
    s = organizationService(f.config, f.db, f.notes);
  closes.push(async () => {
    await s.close();
    f.close();
  });
  const n = f.create('00-Inbox/a.md', '# source'),
    c = s.context(f.p),
    input = {
      libraryId: c.libraryId,
      expectedStructureRevision: c.structureRevision,
      requestId: 'conflict',
      actions: [
        { type: 'move_note', ...n, toDirectoryId: f.directory('Topic').id, fileName: 'moved.md' },
      ],
    };
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      'tests/support/organization-crash-child.ts',
      JSON.stringify(f.config),
      JSON.stringify(input),
      'publish',
    ],
    { encoding: 'utf8' },
  );
  expect(child.status, child.stderr).toBe(91);
  writeFileSync(join(f.config.knowledgeRoot, 'Topic/moved.md'), '# external');
  await s.recover();
  expect(s.operation(f.p, { requestId: 'conflict' })).toMatchObject({
    status: 'needs_reconciliation',
  });
  expect(readFileSync(join(f.config.knowledgeRoot, 'Topic/moved.md'), 'utf8')).toBe('# external');
  expect(readFileSync(join(f.config.knowledgeRoot, '00-Inbox/a.md'), 'utf8')).toBe('# source');
  expect(organizationPending(f.db)).toBe(true);
});
it('refuses to adopt an unproven directory after process exit between mkdir and evidence persistence', async () => {
  const f = organizationFixture(),
    s = organizationService(f.config, f.db, f.notes);
  closes.push(async () => {
    await s.close();
    f.close();
  });
  const c = s.context(f.p),
    input = {
      libraryId: c.libraryId,
      expectedStructureRevision: c.structureRevision,
      requestId: 'unproven',
      actions: [{ type: 'create_directory', parentId: f.directory('Topic').id, name: 'Moved' }],
    };
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      'tests/support/organization-crash-child.ts',
      JSON.stringify(f.config),
      JSON.stringify(input),
      'directory_unproven',
    ],
    { encoding: 'utf8' },
  );
  expect(child.status, child.stderr).toBe(91);
  await s.recover();
  expect(s.operation(f.p, { requestId: 'unproven' })).toMatchObject({
    status: 'needs_reconciliation',
    error: { code: 'ORGANIZATION_EVIDENCE_CONFLICT' },
  });
  expect(existsSync(join(f.config.knowledgeRoot, 'Topic/Moved'))).toBe(true);
  expect(organizationPending(f.db)).toBe(true);
});

it('requeues a crashed preparation after removing its partial object journal', async () => {
  const f = organizationFixture(),
    s = organizationService(f.config, f.db, f.notes);
  closes.push(async () => {
    await s.close();
    f.close();
  });
  const n = f.create('00-Inbox/a.md', '# source');
  f.create('00-Inbox/b.md', '[source](a.md)');
  const c = s.context(f.p),
    input = {
      libraryId: c.libraryId,
      expectedStructureRevision: c.structureRevision,
      requestId: 'stage-copy',
      actions: [
        { type: 'move_note', ...n, toDirectoryId: f.directory('Topic').id, fileName: 'moved.md' },
      ],
    };
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      'tests/support/organization-crash-child.ts',
      JSON.stringify(f.config),
      JSON.stringify(input),
      'stage_copy',
    ],
    { encoding: 'utf8' },
  );
  expect(child.status, child.stderr).toBe(91);
  expect(f.db.prepare('SELECT count(*) AS n FROM organization_objects').get()).toEqual({ n: 1 });
  await s.recover();
  await s.drain();
  expect(s.operation(f.p, { requestId: 'stage-copy' })).toMatchObject({ status: 'succeeded' });
  expect(f.notes.row(n.noteId).path).toBe('Topic/moved.md');
});

it('does not stage an external secret through a raced asset symlink', async () => {
  const f = organizationFixture(),
    s = organizationService(f.config, f.db, f.notes);
  closes.push(async () => {
    await s.close();
    f.close();
  });
  f.create('00-Inbox/a.md', '![asset](assets/a.png)');
  mkdirSync(join(f.config.knowledgeRoot, '00-Inbox/assets'));
  writeFileSync(join(f.config.knowledgeRoot, '00-Inbox/assets/a.png'), 'original asset');
  writeFileSync(join(f.config.dataRoot, 'private.txt'), 'external secret');
  f.db.prepare('INSERT INTO assets(id,path) VALUES(?,?)').run('asset', '00-Inbox/assets/a.png');
  const c = s.context(f.p),
    d = f.directory('00-Inbox'),
    input = {
      libraryId: c.libraryId,
      expectedStructureRevision: c.structureRevision,
      requestId: 'symlink',
      actions: [
        {
          type: 'move_directory',
          directoryId: d.id,
          toDirectoryId: f.directory('Topic').id,
          name: 'Moved',
          expectedSubtreeRevision: d.subtreeRevision,
        },
      ],
    };
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      'tests/support/organization-crash-child.ts',
      JSON.stringify(f.config),
      JSON.stringify(input),
      'symlink',
    ],
    { encoding: 'utf8' },
  );
  expect(child.status, child.stderr).toBe(0);
  expect(existsSync(join(f.config.dataRoot, 'attack-triggered'))).toBe(true);
  expect(s.operation(f.p, { requestId: 'symlink' }).status).toBe('failed');
  expect(existsSync(join(f.config.knowledgeRoot, 'Topic/Moved/assets/a.png'))).toBe(false);
});
it('does not report success when a new external backlink appears during publication', async () => {
  const f = organizationFixture(),
    s = organizationService(f.config, f.db, f.notes);
  closes.push(async () => {
    await s.close();
    f.close();
  });
  const n = f.create('00-Inbox/a.md', '# source'),
    c = s.context(f.p),
    input = {
      libraryId: c.libraryId,
      expectedStructureRevision: c.structureRevision,
      requestId: 'late-link',
      actions: [
        { type: 'move_note', ...n, toDirectoryId: f.directory('Topic').id, fileName: 'moved.md' },
      ],
    };
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      'tests/support/organization-crash-child.ts',
      JSON.stringify(f.config),
      JSON.stringify(input),
      'late_backlink',
    ],
    { encoding: 'utf8' },
  );
  expect(child.status, child.stderr).toBe(0);
  expect(s.operation(f.p, { requestId: 'late-link' }).status).toBe('needs_reconciliation');
  expect(readFileSync(join(f.config.knowledgeRoot, 'Topic/new-incoming.md'), 'utf8')).toBe(
    '[new](../00-Inbox/a.md)',
  );
});

it('rechecks complete graph coverage after staging and rejects new inbound links before committing', async () => {
  const f = organizationFixture(),
    s = organizationService(f.config, f.db, f.notes);
  closes.push(async () => {
    await s.close();
    f.close();
  });
  const n = f.create('00-Inbox/a.md', '# source');
  f.create('Topic/unaffected.md', '# unaffected');
  const c = s.context(f.p),
    input = {
      libraryId: c.libraryId,
      expectedStructureRevision: c.structureRevision,
      requestId: 'stage-link',
      actions: [
        { type: 'move_note', ...n, toDirectoryId: f.directory('Topic').id, fileName: 'moved.md' },
      ],
    };
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      'tests/support/organization-crash-child.ts',
      JSON.stringify(f.config),
      JSON.stringify(input),
      'stage_newlink',
    ],
    { encoding: 'utf8' },
  );
  expect(child.status, child.stderr).toBe(0);
  expect(s.operation(f.p, { requestId: 'stage-link' })).toMatchObject({
    status: 'failed',
    error: { code: 'STRUCTURE_VERSION_CONFLICT' },
  });
  expect(readFileSync(join(f.config.knowledgeRoot, '00-Inbox/a.md'), 'utf8')).toBe('# source');
  expect(existsSync(join(f.config.knowledgeRoot, 'Topic/moved.md'))).toBe(false);
  expect(readFileSync(join(f.config.knowledgeRoot, 'Topic/unaffected.md'), 'utf8')).toBe(
    '[new](../00-Inbox/a.md)',
  );
});
