import { expect, it } from 'vitest';
import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createFixture, loginFixtureOwner } from '../support/fixture.js';
import { openDatabase } from '../../packages/core/db.js';
import { mutationCore, webPrincipal } from '../../packages/core/knowledge/core.js';
import { sha256 } from '../../packages/core/knowledge/operations.js';
import { noteService } from '../../packages/core/notes.js';
import { reconcileService } from '../../packages/core/indexing/reconcile.js';
import { conflictService } from '../../packages/core/knowledge/conflicts.js';

it('moves through the owner API without replacing identity, history, shares or a later retry receipt', async () => {
  const f = await createFixture({ fileTasks: { embedded: false } });
  try {
    const h = await loginFixtureOwner(f);
    await mkdir(join(f.knowledgeRoot, '10-Projects'));
    const n = (
      await f.app.inject({
        method: 'POST',
        url: '/api/notes',
        headers: h,
        payload: { folderPath: '00-Inbox', fileName: 'source.md', content: '# original' },
      })
    ).json();
    const saved = (
      await f.app.inject({
        method: 'PUT',
        url: `/api/notes/${n.id}`,
        headers: h,
        payload: {
          content: '# preserved',
          expectedModifiedAt: n.modifiedAt,
          requestId: 'before-move',
        },
      })
    ).json();
    await f.app.inject({
      method: 'POST',
      url: `/api/notes/${n.id}/share`,
      headers: h,
      payload: {},
    });
    const payload = {
      folderPath: '10-Projects',
      fileName: 'destination.md',
      expectedModifiedAt: saved.modifiedAt,
      requestId: 'move-once',
    };
    const moved = await f.app.inject({
      method: 'POST',
      url: `/api/notes/${n.id}/move`,
      headers: h,
      payload,
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toMatchObject({
      id: n.id,
      moved: true,
      relativePath: '10-Projects/destination.md',
      previousRelativePath: n.relativePath,
    });
    expect(await readFile(join(f.knowledgeRoot, '10-Projects/destination.md'), 'utf8')).toBe(
      '# preserved',
    );
    expect(await readdir(join(f.knowledgeRoot, '00-Inbox'))).not.toContain('source.md');
    expect(
      (await f.app.inject({ url: `/api/notes/${n.id}/share`, headers: h })).json().enabled,
    ).toBe(true);
    expect(
      (await f.app.inject({ url: `/api/notes/${n.id}/revisions`, headers: h })).json().items,
    ).toHaveLength(1);
    const retry = await f.app.inject({
      method: 'POST',
      url: `/api/notes/${n.id}/move`,
      headers: h,
      payload,
    });
    expect(retry.json()).toEqual(moved.json());
    const changed = await f.app.inject({
      method: 'POST',
      url: `/api/notes/${n.id}/move`,
      headers: h,
      payload: { ...payload, fileName: 'another.md' },
    });
    expect(changed.json().code).toBe('IDEMPOTENCY_CONFLICT');
    expect(
      (await f.app.inject({ method: 'POST', url: `/api/notes/${n.id}/move`, payload })).statusCode,
    ).toBe(401);
  } finally {
    await f.close();
  }
});

for (const stage of ['intent', 'copy', 'publish', 'unlink', 'db-update', 'commit'])
  it(`recovers a process exit at move ${stage} with one identity and retained share`, async () => {
    const f = await createFixture({ fileTasks: { embedded: false } });
    const db = openDatabase(f.dataRoot);
    try {
      await mkdir(join(f.knowledgeRoot, '10-Projects'));
      const core = mutationCore(f.config as any, db),
        n = core.create(webPrincipal, '00-Inbox', 'source.md', '# durable original', 'make-move');
      db.prepare('INSERT INTO shares(note_id,token) VALUES(?,?)').run(n.id, 'test-share');
      await f.app.close();
      const configFile = join(f.root, 'move-config.json');
      await writeFile(configFile, JSON.stringify(f.config), { mode: 0o600 });
      const child = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          resolve('tests/support/move-fault-child.ts'),
          configFile,
          n.id,
          n.modifiedAt,
          stage,
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      let errors = '';
      child.stderr.on('data', (b) => {
        errors += String(b);
      });
      const code = await new Promise((yes, no) => {
        child.once('error', no);
        child.once('exit', yes);
      });
      expect(code, errors).toBe(73);
      await core.recover();
      noteService(f.config as any, db).scan();
      await reconcileService(f.config as any, db).reconcile();
      expect(db.prepare('SELECT id,path FROM notes WHERE active=1').all()).toEqual([
        { id: n.id, path: '10-Projects/destination.md' },
      ]);
      expect(db.prepare('SELECT enabled FROM shares WHERE note_id=?').get(n.id)).toMatchObject({
        enabled: 1,
      });
      expect(
        db.prepare("SELECT status FROM operations WHERE request_id='crash-move'").get(),
      ).toMatchObject({ status: 'succeeded' });
      expect(await readFile(join(f.knowledgeRoot, '10-Projects/destination.md'), 'utf8')).toBe(
        '# durable original',
      );
      expect(await readdir(join(f.knowledgeRoot, '00-Inbox'))).not.toContain('source.md');
    } finally {
      db.close();
      await f.close();
    }
  });

for (const boundary of ['intent-snapshot', 'note-read'])
  it(`keeps a second process's successful move receipt when stale recovery resumes at ${boundary}`, async () => {
    const f = await createFixture({ fileTasks: { embedded: false } });
    const db = openDatabase(f.dataRoot),
      prepare = db.prepare.bind(db);
    try {
      await mkdir(join(f.knowledgeRoot, '10-Projects'));
      const core = mutationCore(f.config as any, db),
        n = core.create(
          webPrincipal,
          '00-Inbox',
          'source.md',
          '# durable original',
          'concurrent-move-create',
        );
      await f.app.close();
      const configFile = join(f.root, 'move-config.json');
      await writeFile(configFile, JSON.stringify(f.config), { mode: 0o600 });
      const args = [
        '--import',
        'tsx',
        resolve('tests/support/move-fault-child.ts'),
        configFile,
        n.id,
        n.modifiedAt,
      ];
      const interrupted = spawnSync(process.execPath, [...args, 'intent'], {
        encoding: 'utf8',
        timeout: 10000,
      });
      expect(interrupted.status, interrupted.stderr).toBe(73);
      let raced = false,
        committed: any;
      const completeFromSecondProcess = () => {
        raced = true;
        const child = spawnSync(process.execPath, [...args, 'recover'], {
          encoding: 'utf8',
          timeout: 10000,
        });
        expect(child.status, child.stderr).toBe(0);
        committed = prepare(
          "SELECT status,result,error FROM operations WHERE request_id='crash-move'",
        ).get();
        expect(committed).toMatchObject({ status: 'succeeded', error: null });
      };
      db.prepare = ((sql: string) => {
        const stmt = prepare(sql);
        if (
          boundary === 'intent-snapshot' &&
          sql === "SELECT * FROM write_intents WHERE status='prepared'"
        ) {
          const all = stmt.all.bind(stmt);
          stmt.all = ((...values: any[]) => {
            const snapshot = all(...values);
            if (!raced) completeFromSecondProcess();
            return snapshot;
          }) as any;
        }
        if (boundary === 'note-read' && sql === 'SELECT * FROM notes WHERE id=?') {
          const get = stmt.get.bind(stmt);
          stmt.get = ((...values: any[]) => {
            if (!raced) completeFromSecondProcess();
            return get(...values);
          }) as any;
        }
        return stmt;
      }) as any;
      await core.recover();
      db.prepare = prepare;
      expect(raced).toBe(true);
      expect(
        prepare("SELECT status,result,error FROM operations WHERE request_id='crash-move'").get(),
      ).toEqual(committed);
      expect(prepare("SELECT status FROM write_intents WHERE kind='move'").get()).toMatchObject({
        status: 'recorded',
      });
      const receipt = JSON.parse(committed.result);
      expect(
        core.update(
          webPrincipal,
          n.id,
          '# writable after concurrent recovery',
          receipt.modifiedAt,
          'after-concurrent-recovery',
        ).id,
      ).toBe(n.id);
    } finally {
      db.prepare = prepare;
      db.close();
      await f.close();
    }
  });

for (const stage of ['occupied', 'source-changed'])
  it(`preserves both sides when an external writer makes move ${stage}`, async () => {
    const f = await createFixture({ fileTasks: { embedded: false } });
    const db = openDatabase(f.dataRoot);
    try {
      await mkdir(join(f.knowledgeRoot, '10-Projects'));
      const core = mutationCore(f.config as any, db),
        n = core.create(webPrincipal, '00-Inbox', 'source.md', '# durable original', 'make-move');
      await f.app.close();
      const configFile = join(f.root, 'move-config.json');
      await writeFile(configFile, JSON.stringify(f.config), { mode: 0o600 });
      const child = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          resolve('tests/support/move-fault-child.ts'),
          configFile,
          n.id,
          n.modifiedAt,
          stage,
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      let errors = '';
      child.stderr.on('data', (b) => {
        errors += String(b);
      });
      expect(
        await new Promise((yes, no) => {
          child.once('error', no);
          child.once('exit', yes);
        }),
        errors,
      ).toBe(73);
      await core.recover();
      noteService(f.config as any, db).scan();
      await reconcileService(f.config as any, db).reconcile();
      expect(db.prepare('SELECT id,path FROM notes WHERE active=1').all()).toEqual([
        { id: n.id, path: '00-Inbox/source.md' },
      ]);
      expect(
        db.prepare("SELECT status FROM operations WHERE request_id='crash-move'").get(),
      ).toMatchObject({ status: 'needs_reconciliation' });
      expect(await readFile(join(f.knowledgeRoot, '00-Inbox/source.md'), 'utf8')).toBe(
        stage === 'source-changed' ? '# external source' : '# durable original',
      );
      expect(await readFile(join(f.knowledgeRoot, '10-Projects/destination.md'), 'utf8')).toBe(
        stage === 'occupied' ? '# external target' : '# durable original',
      );
      expect(
        (await readdir(join(f.knowledgeRoot, '10-Projects'))).some(
          (name) => name.startsWith('.doo-move-') && name.endsWith('.tmp'),
        ),
      ).toBe(true);
    } finally {
      db.close();
      await f.close();
    }
  });

it('does not allocate another identity when scanning a conflicted create before owner resolution', async () => {
  const f = await createFixture({ fileTasks: { embedded: false } });
  const db = openDatabase(f.dataRoot);
  try {
    const n = mutationCore(f.config as any, db).create(
      webPrincipal,
      '00-Inbox',
      'unrecorded.md',
      '# original',
      'unrecorded-create',
    );
    db.prepare('UPDATE notes SET active=0 WHERE id=?').run(n.id);
    db.prepare(
      "UPDATE operations SET status='needs_reconciliation' WHERE request_id='unrecorded-create'",
    ).run();
    db.prepare("UPDATE write_intents SET status='conflicted' WHERE note_id=?").run(n.id);
    noteService(f.config as any, db).scan();
    await reconcileService(f.config as any, db).reconcile();
    expect(db.prepare('SELECT id FROM notes WHERE path=?').all(n.relativePath)).toEqual([
      { id: n.id },
    ]);
  } finally {
    db.close();
    await f.close();
  }
});

it('invalidates old path search chunks and schedules a fresh index revision after a move', async () => {
  const f = await createFixture({ fileTasks: { embedded: false } });
  const db = openDatabase(f.dataRoot);
  try {
    await mkdir(join(f.knowledgeRoot, '10-Projects'));
    const core = mutationCore(f.config as any, db),
      n = core.create(webPrincipal, '00-Inbox', 'source.md', '# indexed', 'indexed-create');
    const before = db
      .prepare('SELECT source_revision FROM document_state WHERE note_id=?')
      .get(n.id) as any;
    db.prepare("UPDATE index_jobs SET status='done' WHERE note_id=?").run(n.id);
    db.prepare('UPDATE document_state SET text_indexed_hash=content_hash WHERE note_id=?').run(
      n.id,
    );
    db.prepare(
      "INSERT INTO chunks(chunk_id,note_id,source_hash,source_revision,chunker_id,ordinal,heading_path,start_line,end_line,content,input_hash,title,path,active) VALUES('old-chunk',?,?,?,'fixture',0,'[]',1,1,'# indexed','hash','indexed',?,1)",
    ).run(n.id, n.contentHash, before.source_revision, n.relativePath);
    core.move(webPrincipal, n.id, '10-Projects', 'destination.md', n.modifiedAt, 'indexed-move');
    const after = db
      .prepare('SELECT source_revision,text_indexed_hash FROM document_state WHERE note_id=?')
      .get(n.id) as any;
    expect(after.source_revision).toBeGreaterThan(before.source_revision);
    expect(after.text_indexed_hash).toBeNull();
    expect(db.prepare('SELECT active FROM chunks WHERE chunk_id=?').get('old-chunk')).toMatchObject(
      { active: 0 },
    );
    expect(
      db
        .prepare("SELECT source_revision FROM index_jobs WHERE note_id=? AND status='pending'")
        .get(n.id),
    ).toMatchObject({ source_revision: after.source_revision });
  } finally {
    db.close();
    await f.close();
  }
});

it('allows exactly one of two owner dispositions of the same conflict', async () => {
  const f = await createFixture({ fileTasks: { embedded: false } });
  const db = openDatabase(f.dataRoot);
  try {
    const n = mutationCore(f.config as any, db).create(
      webPrincipal,
      '00-Inbox',
      'double-resolve.md',
      '# disk',
      'double-create',
    );
    db.prepare(
      "UPDATE operations SET status='needs_reconciliation' WHERE request_id='double-create'",
    ).run();
    db.prepare("UPDATE write_intents SET status='conflicted' WHERE note_id=?").run(n.id);
    const service = conflictService(f.config as any, db),
      conflict = (await service.list()).items[0];
    const payload = {
      strategy: 'keep_disk',
      expectedModifiedAt: conflict.disk!.modifiedAt,
      expectedContentHash: conflict.disk!.contentHash,
    };
    const outcomes = await Promise.allSettled([
      service.resolve(conflict.id, { ...payload, requestId: 'resolve-a' }),
      service.resolve(conflict.id, { ...payload, requestId: 'resolve-b' }),
    ]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await readFile(join(f.knowledgeRoot, n.relativePath), 'utf8')).toBe('# disk');
  } finally {
    db.close();
    await f.close();
  }
});

it('reports unsupported multi-file and Git conflicts without unlocking them', async () => {
  const f = await createFixture({ fileTasks: { embedded: false } });
  const db = openDatabase(f.dataRoot);
  try {
    const n = mutationCore(f.config as any, db).create(
      webPrincipal,
      '00-Inbox',
      'manual.md',
      '# disk',
      'manual-create',
    );
    db.prepare(
      "UPDATE operations SET status='needs_reconciliation' WHERE request_id='manual-create'",
    ).run();
    db.prepare("UPDATE write_intents SET kind='restore',status='conflicted' WHERE note_id=?").run(
      n.id,
    );
    const service = conflictService(f.config as any, db),
      manual = (await service.list()).items[0];
    expect(manual).toMatchObject({
      resolvable: false,
      reason: 'MULTI_FILE_RECONCILIATION_REQUIRED',
    });
    const input = {
      strategy: 'keep_disk',
      expectedModifiedAt: manual.disk!.modifiedAt,
      expectedContentHash: manual.disk!.contentHash,
      requestId: 'unsupported-restore',
    };
    await expect(service.resolve(manual.id, input)).rejects.toMatchObject({
      code: 'MULTI_FILE_RECONCILIATION_REQUIRED',
    });
    db.prepare("UPDATE write_intents SET kind='update' WHERE note_id=?").run(n.id);
    db.prepare(
      "INSERT INTO sync_runs(id,owner,status,lease_until,started_at) VALUES('git-conflict','fixture','needs_reconciliation',0,1)",
    ).run();
    const git = await service.list();
    expect(git.syncConflicts).toEqual([
      {
        id: 'git-conflict',
        status: 'needs_reconciliation',
        resolvable: false,
        reason: 'GIT_MANUAL_RECONCILIATION_REQUIRED',
      },
    ]);
    expect(git.items[0]).toMatchObject({
      resolvable: false,
      reason: 'GIT_MANUAL_RECONCILIATION_REQUIRED',
    });
    await expect(
      service.resolve(manual.id, { ...input, requestId: 'unsupported-git' }),
    ).rejects.toMatchObject({ code: 'GIT_MANUAL_RECONCILIATION_REQUIRED' });
    expect(db.prepare('SELECT status FROM write_intents WHERE id=?').get(manual.id)).toMatchObject({
      status: 'conflicted',
    });
    expect(await readFile(join(f.knowledgeRoot, n.relativePath), 'utf8')).toBe('# disk');
  } finally {
    db.close();
    await f.close();
  }
});

it('prevents a recovery holding a stale intent from replacing the owner disposition', async () => {
  const f = await createFixture({ fileTasks: { embedded: false } });
  const db = openDatabase(f.dataRoot);
  try {
    const core = mutationCore(f.config as any, db),
      n = core.create(
        webPrincipal,
        '00-Inbox',
        'stale-recovery.md',
        '# disk',
        'stale-recovery-create',
      );
    db.prepare(
      "UPDATE operations SET status='needs_reconciliation' WHERE request_id='stale-recovery-create'",
    ).run();
    db.prepare("UPDATE write_intents SET status='conflicted' WHERE note_id=?").run(n.id);
    const staleIntent = db.prepare('SELECT * FROM write_intents WHERE note_id=?').get(n.id) as any;
    const service = conflictService(f.config as any, db),
      conflict = (await service.list()).items[0];
    await service.resolve(conflict.id, {
      strategy: 'keep_disk',
      expectedModifiedAt: conflict.disk!.modifiedAt,
      expectedContentHash: conflict.disk!.contentHash,
      requestId: 'resolve-before-recovery',
    });
    expect(() => core.record(staleIntent)).toThrow();
    expect(
      db.prepare('SELECT status,error FROM operations WHERE id=?').get(conflict.id),
    ).toMatchObject({ status: 'failed', error: 'OWNER_KEPT_DISK' });
    expect(
      db.prepare('SELECT status FROM write_intents WHERE id=?').get(conflict.id),
    ).toMatchObject({ status: 'resolved' });
  } finally {
    db.close();
    await f.close();
  }
});

it('rejects a stale move and occupied destination without changing either file', async () => {
  const f = await createFixture({ fileTasks: { embedded: false } });
  const db = openDatabase(f.dataRoot);
  try {
    const core = mutationCore(f.config as any, db);
    const n = core.create(webPrincipal, '00-Inbox', 'a.md', '# A', 'create-a');
    core.create(webPrincipal, '00-Inbox', 'b.md', '# B', 'create-b');
    expect(() =>
      core.move(webPrincipal, n.id, '00-Inbox', 'b.md', n.modifiedAt, 'occupied'),
    ).toThrow();
    await writeFile(join(f.knowledgeRoot, '00-Inbox/a.md'), '# changed');
    expect(() =>
      core.move(webPrincipal, n.id, '00-Inbox', 'new.md', n.modifiedAt, 'stale'),
    ).toThrow();
    expect(await readFile(join(f.knowledgeRoot, '00-Inbox/a.md'), 'utf8')).toBe('# changed');
    expect(await readFile(join(f.knowledgeRoot, '00-Inbox/b.md'), 'utf8')).toBe('# B');
    expect(() =>
      core.move(webPrincipal, n.id, '../', 'escape.md', n.modifiedAt, 'escape'),
    ).toThrow();
  } finally {
    db.close();
    await f.close();
  }
});

for (const [label, reference] of [
  ['image', '![image](assets/image.png)'],
  ['PDF', '[manual](assets/manual.pdf)'],
  ['note', '[related](related.md)'],
  ['reference definition', '[related][target]\n\n[target]: ../00-Inbox/related.md'],
] as const)
  it(`refuses a cross-directory move with a relative ${label} reference and preserves the source`, async () => {
    const f = await createFixture({ fileTasks: { embedded: false } });
    const db = openDatabase(f.dataRoot);
    try {
      await mkdir(join(f.knowledgeRoot, '10-Projects'));
      const core = mutationCore(f.config as any, db),
        content = '# source\n\n' + reference,
        n = core.create(webPrincipal, '00-Inbox', 'source.md', content, 'relative-create');
      db.prepare('INSERT INTO shares(note_id,token) VALUES(?,?)').run(n.id, 'relative-test-share');
      expect(() =>
        core.move(
          webPrincipal,
          n.id,
          '10-Projects',
          'destination.md',
          n.modifiedAt,
          'relative-move',
        ),
      ).toThrowError(
        expect.objectContaining({ code: 'RELATIVE_REFERENCES_REQUIRE_REVIEW', statusCode: 409 }),
      );
      expect(await readFile(join(f.knowledgeRoot, n.relativePath), 'utf8')).toBe(content);
      expect(db.prepare('SELECT path FROM notes WHERE id=?').get(n.id)).toMatchObject({
        path: n.relativePath,
      });
      expect(db.prepare('SELECT enabled FROM shares WHERE note_id=?').get(n.id)).toMatchObject({
        enabled: 1,
      });
      expect(await readdir(join(f.knowledgeRoot, '10-Projects'))).toEqual([]);
    } finally {
      db.close();
      await f.close();
    }
  });

for (const [label, reference] of [
  ['absolute URL', '[website](https://example.com/reference.md)'],
  ['root absolute path', '[attachment](/api/assets/asset-id)'],
  ['anchor', '[section](#heading)'],
  ['fenced example', '```md\n![example](assets/example.png)\n```'],
] as const)
  it(`allows a cross-directory move with an unaffected ${label}`, async () => {
    const f = await createFixture({ fileTasks: { embedded: false } });
    const db = openDatabase(f.dataRoot);
    try {
      await mkdir(join(f.knowledgeRoot, '10-Projects'));
      const core = mutationCore(f.config as any, db),
        content = '# source\n\n' + reference,
        n = core.create(webPrincipal, '00-Inbox', 'source.md', content, 'unaffected-create');
      const moved = core.move(
        webPrincipal,
        n.id,
        '10-Projects',
        'destination.md',
        n.modifiedAt,
        'unaffected-move',
      );
      expect(moved.id).toBe(n.id);
      expect(await readFile(join(f.knowledgeRoot, moved.relativePath), 'utf8')).toBe(content);
    } finally {
      db.close();
      await f.close();
    }
  });

for (const content of [
  'x'.repeat(2 * 1024 * 1024),
  'x'.repeat(32769),
  '![image](assets/image.png)',
])
  it(`supports a same directory rename while refusing an unsafe cross-directory scan (${Buffer.byteLength(content)} bytes)`, async () => {
    const f = await createFixture({ fileTasks: { embedded: false } });
    const db = openDatabase(f.dataRoot);
    try {
      await mkdir(join(f.knowledgeRoot, '10-Projects'));
      const core = mutationCore(f.config as any, db),
        n = core.create(webPrincipal, '00-Inbox', 'source.md', '# source', 'same-directory-create');
      const file = join(f.knowledgeRoot, n.relativePath);
      await writeFile(file, content);
      const expected = (await stat(file, { bigint: true })).mtimeNs.toString();
      const code = content.startsWith('!')
        ? 'RELATIVE_REFERENCES_REQUIRE_REVIEW'
        : 'CROSS_DIRECTORY_MOVE_REQUIRES_REVIEW';
      expect(() =>
        core.move(
          webPrincipal,
          n.id,
          '10-Projects',
          'destination.md',
          expected,
          'cross-directory-move',
        ),
      ).toThrowError(expect.objectContaining({ code, statusCode: 409 }));
      const renamed = core.move(
        webPrincipal,
        n.id,
        '00-Inbox',
        'renamed.md',
        expected,
        'same-directory-rename',
      );
      expect(renamed.id).toBe(n.id);
      expect(await readFile(join(f.knowledgeRoot, renamed.relativePath), 'utf8')).toBe(content);
    } finally {
      db.close();
      await f.close();
    }
  });

it('requires a checked disk version to preserve evidence and unlock an owner conflict exactly once', async () => {
  const f = await createFixture({ fileTasks: { embedded: false } });
  const db = openDatabase(f.dataRoot);
  try {
    const h = await loginFixtureOwner(f);
    const core = mutationCore(f.config as any, db);
    const n = core.create(webPrincipal, '00-Inbox', 'conflict.md', '# original', 'conflict-create');
    const pending = join(f.knowledgeRoot, '00-Inbox', '.doo-conflict.tmp');
    await writeFile(pending, '# proposed');
    await writeFile(join(f.knowledgeRoot, n.relativePath), '# local');
    db.prepare(
      "INSERT INTO operations(id,principal,client_id,kind,request_id,params_hash,status,error,created_at,updated_at) VALUES('conflicted-op','web-owner','browser','update','lost-write','hash','needs_reconciliation','EXTERNAL_CHANGE',1,1)",
    ).run();
    db.prepare(
      "INSERT INTO write_intents(id,note_id,path,kind,original_hash,target_hash,temp_path,status) VALUES('conflicted-op',?,?,'update',?,?,?,'conflicted')",
    ).run(n.id, n.relativePath, sha256('# original'), sha256('# proposed'), pending);
    const list = await f.app.inject({ url: '/api/maintenance/conflicts', headers: h });
    expect(list.statusCode).toBe(200);
    const conflict = list.json().items.find((item: any) => item.id === 'conflicted-op');
    expect(conflict).toMatchObject({ resolvable: true, disk: { contentHash: sha256('# local') } });
    const payload = {
      strategy: 'keep_disk',
      expectedModifiedAt: conflict.disk.modifiedAt,
      expectedContentHash: conflict.disk.contentHash,
      requestId: 'keep-local',
    };
    const stale = await f.app.inject({
      method: 'POST',
      url: '/api/maintenance/conflicts/conflicted-op/resolve',
      headers: h,
      payload: {
        ...payload,
        expectedContentHash: sha256('# obsolete'),
        requestId: 'stale-resolution',
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(
      db.prepare('SELECT status FROM write_intents WHERE id=?').get('conflicted-op'),
    ).toMatchObject({ status: 'conflicted' });
    const resolved = await f.app.inject({
      method: 'POST',
      url: '/api/maintenance/conflicts/conflicted-op/resolve',
      headers: h,
      payload,
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toMatchObject({
      id: 'conflicted-op',
      resolved: true,
      evidencePreserved: true,
      contentHash: sha256('# local'),
    });
    expect(await readFile(pending, 'utf8')).toBe('# proposed');
    expect(await readFile(join(f.knowledgeRoot, n.relativePath), 'utf8')).toBe('# local');
    const evidence = await readdir(join(f.dataRoot, 'reconciliation', resolved.json().operationId));
    expect(evidence).toContain('manifest.json');
    expect(evidence).toContain('disk.md');
    expect(evidence).toContain('staged.md');
    const again = await f.app.inject({
      method: 'POST',
      url: '/api/maintenance/conflicts/conflicted-op/resolve',
      headers: h,
      payload,
    });
    expect(again.json()).toEqual(resolved.json());
    expect(
      (await f.app.inject({ url: '/api/maintenance/conflicts', headers: h })).json().items,
    ).toHaveLength(0);
    const after = core.update(
      webPrincipal,
      n.id,
      '# after',
      resolved.json().modifiedAt,
      'after-resolved',
    );
    expect(after.contentHash).toBe(sha256('# after'));
    expect((await f.app.inject({ url: '/api/maintenance/conflicts' })).statusCode).toBe(401);
  } finally {
    db.close();
    await f.close();
  }
});
