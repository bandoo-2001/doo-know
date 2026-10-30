import { afterEach, expect, it } from 'vitest';
import {
  lstatSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  unlinkSync,
  renameSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../packages/core/db';
import { createGraphService } from '../packages/core/graph/service';
import { webPrincipal } from '../packages/core/knowledge/core';
import type { AppConfig } from '../shared/contracts';
import { noteService, type NoteService } from '../packages/core/notes';
const clean: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of clean.splice(0).reverse()) await fn();
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'graph-test-'));
  const config = {
    knowledgeRoot: join(root, 'notes'),
    dataRoot: join(root, 'data'),
    secret: 'test',
    origin: 'http://test',
  } satisfies AppConfig;
  mkdirSync(config.knowledgeRoot);
  const db = openDatabase(config.dataRoot);
  const service = createGraphService(config, db, {} as NoteService);
  clean.push(
    () => rmSync(root, { recursive: true, force: true }),
    () => db.close(),
    () => service.close(),
  );
  function note(id: string, path: string, content = '') {
    mkdirSync(join(config.knowledgeRoot, path, '..'), { recursive: true });
    writeFileSync(join(config.knowledgeRoot, path), content);
    db.prepare('INSERT INTO notes(id,path) VALUES(?,?)').run(id, path);
  }
  return { config, db, service, note };
}
it('extracts only rendered links, deduplicates, and resolves late targets', async () => {
  const f = setup();
  f.note('a', '00-Inbox/a.md', '# A\n[[b]] [same](b.md) `[[c]]` ![x](c.md)');
  let r = await f.service.query(webPrincipal, {});
  expect(r.edges).toEqual([]);
  f.note('b', '00-Inbox/b.md', '# B');
  f.note('c', '00-Inbox/c.md');
  r = await f.service.query(webPrincipal, {});
  expect(r.edges.map((e) => [e.source, e.target])).toEqual([['a', 'b']]);
  expect(r.nodes.find((n) => n.id === 'a')).toMatchObject({ title: 'A', incoming: 0, outgoing: 1 });
});
it('filters permissions before degrees, totals, focus and orphan selection', async () => {
  const f = setup();
  f.note('a', '00-Inbox/a.md', '[secret](../20-Areas/s.md)');
  f.note('s', '20-Areas/s.md', '[a](../00-Inbox/a.md)');
  const p = { ...webPrincipal, knowledgeAll: false, allowedPrefixes: ['00-Inbox'] };
  const r = await f.service.query(p, { mode: 'orphans' });
  expect(r.totalNodes).toBe(1);
  expect(r.totalEdges).toBe(0);
  expect(r.nodes[0]).toMatchObject({ id: 'a', incoming: 0, outgoing: 0 });
  await expect(f.service.query(p, { focus: 's' })).rejects.toMatchObject({ statusCode: 403 });
  await expect(f.service.query({ ...p, id: 'share:abc' }, {})).rejects.toMatchObject({
    statusCode: 403,
  });
});
it('invalidates external edits, deletion, symlinks, invalid encoding and path moves', async () => {
  const f = setup();
  f.note('a', '00-Inbox/a.md', '[[b]]');
  f.note('b', '00-Inbox/b.md');
  expect((await f.service.query(webPrincipal, {})).edges).toHaveLength(1);
  writeFileSync(join(f.config.knowledgeRoot, '00-Inbox/a.md'), '[[missing]]');
  expect((await f.service.query(webPrincipal, {})).edges).toHaveLength(0);
  writeFileSync(join(f.config.knowledgeRoot, '00-Inbox/a.md'), '[[b]]');
  expect((await f.service.query(webPrincipal, {})).edges).toHaveLength(1);
  unlinkSync(join(f.config.knowledgeRoot, '00-Inbox/b.md'));
  expect((await f.service.query(webPrincipal, {})).nodes.map((n) => n.id)).toEqual(['a']);
  symlinkSync(
    join(f.config.knowledgeRoot, '00-Inbox/a.md'),
    join(f.config.knowledgeRoot, '00-Inbox/b.md'),
  );
  expect((await f.service.query(webPrincipal, {})).edges).toHaveLength(0);
  writeFileSync(join(f.config.knowledgeRoot, '00-Inbox/a.md'), Buffer.from([255]));
  expect((await f.service.query(webPrincipal, {})).nodes).toHaveLength(0);
});
it('induces filters, expands undirected focus with directed edges and limits output', async () => {
  const f = setup();
  f.note('a', '00-Inbox/a.md', '[[b]]');
  f.note('b', '00-Inbox/b.md', '[[c]]');
  f.note('c', '00-Inbox/c.md');
  let r = await f.service.query(webPrincipal, { focus: 'c' });
  expect(r.nodes.map((n) => n.id).sort()).toEqual(['b', 'c']);
  r = await f.service.query(webPrincipal, { focus: 'c', depth: 2 });
  expect(r.totalNodes).toBe(3);
  r = await f.service.query(webPrincipal, { q: 'a.md' });
  expect(r.totalEdges).toBe(0);
  r = await f.service.query(webPrincipal, { limit: 1 });
  expect(r.nodes).toHaveLength(1);
  expect(r.truncated).toBe(true);
});
it('rejects unknown and oversized runtime inputs', async () => {
  const f = setup();
  for (const input of [
    { extra: true },
    { depth: 3 },
    { limit: 0 },
    { limit: 1001 },
    { q: 'x'.repeat(257) },
    { folder: '../x' },
  ])
    await expect(f.service.query(webPrincipal, input as never)).rejects.toMatchObject({
      statusCode: 400,
    });
});
it('continues bounded rounds and serializes concurrent requests', async () => {
  const f = setup();
  for (let i = 0; i < 140; i++) f.note(String(i), `00-Inbox/${i}.md`, '# Note');
  const first = await f.service.query(webPrincipal, {});
  expect(first.index.pending).toBeGreaterThan(0);
  const results = await Promise.all([
    f.service.query(webPrincipal, {}),
    f.service.query(webPrincipal, {}),
  ]);
  expect(results.at(-1)?.index.complete).toBe(true);
  expect(results.at(-1)?.nodes).toHaveLength(140);
});
it('re-resolves moved targets and reparses moved sources with stable note ids', async () => {
  const f = setup();
  f.note('a', '00-Inbox/a.md', '[[b]]');
  f.note('b', '00-Inbox/b.md');
  expect((await f.service.query(webPrincipal, {})).edges).toHaveLength(1);
  renameSync(
    join(f.config.knowledgeRoot, '00-Inbox/b.md'),
    join(f.config.knowledgeRoot, '00-Inbox/c.md'),
  );
  f.db.prepare('UPDATE notes SET path=? WHERE id=?').run('00-Inbox/c.md', 'b');
  expect((await f.service.query(webPrincipal, {})).edges).toHaveLength(0);
  writeFileSync(join(f.config.knowledgeRoot, '00-Inbox/a.md'), '[[c]]');
  expect((await f.service.query(webPrincipal, {})).edges[0]).toMatchObject({
    source: 'a',
    target: 'b',
  });
  mkdirSync(join(f.config.knowledgeRoot, '20-Areas'));
  renameSync(
    join(f.config.knowledgeRoot, '00-Inbox/a.md'),
    join(f.config.knowledgeRoot, '20-Areas/a.md'),
  );
  f.db.prepare('UPDATE notes SET path=? WHERE id=?').run('20-Areas/a.md', 'a');
  expect((await f.service.query(webPrincipal, {})).edges).toHaveLength(0);
});
it('withdraws conflicts and oversized sources, respects maintenance, and recovers after repairs', async () => {
  const f = setup();
  f.note('a', '00-Inbox/a.md', '[[b]]');
  f.note('b', '00-Inbox/b.md');
  expect((await f.service.query(webPrincipal, {})).edges).toHaveLength(1);
  f.db.prepare('INSERT INTO document_state(note_id,conflict) VALUES(?,1)').run('b');
  let r = await f.service.query(webPrincipal, {});
  expect(r.nodes.map((n) => n.id)).toEqual(['a']);
  expect(r.edges).toHaveLength(0);
  expect(r.index.complete).toBe(false);
  f.db.prepare('UPDATE document_state SET conflict=0 WHERE note_id=?').run('b');
  expect((await f.service.query(webPrincipal, {})).edges).toHaveLength(1);
  writeFileSync(join(f.config.knowledgeRoot, '00-Inbox/a.md'), 'x'.repeat(256 * 1024 + 1));
  r = await f.service.query(webPrincipal, {});
  expect(r.nodes.map((n) => n.id)).toEqual(['b']);
  expect(r.index.skipped).toBe(1);
  f.db.prepare('UPDATE maintenance SET active=1 WHERE id=1').run();
  await expect(f.service.query(webPrincipal, {})).rejects.toMatchObject({ statusCode: 503 });
});
it('continues after the byte budget and does not reread unchanged persisted cache entries', async () => {
  const f = setup();
  for (let i = 0; i < 20; i++) f.note(String(i), `00-Inbox/${i}.md`, 'x'.repeat(240 * 1024));
  let r = await f.service.query(webPrincipal, {});
  expect(r.index.pending).toBeGreaterThan(0);
  expect(r.index.indexed).toBeLessThan(20);
  r = await f.service.query(webPrincipal, {});
  expect(r.index.pending).toBe(0);
  expect(r.nodes).toHaveLength(20);
  f.db.prepare("UPDATE graph_sources SET title='persisted cached title' WHERE note_id='0'").run();
  r = await f.service.query(webPrincipal, {});
  expect(r.nodes.find((n) => n.id === '0')?.title).toBe('persisted cached title');
});

