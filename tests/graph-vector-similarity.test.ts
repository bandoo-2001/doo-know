import { afterEach, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { graphVectorFixture, basisVector } from './support/graph-vector-fixture.js';
import { webPrincipal } from '../packages/core/knowledge/core.js';
import { createGraphVectorSimilarity } from '../packages/core/graph/vector-similarity.js';
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
function fixture() {
  const f = graphVectorFixture(),
    adapter = createGraphVectorSimilarity(f.config, f.db);
  cleanup.push(
    () => f.close(),
    () => adapter.close(),
  );
  return { ...f, adapter };
}
it('discovers nonlexical focused neighbors from published cache without contacting the runtime', async () => {
  const f = fixture();
  await f.note('a', 'Public/a.md', '轨道飞行\n星际旅行\n');
  await f.note('b', 'Public/b.md', '宇宙探索\n');
  await f.note('c', 'Public/c.md', '轨道飞行\n星际旅行\n', [basisVector(1)]);
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
  try {
    const plan = await f.adapter.prepare(webPrincipal, { focus: 'a', depth: 1 });
    expect(plan.edges).toHaveLength(1);
    expect(plan.edges[0]).toMatchObject({
      source: 'a',
      target: 'b',
      similarity: { method: 'embedding-cosine', score: 1, dimensions: 512 },
    });
    expect(plan.edges[0].evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          noteId: 'a',
          method: 'embedding',
          quote: '轨道飞行\n星际旅行\n',
          startLine: 1,
          endLine: 2,
        }),
        expect.objectContaining({ noteId: 'b', method: 'embedding', startLine: 1, endLine: 1 }),
      ]),
    );
    expect(plan.status.state).toBe('ready');
    f.adapter.assertFresh(webPrincipal, plan);
    expect(network).not.toHaveBeenCalled();
  } finally {
    network.mockRestore();
  }
});
it('uses unique byte coverage, not chunk count, when overlapping chunks form a note mean', async () => {
  const f = fixture();
  await f.note(
    'a',
    'a.md',
    'abcdefghij',
    [basisVector(0), basisVector(1)],
    [
      [0, 8],
      [6, 10],
    ],
  );
  await f.note('b', 'b.md', 'different', [basisVector(0)]);
  const plan = await f.adapter.prepare(webPrincipal, { focus: 'a', similarityThreshold: 0 });
  expect(plan.edges[0].similarity!.score).toBeCloseTo(8 / Math.sqrt(68), 6);
});
it.each([
  'missing-cache',
  'wrong-point',
  'wrong-row',
  'missing-chunk',
  'gap',
  'nan',
  'zero',
  'unnormalized',
])('skips the whole note for %s instead of using partial vectors', async (damage) => {
  const f = fixture();
  const a = await f.note(
    'a',
    'a.md',
    'abcdefgh',
    [basisVector(), basisVector()],
    [
      [0, 4],
      [4, 8],
    ],
  );
  await f.note('b', 'b.md', 'different');
  const chunk = a.points[1];
  if (damage === 'missing-cache')
    f.db.prepare('DELETE FROM vector_cache WHERE input_hash=?').run(chunk.inputHash);
  if (damage === 'wrong-point')
    f.db.prepare("UPDATE vector_points SET note_id='b' WHERE chunk_id=?").run(chunk.chunkId);
  if (damage === 'wrong-row')
    f.db.prepare("UPDATE vector_rows SET note_id='b' WHERE chunk_id=?").run(chunk.chunkId);
  if (damage === 'missing-chunk')
    f.db.prepare('UPDATE chunks SET active=0 WHERE chunk_id=?').run(chunk.chunkId);
  if (damage === 'gap')
    f.db.prepare('UPDATE chunks SET start_byte=5 WHERE chunk_id=?').run(chunk.chunkId);
  if (['nan', 'zero', 'unnormalized'].includes(damage)) {
    const bytes = Buffer.alloc(2048);
    bytes.writeFloatLE(damage === 'nan' ? NaN : damage === 'zero' ? 0 : 2);
    f.db.prepare('UPDATE vector_cache SET value=? WHERE input_hash=?').run(bytes, chunk.inputHash);
  }
  const plan = await f.adapter.prepare(webPrincipal, {});
  expect(plan.edges).toHaveLength(0);
  expect(plan.status.state).toBe('partial');
  expect(plan.status.readyNotes).toBe(1);
  expect(plan.status.pendingNotes + plan.status.invalidNotes).toBe(1);
});
it('scopes counts and revision before inspecting exact note grants, case and hidden generations', async () => {
  const f = fixture();
  await f.note('a', 'Public/a.md', 'visible');
  const p = {
    ...webPrincipal,
    id: 'reader',
    knowledgeAll: false,
    allowedPrefixes: ['Public'],
    knowledgeResourcePaths: [{ kind: 'note' as const, id: 'a', path: 'Public/a.md' }],
  };
  const before = f.adapter.status(p);
  await f.note('b', 'Public/b.md', 'secret');
  await f.note('c', 'public/a.md', 'hidden');
  expect(f.adapter.status(p)).toEqual(before);
  expect((await f.adapter.prepare(p, {})).noteIds).toEqual(['a']);
  const none = { ...p, knowledgeResourcePaths: [] };
  expect(f.adapter.status(none).totalNotes).toBe(0);
});
it('invalidates plans on space change, source mutation, deletion, conflict and writes', async () => {
  const f = fixture();
  await f.note('a', 'a.md', 'first');
  await f.note('b', 'b.md', 'second');
  const plan = await f.adapter.prepare(webPrincipal, {});
  writeFileSync(join(f.config.knowledgeRoot, 'a.md'), 'other');
  expect(() => f.adapter.assertFresh(webPrincipal, plan)).toThrow();
  expect((await f.adapter.prepare(webPrincipal, {})).edges).toHaveLength(0);
  f.config.embeddingSpaceId = 'new-space';
  f.db.prepare("UPDATE index_meta SET value='new-space' WHERE key='desired_embedding_space'").run();
  expect(f.adapter.status(webPrincipal).state).toBe('pending');
  expect((await f.adapter.prepare(webPrincipal, {})).edges).toHaveLength(0);
  expect(() => f.adapter.assertFresh(webPrincipal, plan)).toThrow();
});
it('bounds queued preparations and aborts them at close', async () => {
  const f = fixture();
  await f.note('a', 'a.md', 'body');
  const preparations = Array.from({ length: 12 }, () => f.adapter.prepare(webPrincipal, {}));
  const results = Promise.allSettled(preparations);
  await f.adapter.close();
  expect((await results).every((r) => r.status === 'rejected')).toBe(true);
  await expect(f.adapter.prepare(webPrincipal, {})).rejects.toThrow();
});

