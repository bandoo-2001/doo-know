import { it, expect } from 'vitest';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createFixture, loginFixtureOwner, type Fixture } from '../support/fixture.js';
import { createApp } from '../../server/app.js';
import { openDatabase } from '../../server/db.js';

async function make(f: Fixture, h: any, name: string, content: string) {
  const r = await f.app.inject({
    method: 'POST',
    url: '/api/notes',
    headers: h,
    payload: { folderPath: '00-Inbox', fileName: name, content },
  });
  expect(r.statusCode).toBe(201);
  return r.json();
}
async function archive(f: Fixture, h: any, n: any) {
  const r = await f.app.inject({
    method: 'DELETE',
    url: `/api/notes/${n.id}`,
    headers: h,
    payload: { expectedModifiedAt: n.modifiedAt, requestId: 'archive-' + n.id },
  });
  expect(r.statusCode).toBe(200);
  return join(f.knowledgeRoot, '90-Archive/.trash', n.id, n.relativePath.split('/').at(-1)!);
}
async function child(f: Fixture, n: any, source: string, fault: string) {
  const cfg = join(f.root, 'independent-config.json');
  await writeFile(cfg, JSON.stringify(f.config), { mode: 0o600 });
  const p = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      resolve('tests/support/independent-restore-fault-child.ts'),
      cfg,
      n.id,
      source,
      join(f.knowledgeRoot, n.relativePath),
      fault,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '',
    errors = '';
  p.stdout.on('data', (bytes) => (output += bytes.toString()));
  p.stderr.on('data', (bytes) => (errors = (errors + bytes.toString()).slice(-4000)));
  const timeout = setTimeout(() => p.kill('SIGKILL'), 20000);
  try {
    const code = await new Promise<number | null>((yes, no) => {
      p.once('error', no);
      p.once('exit', yes);
    });
    return { code, output, errors };
  } finally {
    clearTimeout(timeout);
  }
}

// Missing active database-path protection must never expose restored A via B's share.
it('W03 guards a database-occupied path and never serves archived private bytes through another share', async () => {
  const f = await createFixture();
  try {
    const h = await loginFixtureOwner(f);
    const a = await make(f, h, 'occupied.md', '# private archived A');
    const source = await archive(f, h, a);
    const b = await make(f, h, 'occupied.md', '# public B');
    const shared = await f.app.inject({
      method: 'POST',
      url: `/api/notes/${b.id}/share`,
      headers: h,
      payload: {},
    });
    expect(shared.statusCode).toBe(200);
    const token = shared.json().token;
    await unlink(join(f.knowledgeRoot, b.relativePath));
    const r = await f.app.inject({
      method: 'POST',
      url: `/api/notes/${a.id}/restore`,
      headers: h,
      payload: { requestId: 'restore-occupied' },
    });
    const publicRead = await f.app.inject({ url: `/api/public/shares/${token}` });
    expect(publicRead.statusCode).toBe(404);
    if (r.statusCode === 200) {
      expect(r.json().id).toBe(a.id);
      expect((await f.app.inject({ url: `/api/notes/${a.id}`, headers: h })).json().content).toBe(
        '# private archived A',
      );
    } else {
      expect(r.statusCode).toBe(409);
      expect(await readFile(source, 'utf8')).toBe('# private archived A');
    }
  } finally {
    await f.close();
  }
});

// Removal of the last durable body copy is the break this process fault catches.
it('W03 keeps a durable body copy when another process removes the published target before source cleanup', async () => {
  const f = await createFixture({ fileTasks: { embedded: false } });
  try {
    const h = await loginFixtureOwner(f);
    const n = await make(f, h, 'race.md', '# sole recoverable body');
    const source = await archive(f, h, n);
    await f.app.close();
    const result = await child(f, n, source, 'target-disappears');
    expect(result.code, result.errors).toBe(0);
    const evidence = JSON.parse(result.output);
    expect(evidence.injected).toBe(true);
    expect(evidence.competingExit).toBe(0);
    expect(evidence.copies.some((copy: any) => copy.content === '# sole recoverable body')).toBe(
      true,
    );
    const restarted = await createApp({
      ...f.config,
      indexing: { enabled: true, watch: false, embedded: false },
    });
    try {
      const reopened = await restarted.inject({ url: `/api/notes/${n.id}`, headers: h });
      expect(reopened.statusCode).toBe(200);
      expect(reopened.json().content).toBe('# sole recoverable body');
      expect((await restarted.inject({ url: '/api/trash', headers: h })).json()).toEqual([]);
    } finally {
      await restarted.close();
    }
  } finally {
    await f.close();
  }
});