it('distinguishes missing focus from unauthorized focus', async () => {
  const f = setup();
  await expect(f.service.query(webPrincipal, { focus: 'not-a-note' })).rejects.toMatchObject({
    statusCode: 404,
  });
});

it('retains failed-source completeness across continuation rounds', async () => {
  const f = setup();
  f.note('bad', '00-Inbox/bad.md');
  writeFileSync(join(f.config.knowledgeRoot, '00-Inbox/bad.md'), Buffer.from([255]));
  for (let i = 0; i < 140; i++) f.note(String(i), `00-Inbox/${i}.md`);
  expect((await f.service.query(webPrincipal, {})).index.skipped).toBe(1);
  const last = await f.service.query(webPrincipal, {});
  expect(last.index.pending).toBe(0);
  expect(last.index.skipped).toBe(1);
  expect(last.index.complete).toBe(false);
});

it('applies search and folder before the candidate cap and prioritizes focus centers', async () => {
  const f = setup();
  f.db.transaction(() => {
    for (let i = 0; i < 5001; i++) {
      f.db
        .prepare('INSERT INTO notes(id,path) VALUES(?,?)')
        .run(`early-${i}`, `00-Inbox/early-${i}.md`);
      f.db
        .prepare('INSERT INTO graph_sources VALUES(?,?,?,?,?)')
        .run(`early-${i}`, `00-Inbox/early-${i}.md`, 'missing', 'Earlier', '[]');
    }
  })();
  f.note('tail', '20-Areas/Needle.md', '# Needle');
  const stat = lstatSync(join(f.config.knowledgeRoot, '20-Areas/Needle.md'), { bigint: true });
  const version = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.nlink]
    .map(String)
    .join(':');
  f.db
    .prepare('INSERT INTO graph_sources VALUES(?,?,?,?,?)')
    .run('tail', '20-Areas/Needle.md', version, 'Needle', '[]');
  for (const query of [
    { q: 'needle' },
    { q: 'Needle' },
    { folder: '20-Areas' },
    { focus: 'tail' },
  ]) {
    const r = await f.service.query(webPrincipal, query);
    expect(r.nodes.some((n) => n.id === 'tail')).toBe(true);
  }
});
it('counts dense graph degrees and orphans beyond the displayed edge budget', async () => {
  const f = setup();
  const count = 170;
  for (let i = 0; i < count; i++)
    f.note(
      String(i),
      `00-Inbox/${i}.md`,
      Array.from({ length: count }, (_, j) => `[[${j}]]`).join(' '),
    );
  await f.service.query(webPrincipal, {});
  const r = await f.service.query(webPrincipal, {});
  expect(r.totalEdges).toBe(count * (count - 1));
  expect(r.edges).toHaveLength(5000);
  expect(r.nodes.every((n) => n.incoming === count - 1 && n.outgoing === count - 1)).toBe(true);
  expect(r.truncated).toBe(true);
  expect((await f.service.query(webPrincipal, { mode: 'orphans' })).totalNodes).toBe(0);
});

