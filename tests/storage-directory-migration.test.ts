import { beginOperation, completeOperation } from '../packages/core/knowledge/operations';
import { afterEach, expect, test } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  renameSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../packages/core/db';
import { noteService } from '../packages/core/notes';
import { mutationCore, webPrincipal } from '../packages/core/knowledge/core';
import { assetService } from '../packages/core/assets';
import {
  planStorageDirectoryMigration,
  applyStorageDirectoryMigration,
} from '../packages/core/storage-directory-migration';
import { safePath } from '../packages/core/files';
const fixtures: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of fixtures.splice(0)) cleanup();
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'doo-dir-migration-'));
  const config = {
    knowledgeRoot: join(root, 'knowledge'),
    dataRoot: join(root, 'data'),
    origin: 'http://localhost',
    secret: 'fixture-only',
  };
  mkdirSync(join(config.knowledgeRoot, 'notes/assets'), { recursive: true });
  mkdirSync(join(config.knowledgeRoot, 'frontend/assets'), { recursive: true });
  const db = openDatabase(config.dataRoot),
    notes = noteService(config, db),
    core = mutationCore(config, db);
  const name = 'diagram-' + 'a'.repeat(64) + '.png',
    old = 'notes/assets/' + name,
    current = 'notes/_doo-assets/' + name;
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=',
    'base64',
  );
  writeFileSync(join(config.knowledgeRoot, old), png);
  writeFileSync(join(config.knowledgeRoot, 'frontend/assets/logo.png'), png);
  writeFileSync(join(config.knowledgeRoot, 'frontend/assets/README.md'), '# Frontend source');
  const note = core.create(
    webPrincipal,
    'notes',
    'doc.md',
    `# Test\n\n![Picture](assets/${name})\n\n\`assets/${name}\`\n`,
    'create-fixture-note',
  );
  const asset = assetService(config, db, notes).register(old);
  const { operation } = beginOperation(
    db,
    webPrincipal,
    'diagram-primary.prepare',
    'fixture-asset-receipt',
    { path: old },
  );
  completeOperation(db, operation.id, { preview: asset });
  renameSync(join(config.knowledgeRoot, '_doo-data'), join(config.knowledgeRoot, '_data'));
  fixtures.push(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, config, db, notes, note, asset, old, current };
}
test('dry run identifies generated resources, leaves frontend source and bytes unchanged', () => {
  const f = fixture(),
    before = readFileSync(join(f.config.knowledgeRoot, f.note.relativePath));
  const plan = planStorageDirectoryMigration(f.config, f.db);
  expect(plan.assets.map((x) => x.from)).toEqual([f.old]);
  expect(plan.edits).toHaveLength(1);
  expect(readFileSync(join(f.config.knowledgeRoot, f.note.relativePath))).toEqual(before);
  expect(existsSync(join(f.config.knowledgeRoot, '_data'))).toBe(true);
});
test('migration preserves note and asset IDs, relative references, native history paths and user assets', async () => {
  const f = fixture(),
    plan = planStorageDirectoryMigration(f.config, f.db);
  await applyStorageDirectoryMigration(f.config, f.db, plan);
  expect(existsSync(join(f.config.knowledgeRoot, '_data'))).toBe(false);
  expect(existsSync(join(f.config.knowledgeRoot, '_doo-data/manifest.json'))).toBe(true);
  expect(existsSync(join(f.config.knowledgeRoot, f.old))).toBe(false);
  expect(existsSync(join(f.config.knowledgeRoot, f.current))).toBe(true);
  const text = readFileSync(join(f.config.knowledgeRoot, f.note.relativePath), 'utf8');
  expect(text).toContain('](_doo-assets/diagram-');
  expect(text).toContain('`assets/diagram-');
  expect(f.db.prepare('SELECT path FROM assets WHERE id=?').get(f.asset.id)).toEqual({
    path: f.current,
  });
  expect(f.db.prepare('SELECT id FROM notes WHERE path=?').get(f.note.relativePath)).toEqual({
    id: f.note.id,
  });
  expect(safePath(f.config.knowledgeRoot, f.old, 'asset')).toBe(
    join(f.config.knowledgeRoot, f.current),
  );
  expect(existsSync(join(f.config.knowledgeRoot, 'frontend/assets/logo.png'))).toBe(true);
  expect(planStorageDirectoryMigration(f.config, f.db).assets).toHaveLength(0);
  await applyStorageDirectoryMigration(f.config, f.db, plan);
});
test('target collisions fail before moving state, resources or rewriting text', async () => {
  const f = fixture(),
    plan = planStorageDirectoryMigration(f.config, f.db);
  mkdirSync(join(f.config.knowledgeRoot, 'notes/_doo-assets'));
  writeFileSync(join(f.config.knowledgeRoot, f.current), 'different');
  await expect(applyStorageDirectoryMigration(f.config, f.db, plan)).rejects.toThrow();
  expect(existsSync(join(f.config.knowledgeRoot, '_data'))).toBe(true);
  expect(readFileSync(join(f.config.knowledgeRoot, f.note.relativePath), 'utf8')).toContain(
    '](assets/',
  );
});
test('the fixed plan resumes a resource already moved before an interruption', async () => {
  const f = fixture(),
    plan = planStorageDirectoryMigration(f.config, f.db);
  mkdirSync(join(f.config.knowledgeRoot, 'notes/_doo-assets'));
  renameSync(join(f.config.knowledgeRoot, f.old), join(f.config.knowledgeRoot, f.current));
  await applyStorageDirectoryMigration(f.config, f.db, plan);
  expect(readFileSync(join(f.config.knowledgeRoot, f.note.relativePath), 'utf8')).toContain(
    '](_doo-assets/',
  );
});