// Index reconcile must not allocate a second ID for an unresolved restore path.
it('W03 preserves the original identity when startup indexing encounters a conflicted interrupted restore', async () => {
  const f = await createFixture({ fileTasks: { embedded: false } });
  try {
    const h = await loginFixtureOwner(f);
    let n = await make(f, h, 'conflict.md', '# version A');
    const updated = await f.app.inject({
      method: 'PUT',
      url: `/api/notes/${n.id}`,
      headers: h,
      payload: { content: '# version B', expectedModifiedAt: n.modifiedAt, requestId: 'save-B' },
    });
    expect(updated.statusCode).toBe(200);
    n = updated.json();
    await f.app.inject({
      method: 'POST',
      url: `/api/notes/${n.id}/share`,
      headers: h,
      payload: {},
    });
    await archive(f, h, n);
    await f.app.close();
    const cfg = join(f.root, 'crash-config.json');
    await writeFile(cfg, JSON.stringify(f.config), { mode: 0o600 });
    const p = spawn(
      process.execPath,
      ['--import', 'tsx', resolve('tests/support/restore-crash-child.ts'), cfg, n.id, 'unlink'],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let errors = '';
    p.stderr.on('data', (bytes) => (errors += bytes.toString()));
    const timeout = setTimeout(() => p.kill('SIGKILL'), 20000);
    let code: number | null;
    try {
      code = await new Promise((yes, no) => {
        p.once('error', no);
        p.once('exit', yes);
      });
    } finally {
      clearTimeout(timeout);
    }
    expect(code, errors).toBe(73);
    await writeFile(join(f.knowledgeRoot, n.relativePath), '# external change after restore crash');
    const app = await createApp({
      ...f.config,
      indexing: { enabled: true, watch: false, embedded: false },
    });
    const db = openDatabase(f.dataRoot);
    try {
      const rows = db.prepare('SELECT id FROM notes WHERE path=?').all(n.relativePath);
      expect(rows).toEqual([{ id: n.id }]);
      const trash = (await app.inject({ url: '/api/trash', headers: h })).json();
      expect(trash).toEqual([{ id: n.id, relativePath: n.relativePath }]);
      expect(
        await readFile(join(f.knowledgeRoot, '90-Archive/.trash', n.id, 'conflict.md'), 'utf8'),
      ).toBe('# version B');

      expect(
        (db.prepare('SELECT count(*) n FROM revisions WHERE note_id=?').get(n.id) as any).n,
      ).toBe(1);
      expect(
        (db.prepare('SELECT enabled FROM shares WHERE note_id=?').get(n.id) as any).enabled,
      ).toBe(0);
      expect(await readFile(join(f.knowledgeRoot, n.relativePath), 'utf8')).toBe(
        '# external change after restore crash',
      );
    } finally {
      db.close();
      await app.close();
    }
  } finally {
    await f.close();
  }
});

// A partial private copy must be rebuilt from preserved source after real exit.
it('W03 recovers a partial staged copy with indexing enabled while retaining history and private share state', async () => {
  const f = await createFixture({ fileTasks: { embedded: false } });
  try {
    const h = await loginFixtureOwner(f);
    let n = await make(f, h, 'partial.md', '# previous body');
    const r = await f.app.inject({
      method: 'PUT',
      url: `/api/notes/${n.id}`,
      headers: h,
      payload: {
        content: '# restored full body',
        expectedModifiedAt: n.modifiedAt,
        requestId: 'save-full',
      },
    });
    expect(r.statusCode).toBe(200);
    n = r.json();
    await f.app.inject({
      method: 'POST',
      url: `/api/notes/${n.id}/share`,
      headers: h,
      payload: {},
    });
    const source = await archive(f, h, n);
    await f.app.close();
    const result = await child(f, n, source, 'partial-copy');
    expect(result.code, result.errors).toBe(73);
    expect(existsSync(source)).toBe(true);
    const app = await createApp({
      ...f.config,
      indexing: { enabled: true, watch: false, embedded: false },
    });
    const db = openDatabase(f.dataRoot);
    try {
      expect((await app.inject({ url: `/api/notes/${n.id}`, headers: h })).json().content).toBe(
        '# restored full body',
      );
      expect((await app.inject({ url: '/api/trash', headers: h })).json()).toEqual([]);
      expect(
        (
          await app.inject({ url: '/api/operations?requestId=independent-restore', headers: h })
        ).json(),
      ).toMatchObject({ status: 'succeeded', result: { id: n.id, restored: true } });
      expect(
        db.prepare('SELECT id FROM notes WHERE path=? AND active=1').all(n.relativePath),
      ).toEqual([{ id: n.id }]);
      expect(
        (db.prepare('SELECT count(*) n FROM revisions WHERE note_id=?').get(n.id) as any).n,
      ).toBe(1);
      expect(
        (db.prepare('SELECT enabled FROM shares WHERE note_id=?').get(n.id) as any).enabled,
      ).toBe(0);
      expect(
        (db.prepare('SELECT active FROM document_state WHERE note_id=?').get(n.id) as any).active,
      ).toBe(1);
    } finally {
      db.close();
      await app.close();
    }
  } finally {
    await f.close();
  }
});

it('W03 hashes large restore files within the block I/O budget', async () => {
  const f = await createFixture();
  try {
    const h = await loginFixtureOwner(f);
    const n = await make(f, h, 'budget.md', '# initial');
    const content = 'restore-budget-line\n'.repeat(120000);
    await writeFile(join(f.knowledgeRoot, n.relativePath), content);
    const meta = (await f.app.inject({ url: `/api/notes/${n.id}/meta`, headers: h })).json();
    const source = await archive(f, h, { ...n, modifiedAt: meta.modifiedAt });
    await f.app.close();
    const result = await child(f, n, source, 'bounded-read');
    expect(result.code, result.errors).toBe(0);
    expect(JSON.parse(result.output).error).toBeUndefined();
    expect(await readFile(join(f.knowledgeRoot, n.relativePath), 'utf8')).toBe(content);
  } finally {
    await f.close();
  }
});