it('bounds queued requests and releases capacity after completion', async () => {
  const f = setup();
  f.note('a', '00-Inbox/a.md');
  const requests = Array.from({ length: 10 }, () => f.service.query(webPrincipal, {}));
  const results = await Promise.allSettled(requests);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(8);
  for (const result of results)
    if (result.status === 'rejected')
      expect(result.reason).toMatchObject({ statusCode: 429, code: 'GRAPH_BUSY', retryable: true });
  expect((await f.service.query(webPrincipal, {})).nodes).toHaveLength(1);
});

it('retains invalidations behind the cursor until the source is reprocessed', async () => {
  const f = setup();
  for (let i = 0; i < 300; i++) f.note(String(i), `00-Inbox/${i}.md`);
  for (let i = 0; i < 4; i++) await f.service.query(webPrincipal, {});
  writeFileSync(join(f.config.knowledgeRoot, '00-Inbox/0.md'), 'changed');
  let r = await f.service.query(webPrincipal, {});
  expect(r.index.pending).toBe(1);
  expect(r.index.complete).toBe(false);
  r = await f.service.query(webPrincipal, {});
  expect(r.index.pending).toBe(1);
  expect(r.index.complete).toBe(false);
  r = await f.service.query(webPrincipal, {});
  expect(r.index.pending).toBe(0);
  expect(r.index.complete).toBe(true);
  expect(r.totalNodes).toBe(300);
});
it('clears persisted failure progress after repairing the original file', async () => {
  const f = setup();
  f.note('bad', '00-Inbox/bad.md');
  writeFileSync(join(f.config.knowledgeRoot, '00-Inbox/bad.md'), Buffer.from([255]));
  expect((await f.service.query(webPrincipal, {})).index.skipped).toBe(1);
  writeFileSync(join(f.config.knowledgeRoot, '00-Inbox/bad.md'), '# Repaired');
  const r = await f.service.query(webPrincipal, {});
  expect(r.index.skipped).toBe(0);
  expect(r.index.complete).toBe(true);
  expect(r.nodes[0]?.title).toBe('Repaired');
});