test('a forged destination cannot escape the knowledge root', async () => {
  const f = fixture(),
    plan = planStorageDirectoryMigration(f.config, f.db);
  plan.assets[0].to = '../outside.png';
  await expect(applyStorageDirectoryMigration(f.config, f.db, plan)).rejects.toThrow();
  expect(existsSync(join(f.config.knowledgeRoot, '_data'))).toBe(true);
});

test('rewriting a bound native reference updates its code binding without changing source bytes', async () => {
  const f = fixture();
  const { serializeDiagramBinding } = await import('../shared/diagram-binding');
  const { boundDiagramSources, normalizeDiagramCode } =
    await import('../shared/diagram-portability');
  const { createHash } = await import('node:crypto');
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const name = 'diagram-' + 'b'.repeat(64) + '.excalidraw';
  const source = JSON.stringify({
    type: 'excalidraw',
    version: 2,
    source: 'test',
    elements: [],
    appState: {},
    files: {},
  });
  writeFileSync(join(f.config.knowledgeRoot, 'notes/assets/' + name), source);
  const sourceAsset = assetService(f.config, f.db, f.notes).register('notes/assets/' + name);
  const { operation } = beginOperation(
    f.db,
    webPrincipal,
    'diagram-artifacts:' + f.note.id,
    'fixture-native-receipt',
    { path: sourceAsset.relativePath },
  );
  completeOperation(f.db, operation.id, { source: sourceAsset });
  const body =
    '![EXCALIDRAW 预览](assets/' +
    f.old.split('/').at(-1) +
    ')\n\n[图形源文件](assets/' +
    name +
    ')\n\n' +
    serializeDiagramBinding({
      kind: 'excalidraw',
      codeHash: hash('assets/' + name),
      sourceHash: hash(source),
    }) +
    '\n\n```excalidraw\nassets/' +
    name +
    '\n```\n';
  const core = mutationCore(f.config, f.db),
    note = core.create(webPrincipal, 'notes', 'bound.md', body, 'create-bound-fixture');
  await applyStorageDirectoryMigration(
    f.config,
    f.db,
    planStorageDirectoryMigration(f.config, f.db),
  );
  const group = boundDiagramSources(
    readFileSync(join(f.config.knowledgeRoot, note.relativePath), 'utf8'),
  )[0];
  expect(group.code).toContain('_doo-assets/');
  expect(group.binding.codeHash).toBe(hash(normalizeDiagramCode(group.code)));
  expect(group.binding.sourceHash).toBe(hash(source));
});

test('a byte-identical target owned by another asset ID is rejected before mutation', async () => {
  const f = fixture(),
    plan = planStorageDirectoryMigration(f.config, f.db);
  mkdirSync(join(f.config.knowledgeRoot, 'notes/_doo-assets'));
  writeFileSync(
    join(f.config.knowledgeRoot, f.current),
    readFileSync(join(f.config.knowledgeRoot, f.old)),
  );
  assetService(f.config, f.db, f.notes).register(f.current);
  await expect(applyStorageDirectoryMigration(f.config, f.db, plan)).rejects.toThrow('身份冲突');
  expect(existsSync(join(f.config.knowledgeRoot, '_data'))).toBe(true);
  expect(readFileSync(join(f.config.knowledgeRoot, f.note.relativePath), 'utf8')).toContain(
    '](assets/',
  );
});