it.each(['deleted', 'conflict', 'write', 'inactive', 'stale-text', 'stale-vector'])(
  'excludes %s source states and rejects previously prepared plans',
  async (state) => {
    const f = fixture();
    await f.note('a', 'a.md', 'first');
    await f.note('b', 'b.md', 'second');
    const plan = await f.adapter.prepare(webPrincipal, {});
    if (state === 'deleted') f.db.prepare("UPDATE notes SET active=0 WHERE id='a'").run();
    if (state === 'inactive')
      f.db.prepare("UPDATE document_state SET active=0 WHERE note_id='a'").run();
    if (state === 'conflict')
      f.db.prepare("UPDATE document_state SET conflict=1 WHERE note_id='a'").run();
    if (state === 'stale-text')
      f.db.prepare("UPDATE document_state SET text_indexed_hash=NULL WHERE note_id='a'").run();
    if (state === 'stale-vector')
      f.db.prepare("UPDATE document_state SET vector_indexed_hash=NULL WHERE note_id='a'").run();
    if (state === 'write') {
      f.db
        .prepare(
          "INSERT INTO operations VALUES('op','web-owner','test','write','request','hash','running',NULL,NULL,0,0)",
        )
        .run();
      f.db
        .prepare(
          "INSERT INTO write_intents(id,note_id,path,kind,status) VALUES('op','a','a.md','write','prepared')",
        )
        .run();
    }
    expect(() => f.adapter.assertFresh(webPrincipal, plan)).toThrow();
    expect((await f.adapter.prepare(webPrincipal, {})).edges).toHaveLength(0);
  },
);
it('truncates evidence at the quoted line rather than reporting the full chunk end line', async () => {
  const f = fixture();
  await f.note('a', 'a.md', 'line\n'.repeat(400));
  await f.note('b', 'b.md', 'other');
  const plan = await f.adapter.prepare(webPrincipal, {});
  const evidence = plan.edges[0].evidence.find((e) => e.noteId === 'a')!;
  expect(evidence.quote).toBe('line\n'.repeat(240));
  expect(evidence.endLine).toBe(240);
});
it('rejects explicitly unsupported embedding dimensions', async () => {
  const f = fixture();
  await f.note('a', 'a.md', 'first');
  f.db
    .prepare('INSERT INTO embedding_spaces VALUES(?,?,?)')
    .run(f.config.embeddingSpaceId, 256, '{}');
  expect(f.adapter.status(webPrincipal).state).toBe('invalid');
  expect((await f.adapter.prepare(webPrincipal, {})).noteIds).toEqual([]);
});
it('keeps metadata status free of vector and source payload reads', async () => {
  const f = fixture();
  await f.note('a', 'a.md', 'first');
  const queries: string[] = [],
    original = f.db.prepare.bind(f.db);
  const spy = vi.spyOn(f.db, 'prepare').mockImplementation(((sql: string) => {
    queries.push(sql);
    return original(sql);
  }) as typeof f.db.prepare);
  try {
    expect(f.adapter.status(webPrincipal).readyNotes).toBe(1);
  } finally {
    spy.mockRestore();
  }
  expect(
    queries.filter((sql) => /SELECT\s+(?:v\.)?value\s+FROM\s+vector_cache/i.test(sql)),
  ).toEqual([]);
  expect(queries.filter((sql) => /SELECT\s+content\s+FROM\s+chunks/i.test(sql))).toEqual([]);
});
it('caps dense endpoint degree and expands one additional semantic hop', async () => {
  const f = fixture();
  await f.note('a', 'a.md', 'one', [basisVector(0)]);
  const middle = basisVector(0);
  middle[0] = 0.8;
  middle[1] = 0.6;
  const end = basisVector(0);
  end[0] = 0.28;
  end[1] = 0.96;
  await f.note('b', 'b.md', 'two', [middle]);
  await f.note('c', 'c.md', 'three', [end]);
  expect((await f.adapter.prepare(webPrincipal, { focus: 'a', depth: 1 })).noteIds).toEqual([
    'a',
    'b',
  ]);
  expect((await f.adapter.prepare(webPrincipal, { focus: 'a', depth: 2 })).noteIds).toEqual([
    'a',
    'b',
    'c',
  ]);
  for (let i = 0; i < 5; i++) await f.note('dense' + i, 'dense' + i + '.md', 'dense' + i);
  const plan = await f.adapter.prepare(webPrincipal, {});
  for (const node of plan.nodes)
    expect(
      plan.edges.filter((e) => e.source === node.id || e.target === node.id).length,
    ).toBeLessThanOrEqual(3);
});
it('reports truncated sampling while prioritizing a focused note beyond the metadata page', async () => {
  const f = fixture();
  f.db.transaction(() => {
    for (let i = 0; i < 8200; i++)
      f.db
        .prepare('INSERT INTO notes(id,path) VALUES(?,?)')
        .run('prefix' + String(i).padStart(5, '0'), 'Public/' + i + '.md');
  })();
  await f.note('tail', 'Public/tail.md', 'tail');
  const status = f.adapter.status(webPrincipal);
  expect(status.truncated).toBe(true);
  const plan = await f.adapter.prepare(webPrincipal, { focus: 'tail' });
  expect(plan.noteIds).toContain('tail');
  expect(plan.truncated).toBe(true);
});
it('refreshes a known corrupt note after a repaired scoped publication without leaking hidden publications', async () => {
  const f = fixture();
  const a = await f.note('a', 'Public/a.md', 'first');
  await f.note('b', 'Public/b.md', 'second');
  const bad = Buffer.alloc(2048);
  bad.writeFloatLE(NaN);
  f.db
    .prepare('UPDATE vector_cache SET value=? WHERE input_hash=?')
    .run(bad, a.points[0].inputHash);
  expect((await f.adapter.prepare(webPrincipal, {})).status.invalidNotes).toBe(1);
  const before = f.adapter.status(webPrincipal).revision;
  const good = Buffer.alloc(2048);
  good.writeFloatLE(1);
  f.db
    .prepare('UPDATE vector_cache SET value=? WHERE input_hash=?')
    .run(good, a.points[0].inputHash);
  await f.store.prepare(a.source, a.points, [basisVector()], false);
  await f.store.publish(await f.store.finalize(a.source));
  expect(f.adapter.status(webPrincipal).revision).not.toBe(before);
  expect(f.adapter.status(webPrincipal).state).toBe('ready');
  expect((await f.adapter.prepare(webPrincipal, {})).edges).toHaveLength(1);
});
it('enforces v2 policy read permission and exact resolved resource identities', async () => {
  const f = fixture();
  await f.note('a', 'Public/a.md', 'first');
  await f.note('b', 'Public/b.md', 'second');
  const p = {
    ...webPrincipal,
    id: 'reader',
    ownerId: 'owner',
    policyVersion: 2 as const,
    knowledgeAll: false,
    allowedPrefixes: ['Public'],
    knowledgeResourcePaths: [{ kind: 'note', id: 'a', path: 'Public/a.md' }],
    permissionPolicy: {
      version: 2 as const,
      domains: {
        knowledge: {
          enabled: true,
          ownerId: 'owner',
          instanceId: 'fixture',
          actions: ['read'],
          resources: { mode: 'selected' as const, resources: [{ kind: 'note', id: 'a' }] },
        },
      },
    },
  };
  expect((await f.adapter.prepare(p, {})).noteIds).toEqual(['a']);
  p.permissionPolicy.domains.knowledge.actions = [];
  expect(() => f.adapter.status(p)).toThrow();
});