it('normalizes mixed-case keywords before SQL candidate filtering', async () => {
  const f = setup();
  f.note('needle', '00-Inbox/Needle.md', '# Mixed Needle');
  const lower = await f.service.query(webPrincipal, { q: 'needle' });
  const mixed = await f.service.query(webPrincipal, { q: '  NeEdLe  ' });
  expect(mixed.nodes).toEqual(lower.nodes);
  expect(mixed.totalNodes).toBe(1);
});

it('keeps authorization coverage case-sensitive for legacy and v2 resource grants', async () => {
  const f = setup();
  f.note('allowed', 'Public/笔记😀/a.md');
  f.note('hidden', 'public/笔记😀/secret.md');
  f.note('sibling', 'Public/笔记😀extra/secret.md');
  const base = { ...webPrincipal, knowledgeAll: false, allowedPrefixes: ['Public/笔记😀'] };
  for (const principal of [
    base,
    {
      ...base,
      policyVersion: 2 as const,
      permissionPolicy: {
        version: 2 as const,
        domains: {
          knowledge: {
            enabled: true,
            ownerId: webPrincipal.id,
            instanceId: 'test-library',
            actions: ['read'],
            resources: {
              mode: 'selected' as const,
              resources: [{ kind: 'directory', id: 'folder' }],
            },
          },
        },
      },
      allowedPrefixes: [],
      knowledgeResourcePaths: [{ kind: 'directory', id: 'folder', path: 'Public/笔记😀' }],
    },
    {
      ...base,
      allowedPrefixes: [],
      knowledgeResourcePaths: [{ kind: 'note', id: 'allowed', path: 'Public/笔记😀/a.md' }],
    },
  ]) {
    const result = await f.service.query(principal, {});
    expect(result.nodes.map((n) => n.id)).toEqual(['allowed']);
    expect(result.index).toMatchObject({ pending: 0, skipped: 0, complete: true });
  }
  expect((await f.service.query({ ...base, knowledgeAll: true }, {})).totalNodes).toBe(3);
});