test('registered UUID filenames without a creation receipt remain user-owned even at a frontend root', () => {
  const f = fixture(),
    name = '00000000-0000-4000-8000-000000000001.png';
  mkdirSync(join(f.config.knowledgeRoot, 'assets'));
  writeFileSync(join(f.config.knowledgeRoot, 'package.json'), '{}');
  writeFileSync(
    join(f.config.knowledgeRoot, 'assets', name),
    readFileSync(join(f.config.knowledgeRoot, f.old)),
  );
  assetService(f.config, f.db, f.notes).register('assets/' + name);
  const plan = planStorageDirectoryMigration(f.config, f.db);
  expect(plan.assets.some((entry) => entry.from === 'assets/' + name)).toBe(false);
  expect(plan.preserved).toContain('assets/' + name);
});
test('invalid target ancestors are rejected before renaming metadata or writing aliases', async () => {
  const f = fixture(),
    plan = planStorageDirectoryMigration(f.config, f.db);
  writeFileSync(join(f.config.knowledgeRoot, 'notes/_doo-assets'), 'not a directory');
  await expect(applyStorageDirectoryMigration(f.config, f.db, plan)).rejects.toThrow();
  expect(existsSync(join(f.config.knowledgeRoot, '_data'))).toBe(true);
  expect(existsSync(join(f.config.knowledgeRoot, '_data/library/asset-aliases.json'))).toBe(false);
});
test('changing the library manifest invalidates a frozen plan before mutation', async () => {
  const f = fixture(),
    plan = planStorageDirectoryMigration(f.config, f.db);
  writeFileSync(
    join(f.config.knowledgeRoot, '_data/manifest.json'),
    '{"format":1,"id":"another-library"}',
  );
  await expect(applyStorageDirectoryMigration(f.config, f.db, plan)).rejects.toThrow('身份清单');
  expect(existsSync(join(f.config.knowledgeRoot, f.old))).toBe(true);
});

