import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { organizationFixture } from './support/organization-fixture.js';
import { organizationService } from '../packages/core/organization/service.js';
import { syncDirectoryCatalog } from '../packages/core/organization/catalog.js';
import { workspaceWriteSync, assertOrganizationReadable } from '../packages/core/workspace/gate.js';
const closes: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closes.length) await closes.pop()!();
});
function fixture(embedded = true) {
  const f = organizationFixture(embedded),
    s = organizationService(f.config, f.db, f.notes);
  closes.push(async () => {
    await s.close();
    f.close();
  });
  return { ...f, s };
}
async function execute(f: ReturnType<typeof fixture>, actions: any[], requestId = 'organize') {
  const c = f.s.context(f.p);
  const reply = await f.s.submit(f.p, {
    libraryId: c.libraryId,
    expectedStructureRevision: c.structureRevision,
    requestId,
    actions,
  });
  await f.s.drain();
  return f.s.operation(f.p, { operationId: reply.operation.operationId });
}
it('creates an empty directory and replays requestId without repeating the mutation', async () => {
  const f = fixture(),
    c = f.s.context(f.p),
    input = {
      libraryId: c.libraryId,
      expectedStructureRevision: c.structureRevision,
      requestId: 'create',
      actions: [
        { type: 'create_directory' as const, parentId: f.directory('Topic').id, name: 'Empty' },
      ],
    };
  const a = await f.s.submit(f.p, input);
  await f.s.drain();
  expect(f.s.operation(f.p, { operationId: a.operation.operationId }).status).toBe('succeeded');
  expect(existsSync(join(f.config.knowledgeRoot, 'Topic/Empty'))).toBe(true);
  const b = await f.s.submit(f.p, input);
  expect(b.operation.operationId).toBe(a.operation.operationId);
  expect(f.s.list(f.p, { parentId: f.directory('Topic').id }).items[0].name).toBe('Empty');
});
it('moves a note preserving ID and updates incoming/outgoing/shared asset references', async () => {
  const f = fixture(),
    n = f.create('00-Inbox/a.md', '[b](b.md) ![asset](assets/shared.png)'),
    b = f.create('00-Inbox/b.md', '[a](a.md)');
  mkdirSync(join(f.config.knowledgeRoot, '00-Inbox/assets'));
  writeFileSync(join(f.config.knowledgeRoot, '00-Inbox/assets/shared.png'), 'asset');
  const op = await execute(f, [
    { type: 'move_note', ...n, toDirectoryId: f.directory('Topic').id, fileName: 'renamed.md' },
  ]);
  expect(op.status).toBe('succeeded');
  expect(f.notes.row(n.noteId).path).toBe('Topic/renamed.md');
  expect(readFileSync(join(f.config.knowledgeRoot, 'Topic/renamed.md'), 'utf8')).toBe(
    '[b](../00-Inbox/b.md) ![asset](../00-Inbox/assets/shared.png)',
  );
  expect(readFileSync(join(f.config.knowledgeRoot, '00-Inbox/b.md'), 'utf8')).toBe(
    '[a](../Topic/renamed.md)',
  );
  expect(existsSync(join(f.config.knowledgeRoot, '00-Inbox/assets/shared.png'))).toBe(true);
  expect(f.notes.row(b.noteId).id).toBe(b.noteId);
});
it('moves a directory with empty descendants and managed attachments keeping identities', async () => {
  const f = fixture(),
    n = f.create('00-Inbox/a.md', '![asset](assets/a.png)');
  mkdirSync(join(f.config.knowledgeRoot, '00-Inbox/Empty'));
  mkdirSync(join(f.config.knowledgeRoot, '00-Inbox/assets'));
  writeFileSync(join(f.config.knowledgeRoot, '00-Inbox/assets/a.png'), 'asset');
  f.db.prepare('INSERT INTO assets(id,path) VALUES(?,?)').run('asset-one', '00-Inbox/assets/a.png');
  syncDirectoryCatalog(f.config, f.db);
  const d = f.directory('00-Inbox'),
    op = await execute(f, [
      {
        type: 'move_directory',
        directoryId: d.id,
        toDirectoryId: f.directory('Topic').id,
        name: 'Moved',
        expectedSubtreeRevision: d.subtreeRevision,
      },
    ]);
  expect(op.status).toBe('succeeded');
  expect(f.directory('Topic/Moved').id).toBe(d.id);
  expect(f.notes.row(n.noteId).path).toBe('Topic/Moved/a.md');
  expect(f.db.prepare('SELECT path FROM assets WHERE id=?').get('asset-one')).toEqual({
    path: 'Topic/Moved/assets/a.png',
  });
  expect(existsSync(join(f.config.knowledgeRoot, 'Topic/Moved/Empty'))).toBe(true);
  expect(existsSync(join(f.config.knowledgeRoot, '00-Inbox'))).toBe(false);
});
it('succeeds for bounded no-op without changing structure revision', async () => {
  const f = fixture(),
    n = f.create('00-Inbox/a.md', '# a'),
    before = f.s.context(f.p);
  const op = await execute(f, [
    { type: 'move_note', ...n, toDirectoryId: f.directory('00-Inbox').id, fileName: 'a.md' },
  ]);
  expect(op.status).toBe('succeeded');
  expect(op.result?.structureRevision).toBe(before.structureRevision);
  expect(op.result?.changes).toEqual([]);
});
it('rejects stale versions and occupied names before touching files', async () => {
  const f = fixture(),
    n = f.create('00-Inbox/a.md', '# a');
  f.create('Topic/existing.md', '# existing');
  const conflict = await execute(f, [
    { type: 'move_note', ...n, toDirectoryId: f.directory('Topic').id, fileName: 'existing.md' },
  ]);
  expect(conflict).toMatchObject({ status: 'failed', error: { code: 'NAME_CONFLICT' } });
  const stale = await execute(
    f,
    [
      {
        type: 'move_note',
        ...n,
        expectedContentHash: '0'.repeat(64),
        toDirectoryId: f.directory('Topic').id,
        fileName: 'new.md',
      },
    ],
    'stale',
  );
  expect(stale).toMatchObject({ status: 'failed', error: { code: 'VERSION_CONFLICT' } });
  expect(readFileSync(join(f.config.knowledgeRoot, '00-Inbox/a.md'), 'utf8')).toBe('# a');
});
it('refuses protected containers and unsupported files in moved subtrees', async () => {
  const f = fixture();
  mkdirSync(join(f.config.knowledgeRoot, '99-System'));
  syncDirectoryCatalog(f.config, f.db);
  const d = f.directory('99-System');
  const protectedOp = await execute(f, [
    {
      type: 'move_directory',
      directoryId: d.id,
      toDirectoryId: null,
      name: 'Renamed',
      expectedSubtreeRevision: d.subtreeRevision,
    },
  ]);
  expect(protectedOp).toMatchObject({ status: 'failed', error: { code: 'PROTECTED_DIRECTORY' } });
  writeFileSync(join(f.config.knowledgeRoot, 'Topic/unmanaged.bin'), 'unmanaged');
  syncDirectoryCatalog(f.config, f.db);
  const topic = f.directory('Topic'),
    unsupported = await execute(
      f,
      [
        {
          type: 'move_directory',
          directoryId: topic.id,
          toDirectoryId: null,
          name: 'Moved',
          expectedSubtreeRevision: topic.subtreeRevision,
        },
      ],
      'unsupported',
    );
  expect(unsupported).toMatchObject({ status: 'failed', error: { code: 'UNSUPPORTED_OBJECT' } });
  expect(existsSync(join(f.config.knowledgeRoot, 'Topic/unmanaged.bin'))).toBe(true);
});
it('rejects overlaps, cycles and more than 50 actions', async () => {
  const f = fixture(),
    n = f.create('00-Inbox/a.md', '# a'),
    d = f.directory('00-Inbox');
  const overlap = await execute(f, [
    {
      type: 'move_directory',
      directoryId: d.id,
      toDirectoryId: null,
      name: 'Moved',
      expectedSubtreeRevision: d.subtreeRevision,
    },
    { type: 'move_note', ...n, toDirectoryId: f.directory('Topic').id, fileName: 'a.md' },
  ]);
  expect(overlap).toMatchObject({ status: 'failed', error: { code: 'OVERLAPPING_ACTIONS' } });
  const cycle = await execute(
    f,
    [
      {
        type: 'move_directory',
        directoryId: d.id,
        toDirectoryId: d.id,
        name: 'Cycle',
        expectedSubtreeRevision: d.subtreeRevision,
      },
    ],
    'cycle',
  );
  expect(cycle).toMatchObject({ status: 'failed', error: { code: 'DIRECTORY_CYCLE' } });
  const c = f.s.context(f.p);
  await expect(
    f.s.submit(f.p, {
      ...c,
      requestId: 'limit',
      expectedStructureRevision: c.structureRevision,
      actions: Array.from({ length: 51 }, () => ({
        type: 'create_directory',
        parentId: null,
        name: 'A',
      })),
    }),
  ).rejects.toMatchObject({ code: 'ORGANIZATION_LIMIT' });
});
it('denies external incoming-link rewrites without leaking paths and performs no changes', async () => {
  const f = fixture(),
    n = f.create('00-Inbox/a.md', '# a');
  f.create('Topic/private.md', '[a](../00-Inbox/a.md)');
  f.p.allowedPrefixes = ['00-Inbox'];
  (f.p as any).knowledgeAll = false;
  const op = await execute(f, [
    { type: 'move_note', ...n, toDirectoryId: f.directory('00-Inbox').id, fileName: 'renamed.md' },
  ]);
  expect(op).toMatchObject({ status: 'failed', error: { code: 'DEPENDENCY_FORBIDDEN' } });
  expect(JSON.stringify(op)).not.toContain('private');
  expect(existsSync(join(f.config.knowledgeRoot, '00-Inbox/a.md'))).toBe(true);
  expect(readFileSync(join(f.config.knowledgeRoot, 'Topic/private.md'), 'utf8')).toBe(
    '[a](../00-Inbox/a.md)',
  );
});
it('undo restores the complete structure and refuses subsequent edits atomically', async () => {
  const f = fixture(),
    n = f.create('00-Inbox/a.md', '# a'),
    op = await execute(f, [
      { type: 'move_note', ...n, toDirectoryId: f.directory('Topic').id, fileName: 'a.md' },
    ]);
  const undone = await f.s.undo(f.p, { operationId: op.operationId, requestId: 'undo' });
  await f.s.drain();
  expect(f.s.operation(f.p, { operationId: undone.operation.operationId }).status).toBe(
    'succeeded',
  );
  expect(f.notes.row(n.noteId).path).toBe('00-Inbox/a.md');
  const second = await execute(
    f,
    [
      {
        type: 'move_note',
        noteId: n.noteId,
        expectedModifiedAt: f.notes.getNote(n.noteId).modifiedAt,
        expectedContentHash: n.expectedContentHash,
        toDirectoryId: f.directory('Topic').id,
        fileName: 'a.md',
      },
    ],
    'second',
  );
  writeFileSync(join(f.config.knowledgeRoot, 'Topic/a.md'), '# later');
  const conflict = await f.s.undo(f.p, {
    operationId: second.operationId,
    requestId: 'undo-conflict',
  });
  await f.s.drain();
  expect(f.s.operation(f.p, { operationId: conflict.operation.operationId })).toMatchObject({
    status: 'failed',
    error: { code: 'UNDO_CONFLICT' },
  });
  expect(readFileSync(join(f.config.knowledgeRoot, 'Topic/a.md'), 'utf8')).toBe('# later');
});
it('cancels queued jobs and rechecks revoked permissions before execution', async () => {
  const f = fixture(false),
    n = f.create('00-Inbox/a.md', '# a'),
    c = f.s.context(f.p),
    input = {
      libraryId: c.libraryId,
      expectedStructureRevision: c.structureRevision,
      requestId: 'cancel',
      actions: [
        {
          type: 'move_note' as const,
          ...n,
          toDirectoryId: f.directory('Topic').id,
          fileName: 'a.md',
        },
      ],
    };
  const a = await f.s.submit(f.p, input);
  expect(f.s.cancel(f.p, { operationId: a.operation.operationId }).status).toBe('cancelled');
  const b = await f.s.submit(f.p, { ...input, requestId: 'revoked' });
  f.config.agent!.policies = [];
  await f.s.recover();
  await f.s.drain();
  expect(
    f.db.prepare('SELECT status,error FROM operations WHERE id=?').get(b.operation.operationId),
  ).toMatchObject({ status: 'failed', error: 'FORBIDDEN' });
  expect(existsSync(join(f.config.knowledgeRoot, '00-Inbox/a.md'))).toBe(true);
});
it('blocks readers, writers and catalog scans while a persistent commit needs recovery', () => {
  const f = fixture();
  f.s.context(f.p);
  f.db
    .prepare(
      "INSERT INTO operations(id,principal,client_id,kind,request_id,params_hash,status,created_at,updated_at) VALUES('pending',?,?,'organize','pending','hash','committing',1,1)",
    )
    .run(f.p.id, f.p.clientId);
  f.db
    .prepare(
      "INSERT INTO organization_jobs(id,status,payload,created_at) VALUES('pending','committing','{}',1)",
    )
    .run();
  expect(() => assertOrganizationReadable(f.db)).toThrowError(/ORGANIZATION_RECOVERY_REQUIRED/);
  expect(() => syncDirectoryCatalog(f.config, f.db)).toThrowError(
    expect.objectContaining({ code: 'ORGANIZATION_RECOVERY_REQUIRED' }),
  );
  expect(() => workspaceWriteSync(f.db, { kind: 'test' }, () => {})).toThrowError(
    /ORGANIZATION_RECOVERY_REQUIRED/,
  );
});
it('keeps unfinished recovery data when cleaning expired successful undo material', async () => {
  const f = fixture(),
    n = f.create('00-Inbox/a.md', '# a'),
    op = await execute(f, [
      { type: 'move_note', ...n, toDirectoryId: f.directory('Topic').id, fileName: 'a.md' },
    ]);
  f.db.prepare('UPDATE organization_jobs SET expires_at=0 WHERE id=?').run(op.operationId);
  await f.s.cleanup();
  expect(existsSync(join(f.config.knowledgeRoot, 'Topic/a.md'))).toBe(true);
  expect(f.s.operation(f.p, { operationId: op.operationId }).result?.undoAvailable).toBe(false);
  expect(readdirSync(join(f.config.dataRoot, 'organization'))).not.toContain(op.operationId);
});
it('rejects a newly observed backlink added after preparation before any journal publishes', async () => {
  const f = fixture(),
    n = f.create('00-Inbox/a.md', '# a'),
    c = f.s.context(f.p);
  let calls = 0;
  const r = await f.s.submit(
    f.p,
    {
      libraryId: c.libraryId,
      expectedStructureRevision: c.structureRevision,
      requestId: 'new-link',
      actions: [
        { type: 'move_note', ...n, toDirectoryId: f.directory('Topic').id, fileName: 'a.md' },
      ],
    },
    () => {
      if (++calls === 2)
        writeFileSync(
          join(f.config.knowledgeRoot, 'Topic/new-inlink.md'),
          '[new](../00-Inbox/a.md)',
        );
      return f.p;
    },
  );
  await f.s.drain();
  expect(f.s.operation(f.p, { operationId: r.operation.operationId })).toMatchObject({
    status: 'failed',
    error: { code: 'STRUCTURE_VERSION_CONFLICT' },
  });
  expect(existsSync(join(f.config.knowledgeRoot, '00-Inbox/a.md'))).toBe(true);
  expect(existsSync(join(f.config.knowledgeRoot, 'Topic/a.md'))).toBe(false);
});
it('refuses a create action overlapping a moved source subtree before any writes', async () => {
  const f = fixture();
  f.s.context(f.p);
  const d = f.directory('00-Inbox');
  const op = await execute(f, [
    {
      type: 'move_directory',
      directoryId: d.id,
      toDirectoryId: null,
      name: 'Moved',
      expectedSubtreeRevision: d.subtreeRevision,
    },
    { type: 'create_directory', parentId: d.id, name: 'Child' },
  ]);
  expect(op).toMatchObject({ status: 'failed', error: { code: 'OVERLAPPING_ACTIONS' } });
  expect(existsSync(join(f.config.knowledgeRoot, 'Moved'))).toBe(false);
});
it('refuses undo when a new source adds an incoming reference to the published location', async () => {
  const f = fixture(),
    n = f.create('00-Inbox/a.md', '# a'),
    op = await execute(f, [
      { type: 'move_note', ...n, toDirectoryId: f.directory('Topic').id, fileName: 'a.md' },
    ]);
  f.create('Topic/new.md', '[new](a.md)');
  const r = await f.s.undo(f.p, { operationId: op.operationId, requestId: 'undo-new-link' });
  await f.s.drain();
  expect(f.s.operation(f.p, { operationId: r.operation.operationId })).toMatchObject({
    status: 'failed',
    error: { code: 'UNDO_CONFLICT' },
  });
  expect(existsSync(join(f.config.knowledgeRoot, 'Topic/a.md'))).toBe(true);
});
it('publishes files when durable data and knowledge root reside on separate filesystems', async () => {
  if (!existsSync('/dev/shm')) return;
  const f = fixture(),
    other = join('/dev/shm', `dooknow-organization-${process.pid}-${Date.now()}`);
  mkdirSync(other);
  const oldRoot = f.config.dataRoot;
  f.config.dataRoot = other;
  closes.push(async () => {
    f.config.dataRoot = oldRoot;
    const { rmSync } = await import('node:fs');
    rmSync(other, { recursive: true, force: true });
  });
  const n = f.create('00-Inbox/a.md', '# a'),
    op = await execute(f, [
      { type: 'move_note', ...n, toDirectoryId: f.directory('Topic').id, fileName: 'a.md' },
    ]);
  expect(op.status).toBe('succeeded');
  expect(readFileSync(join(f.config.knowledgeRoot, 'Topic/a.md'), 'utf8')).toBe('# a');
});
it('bounds long-path directory and history pages below the duplicated MCP response budget', async () => {
  const f = fixture();
  const parent = Array.from({ length: 8 }, (_, i) => String(i) + 'a'.repeat(149)).join('/');
  mkdirSync(join(f.config.knowledgeRoot, parent), { recursive: true });
  f.s.context(f.p);
  for (let batch = 0; batch < 3; batch++) {
    const op = await execute(
      f,
      Array.from({ length: 10 }, (_, i) => ({
        type: 'create_directory',
        parentId: f.directory(parent).id,
        name: `Child-${batch}-${i}`,
      })),
      `batch-${batch}`,
    );
    expect(op.status).toBe('succeeded');
  }
  const page = f.s.list(f.p, { parentId: f.directory(parent).id, limit: 50 });
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(28672);
  expect(page.nextCursor).toBeTruthy();
  const history = f.s.history(f.p, { limit: 50 });
  expect(Buffer.byteLength(JSON.stringify(history))).toBeLessThanOrEqual(28672);
  expect(history.nextCursor).toBeTruthy();
});
it('does not expose historical paths when affected identities no longer resolve under a narrowed grant', async () => {
  const f = fixture(),
    n = f.create('00-Inbox/a.md', '# a'),
    op = await execute(f, [
      { type: 'move_note', ...n, toDirectoryId: f.directory('Topic').id, fileName: 'a.md' },
    ]);
  f.db.prepare('UPDATE notes SET active=0 WHERE id=?').run(n.noteId);
  f.p.allowedPrefixes = ['Other'];
  f.p.knowledgeAll = false;
  expect(() => f.s.operation(f.p, { operationId: op.operationId })).toThrowError(
    expect.objectContaining({ code: 'FORBIDDEN' }),
  );
});
it('creates an empty directory without reading unrelated oversized library bodies', async () => {
  const f = fixture();
  writeFileSync(join(f.config.knowledgeRoot, '00-Inbox/large.md'), '');
  const { truncateSync } = await import('node:fs');
  truncateSync(join(f.config.knowledgeRoot, '00-Inbox/large.md'), 129 * 1024 * 1024);
  f.notes.scan();
  f.s.context(f.p);
  const op = await execute(f, [
    { type: 'create_directory', parentId: f.directory('Topic').id, name: 'Empty' },
  ]);
  expect(op.status).toBe('succeeded');
  expect(existsSync(join(f.config.knowledgeRoot, 'Topic/Empty'))).toBe(true);
});
it('does not expand a queued principal when its current policy is broadened later', async () => {
  const f = fixture(false),
    n = f.create('00-Inbox/a.md', '# a');
  f.p.allowedPrefixes = ['00-Inbox'];
  f.p.knowledgeAll = false;
  const c = f.s.context(f.p),
    r = await f.s.submit(f.p, {
      libraryId: c.libraryId,
      expectedStructureRevision: c.structureRevision,
      requestId: 'queued-expansion',
      actions: [
        { type: 'move_note', ...n, toDirectoryId: f.directory('Topic').id, fileName: 'a.md' },
      ],
    });
  f.p.allowedPrefixes = ['00-Inbox', 'Topic'];
  f.p.knowledgeAll = true;
  await f.s.recover();
  await f.s.drain();
  expect(f.s.operation(f.p, { operationId: r.operation.operationId })).toMatchObject({
    status: 'failed',
    error: { code: 'FORBIDDEN' },
  });
  expect(existsSync(join(f.config.knowledgeRoot, '00-Inbox/a.md'))).toBe(true);
});
it('rejects escaped long-path receipts using the complete duplicated MCP envelope before moving any source', async () => {
  const f = fixture(),
    parent = Array.from({ length: 5 }, (_, i) => '"'.repeat(179) + i).join('/'),
    destination = 'New/' + parent;
  mkdirSync(join(f.config.knowledgeRoot, parent), { recursive: true });
  mkdirSync(join(f.config.knowledgeRoot, destination), { recursive: true });
  const sources = Array.from({ length: 6 }, (_, i) => {
    const path = `${parent}/${i}.md`;
    return { path, ...f.create(path, `# source ${i}`) };
  });
  const context = f.s.context(f.p),
    target = f.directory(destination),
    requestId = '"'.repeat(128),
    actions = sources.map((source, i) => ({
      type: 'move_note' as const,
      noteId: source.noteId,
      expectedModifiedAt: source.expectedModifiedAt,
      expectedContentHash: source.expectedContentHash,
      toDirectoryId: target.id,
      fileName: `${i}.md`,
    }));
  const accepted = await f.s.submit(f.p, {
    libraryId: context.libraryId,
    expectedStructureRevision: context.structureRevision,
    requestId,
    actions,
  });
  const { messageSize } = await import('../packages/core/knowledge/limits.js');
  const hypothetical = {
    operationId: accepted.operation.operationId,
    requestId,
    kind: 'organization.organize',
    status: 'succeeded',
    result: {
      operationId: accepted.operation.operationId,
      libraryId: context.libraryId,
      structureRevision: context.structureRevision,
      changes: sources.map((source, i) => ({
        type: 'move_note',
        id: source.noteId,
        from: source.path,
        to: `${destination}/${i}.md`,
      })),
      indexState: 'pending',
      undoAvailable: true,
    },
  };
  expect(messageSize(hypothetical)).toBeGreaterThan(65536);
  await f.s.drain();
  expect(f.s.operation(f.p, { operationId: accepted.operation.operationId })).toMatchObject({
    status: 'failed',
    error: { code: 'RESPONSE_TOO_LARGE' },
  });
  for (const [i, source] of sources.entries()) {
    expect(readFileSync(join(f.config.knowledgeRoot, source.path), 'utf8')).toBe(`# source ${i}`);
    expect(existsSync(join(f.config.knowledgeRoot, destination, `${i}.md`))).toBe(false);
    expect(f.notes.row(source.noteId).path).toBe(source.path);
  }
});
it('paginates escaped directory paths against the complete MCP response frame', async () => {
  const f = fixture(),
    parent = Array.from({ length: 5 }, (_, i) => '"'.repeat(179) + i).join('/');
  mkdirSync(join(f.config.knowledgeRoot, parent), { recursive: true });
  for (let i = 0; i < 16; i++)
    mkdirSync(join(f.config.knowledgeRoot, parent, '"'.repeat(178) + String(i).padStart(2, '0')));
  f.s.context(f.p);
  const parentId = f.directory(parent).id,
    { messageSize } = await import('../packages/core/knowledge/limits.js'),
    seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = f.s.list(f.p, { parentId, limit: 50, cursor });
    expect(messageSize(page) + 640).toBeLessThanOrEqual(65536);
    expect(page.items.length).toBeGreaterThan(0);
    for (const item of page.items) seen.add(item.id);
    cursor = page.nextCursor;
  } while (cursor);
  expect(seen.size).toBe(16);
});
it('paginates escaped organization history against the complete MCP response frame', async () => {
  const f = fixture(),
    parent = Array.from({ length: 5 }, (_, i) => '"'.repeat(179) + i).join('/');
  mkdirSync(join(f.config.knowledgeRoot, parent), { recursive: true });
  f.s.context(f.p);
  for (let i = 0; i < 13; i++) {
    const op = await execute(
      f,
      [
        {
          type: 'create_directory',
          parentId: f.directory(parent).id,
          name: '"'.repeat(178) + String(i).padStart(2, '0'),
        },
      ],
      `history-${i}`,
    );
    expect(op.status).toBe('succeeded');
  }
  const { messageSize } = await import('../packages/core/knowledge/limits.js'),
    seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = f.s.history(f.p, { limit: 50, cursor });
    expect(messageSize(page) + 640).toBeLessThanOrEqual(65536);
    expect(page.items.length).toBeGreaterThan(0);
    for (const item of page.items) seen.add(item.operationId);
    cursor = page.nextCursor;
  } while (cursor);
  expect(seen.size).toBe(13);
});