// Schedule real work between graph batches, without replacing filesystem or database methods.
function atTurn(turn: number, action: () => void) {
  let active = true;
  const next = () =>
    setImmediate(() => {
      if (!active) return;
      if (--turn === 0) action();
      else next();
    });
  next();
  return () => {
    active = false;
  };
}

it.each([4, 7, 14, 23])(
  'withdraws a completed managed save before publication (turn %i)',
  async (turn) => {
    const f = setup();
    const notes = noteService(f.config, f.db);
    for (let i = 0; i < 96; i++)
      f.note(String(i), `${i}.md`, i === 0 ? '# Before\n[[1]]' : '# Other');
    await f.service.query(webPrincipal, {});
    let saved = false;
    const stop = atTurn(turn, () => {
      notes.saveNote('0', '# After\nNo links', notes.getNote('0').modifiedAt);
      saved = true;
    });
    try {
      const result = await f.service.query(webPrincipal, {});
      expect(saved).toBe(true);
      expect(result.nodes.some((n) => n.id === '0' && n.title === 'Before')).toBe(false);
      expect(result.edges).toHaveLength(0);
      expect(result.nodes.find((n) => n.id === '1')).toMatchObject({ incoming: 0, outgoing: 0 });
      expect(result.index.complete).toBe(false);
      expect((await f.service.query(webPrincipal, {})).nodes.find((n) => n.id === '0')?.title).toBe(
        'After',
      );
    } finally {
      stop();
    }
  },
);

it('yields during dense relation processing and rechecks the maintenance barrier', async () => {
  const f = setup();
  const links = Array.from({ length: 96 }, (_, i) => `[[${i}]]`).join(' ');
  for (let i = 0; i < 96; i++) f.note(String(i), `${i}.md`, links);
  await f.service.query(webPrincipal, {});
  const stop = atTurn(7, () => f.db.prepare('UPDATE maintenance SET active=1 WHERE id=1').run());
  try {
    await expect(f.service.query(webPrincipal, { focus: '0', depth: 2 })).rejects.toMatchObject({
      statusCode: 503,
      code: 'SYNC_IN_PROGRESS',
    });
  } finally {
    stop();
  }
});

it('excludes unauthorized case variants before the candidate cap', async () => {
  const f = setup();
  f.db.transaction(() => {
    for (let i = 0; i < 5001; i++) {
      const id = `hidden-${i}`,
        path = `public/${i}.md`;
      f.db.prepare('INSERT INTO notes(id,path) VALUES(?,?)').run(id, path);
      f.db
        .prepare('INSERT INTO graph_sources VALUES(?,?,?,?,?)')
        .run(id, path, 'missing', 'Hidden', '[]');
    }
  })();
  f.note('allowed', 'Public/a.md', '# Allowed');
  const principal = { ...webPrincipal, knowledgeAll: false, allowedPrefixes: ['Public'] };
  const result = await f.service.query(principal, {});
  expect(result.nodes.map((n) => n.id)).toEqual(['allowed']);
  expect(result.truncated).toBe(false);
  expect(result.index).toMatchObject({ scanned: 1, pending: 0, skipped: 0, complete: true });
});