test('historical resource lookups retain the migrated asset for an outside document', async () => {
  const f = fixture();
  f.db
    .prepare(
      'INSERT INTO diagram_document_versions(note_id,document_hash,path,document_type,source_hash,render_hash,preview_hash,manifest,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    )
    .run(
      f.note.id,
      'old-hash',
      'other/outside.md',
      'flowchart',
      's',
      'r',
      'p',
      JSON.stringify({
        resources: [
          {
            path: f.old,
            hash: (await import('../packages/core/knowledge/operations')).sha256(
              readFileSync(join(f.config.knowledgeRoot, f.old)),
            ),
            role: 'preview',
          },
        ],
      }),
      Date.now(),
    );
  await applyStorageDirectoryMigration(
    f.config,
    f.db,
    planStorageDirectoryMigration(f.config, f.db),
  );
  const { planRetainedFolderResources } =
    await import('../packages/core/knowledge/diagram-retained-folders');
  const rows = planRetainedFolderResources(f.config, f.db, webPrincipal, [
    { from: 'notes', to: 'renamed', directory: true },
  ]);
  // The document in notes owns its own live resource, so create a truly outside historical owner.
  const outside = mutationCore(f.config, f.db).create(
    webPrincipal,
    '',
    'outside.md',
    '# Outside',
    'outside-note',
  );
  f.db
    .prepare('UPDATE diagram_document_versions SET note_id=? WHERE document_hash=?')
    .run(outside.id, 'old-hash');
  const retained = planRetainedFolderResources(f.config, f.db, webPrincipal, [
    { from: 'notes', to: 'renamed', directory: true },
  ]);
  expect(retained.map((entry) => entry.id)).toContain(f.asset.id);
  const { assertFolderDiagramResourcesUnshared } =
    await import('../packages/core/knowledge/diagram-relocation');
  expect(() =>
    assertFolderDiagramResourcesUnshared(
      f.config,
      f.db,
      'notes',
      false,
      [{ from: 'notes', to: 'renamed' }],
      retained,
    ),
  ).not.toThrow();
});
test('legacy aliases follow stable asset IDs after a subsequent managed folder move', async () => {
  const f = fixture();
  await applyStorageDirectoryMigration(
    f.config,
    f.db,
    planStorageDirectoryMigration(f.config, f.db),
  );
  const { flushKnowledgeData } = await import('../packages/core/knowledge-data');
  mkdirSync(join(f.config.knowledgeRoot, 'renamed/_doo-assets'), { recursive: true });
  const next = f.current.replace('notes/', 'renamed/');
  renameSync(join(f.config.knowledgeRoot, f.current), join(f.config.knowledgeRoot, next));
  f.db.prepare('UPDATE assets SET path=? WHERE id=?').run(next, f.asset.id);
  flushKnowledgeData(f.db);
  expect(safePath(f.config.knowledgeRoot, f.old, 'asset')).toBe(join(f.config.knowledgeRoot, next));
});

test('normal startup refuses an incomplete migration journal', async () => {
  const f = fixture();
  const dir = join(f.config.dataRoot, 'directory-migrations', 'incomplete');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plan.json'), JSON.stringify({ status: 'resources-moved' }));
  const { assertStorageMigrationComplete } =
    await import('../packages/core/storage-migration-state');
  expect(() => assertStorageMigrationComplete(f.config.dataRoot)).toThrow('尚未完成');
});

test('a restored old Markdown reference remains discoverable by its original relative path', async () => {
  const f = fixture();
  await applyStorageDirectoryMigration(
    f.config,
    f.db,
    planStorageDirectoryMigration(f.config, f.db),
  );
  writeFileSync(
    join(f.config.knowledgeRoot, f.note.relativePath),
    `# Restored history\n\n![Old](assets/${f.old.split('/').at(-1)})\n`,
  );
  const listed = assetService(f.config, f.db, f.notes).list(f.note.id);
  expect(listed.some((asset) => asset.relativePath === f.old && asset.id === f.asset.id)).toBe(
    true,
  );
});

test('a fresh database can recover migrated asset identities from the copied knowledge metadata', async () => {
  const f = fixture();
  await applyStorageDirectoryMigration(
    f.config,
    f.db,
    planStorageDirectoryMigration(f.config, f.db),
  );
  const config = { ...f.config, dataRoot: join(f.root, 'fresh-data') },
    db = openDatabase(config.dataRoot);
  try {
    const notes = noteService(config, db);
    assetService(config, db, notes);
    expect(db.prepare('SELECT path FROM assets WHERE id=?').get(f.asset.id)).toEqual({
      path: f.current,
    });
  } finally {
    db.close();
  }
});

test('a copied root cannot mutate the original library database through a forged root binding', async () => {
  const f = fixture(),
    plan = planStorageDirectoryMigration(f.config, f.db);
  const { cpSync } = await import('node:fs');
  const copied = join(f.root, 'copied');
  cpSync(f.config.knowledgeRoot, copied, { recursive: true });
  plan.knowledgeRoot = copied;
  await expect(
    applyStorageDirectoryMigration({ ...f.config, knowledgeRoot: copied }, f.db, plan),
  ).rejects.toThrow();
  expect(existsSync(join(copied, f.old))).toBe(true);
  expect(existsSync(join(copied, '_data'))).toBe(true);
  expect(f.db.prepare('SELECT path FROM assets WHERE id=?').get(f.asset.id)).toEqual({
    path: f.old,
  });
});

test('portable alias bookkeeping follows a library root rebind before later resource moves',async()=>{
 const f=fixture();
 await applyStorageDirectoryMigration(f.config,f.db,planStorageDirectoryMigration(f.config,f.db));
 const { rebindKnowledgeDataRoot,flushKnowledgeData }=await import('../packages/core/knowledge-data');
 const moved=join(f.root,'moved-knowledge');renameSync(f.config.knowledgeRoot,moved);
 rebindKnowledgeDataRoot(f.db,moved,{previousRoot:f.config.knowledgeRoot,preservePending:true});
 const next=f.current.replace('notes/','new-notes/');
 mkdirSync(join(moved,'new-notes/_doo-assets'),{recursive:true});
 renameSync(join(moved,f.current),join(moved,next));
 f.db.prepare('UPDATE assets SET path=? WHERE id=?').run(next,f.asset.id);
 flushKnowledgeData(f.db);
 expect(safePath(moved,f.old,'asset')).toBe(join(moved,next));
 expect(f.db.prepare('SELECT root FROM storage_asset_aliases WHERE asset_id=?').get(f.asset.id)).toEqual({root:moved});
});
