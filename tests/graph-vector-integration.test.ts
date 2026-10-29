import { afterEach, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createKnowledgeGraph } from '../packages/core/graph/knowledge-service';
import { sourceAccess, hash } from '../packages/core/graph/analysis-source';
import { analyzer } from '../packages/core/graph/analysis-content';
import { publishLookup } from '../packages/core/graph/analysis-lookup';
import { webPrincipal } from '../packages/core/knowledge/core';
import type { NoteService } from '../packages/core/notes';
import type { GraphModelPort } from '../shared/graph-semantic-contracts';
import { graphVectorFixture } from './support/graph-vector-fixture';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
function vector(x = 1, y = 0) {
  const result = Array<number>(512).fill(0);
  result[0] = x;
  result[1] = y;
  return result;
}
async function fixture() {
  const f = await graphVectorFixture();
  const model = {
    settings: () => ({
      version: 1,
      provider: 'none',
      baseUrl: '',
      model: '',
      automatic: false,
      remoteContentAllowed: false,
      apiKeyConfigured: false,
      timeoutMs: 1000,
      maxInputCharacters: 12000,
    }),
    fingerprint: () => 'vector-integration',
    extract: async () => ({ entities: [], relations: [] }),
  } as unknown as GraphModelPort;
  const graph = createKnowledgeGraph(f.config, f.db, {} as NoteService, model);
  cleanup.push(
    () => f.close(),
    () => graph.close(),
  );
  return { ...f, graph };
}

function publishAnalysis(f: Awaited<ReturnType<typeof fixture>>, id: string, path: string) {
  const access = sourceAccess(f.config, f.db),
    file = access.read(path),
    source = access.current(id)!;
  const work = analyzer(file.text, path, id, hash(file.text), source.source_revision!);
  work.local({ text: file.text, line: 1 });
  const analysis = work.result();
  f.db
    .prepare('INSERT INTO graph_analysis_sources VALUES(?,?,?,?,?,?,?,?)')
    .run(
      id,
      path,
      file.fingerprint,
      source.source_revision,
      source.managed_hash,
      'vector-integration',
      JSON.stringify(analysis),
      new Date().toISOString(),
    );
  publishLookup(f.db, id, path, analysis);
}

it.each(['outgoing', 'incoming'] as const)(
  'traverses %s reference then similarity and similarity then reference within two hops',
  async (direction) => {
    const f = await fixture();
    await f.note(
      'a',
      'Public/a.md',
      direction === 'outgoing' ? '# Alpha\n[branch](b.md)' : '# Alpha\nOrbital.',
      [vector()],
    );
    await f.note(
      'b',
      'Public/b.md',
      direction === 'incoming' ? '# Beta\n[branch](a.md)' : '# Beta\nMarine.',
      [vector(0, 1)],
    );
    await f.note('c', 'Public/c.md', '# Gamma\nAquatic.', [vector(0, 1)]);
    for (const id of ['a', 'b', 'c']) publishAnalysis(f, id, `Public/${id}.md`);
    const query = {
      focus: 'a',
      depth: 2 as const,
      view: 'notes' as const,
      includeSimilarity: true,
    };
    const mixed = await f.graph.explore(webPrincipal, query);
    expect(mixed.nodes.map((n) => n.id).sort()).toEqual(['a', 'b', 'c']);
    expect(mixed.edges.map((e) => e.kind).sort()).toEqual(['reference', 'similarity']);
    const direct = await f.graph.explore(webPrincipal, { ...query, depth: 1 });
    expect(direct.nodes.map((n) => n.id).sort()).toEqual(['a', 'b']);
    const reversed = await f.graph.explore(webPrincipal, { ...query, focus: 'c' });
    expect(reversed.nodes.map((n) => n.id).sort()).toEqual(['a', 'b', 'c']);
    const noReferences = await f.graph.explore(webPrincipal, {
      ...query,
      edgeKinds: ['similarity'],
    });
    expect(noReferences.nodes.map((n) => n.id)).toEqual(['a']);
    const restricted = {
      ...webPrincipal,
      id: 'reader',
      knowledgeAll: false,
      allowedPrefixes: [],
      knowledgeResourcePaths: [
        { kind: 'note' as const, id: 'a', path: 'Public/a.md' },
        { kind: 'note' as const, id: 'c', path: 'Public/c.md' },
      ],
    };
    const scoped = await f.graph.explore(restricted, query);
    expect(scoped.nodes.map((n) => n.id)).toEqual(['a']);
  },
);

it('discovers an unlinked vector neighbor without shared terms or entity analysis', async () => {
  const f = await fixture();
  await f.note('a', 'Public/astronaut.md', '# Astronaut\nOrbital voyages.', [vector()]);
  await f.note('b', 'Public/garden.md', '# Garden\nFlower meadows.', [vector(0.8, 0.6)]);
  await f.note('c', 'Public/astronaut-copy.md', '# Astronaut\nOrbital voyages.', [vector(0, 1)]);
  expect(f.db.prepare('SELECT count(*) AS n FROM graph_analysis_sources').get()).toEqual({ n: 0 });
  const query = {
    focus: 'a',
    view: 'notes' as const,
    includeSimilarity: true,
    includeSuggested: false,
    minConfidence: 0.99,
  };
  const graph = await f.graph.explore(webPrincipal, query);
  expect(graph.nodes.map((n) => n.id).sort()).toEqual(['a', 'b']);
  expect(graph.edges).toHaveLength(1);
  expect(graph.edges[0]).toMatchObject({
    kind: 'similarity',
    similarity: { method: 'embedding-cosine', score: expect.closeTo(0.8, 5), dimensions: 512 },
  });
  expect(graph.edges[0].evidence.map((e) => e.noteId).sort()).toEqual(['a', 'b']);
  expect(graph.edges[0].evidence.every((e) => e.method === 'embedding')).toBe(true);
  expect(graph.similarity?.state).toBe('ready');
  expect(
    (await f.graph.explore(webPrincipal, { ...query, similarityThreshold: 0.9 })).edges,
  ).toEqual([]);
  expect(
    (await f.graph.explore(webPrincipal, { ...query, edgeKinds: ['reference'] })).nodes.map(
      (n) => n.id,
    ),
  ).toEqual(['a']);
  expect((await f.graph.explore(webPrincipal, { ...query, target: 'b' })).path).toEqual(['a', 'b']);
});

it('preserves direct and two-hop vector neighborhoods and folder filters', async () => {
  const f = await fixture();
  await f.note('a', 'Public/a.md', 'Alpha.', [vector()]);
  await f.note('b', 'Public/b.md', 'Beta.', [vector(0.8, 0.6)]);
  await f.note('c', 'Elsewhere/c.md', 'Gamma.', [vector(0.28, 0.96)]);
  const query = { focus: 'a', view: 'notes' as const, includeSimilarity: true };
  expect((await f.graph.explore(webPrincipal, query)).nodes.map((n) => n.id).sort()).toEqual([
    'a',
    'b',
  ]);
  expect(
    (await f.graph.explore(webPrincipal, { ...query, depth: 2 })).nodes.map((n) => n.id).sort(),
  ).toEqual(['a', 'b', 'c']);
  expect(
    (await f.graph.explore(webPrincipal, { ...query, depth: 2, folder: 'Public' })).nodes
      .map((n) => n.id)
      .sort(),
  ).toEqual(['a', 'b']);
});

it('drops changed sources until current vector indexing is published and refreshes metadata revisions', async () => {
  const f = await fixture();
  await f.note('a', 'Public/a.md', 'First.', [vector()]);
  await f.note('b', 'Public/b.md', 'Second.', [vector()]);
  const before = f.graph.status(webPrincipal);
  expect(before.similarity?.readyNotes).toBe(2);
  const query = { focus: 'a', view: 'notes' as const, includeSimilarity: true };
  expect((await f.graph.explore(webPrincipal, query)).edges).toHaveLength(1);
  writeFileSync(join(f.config.knowledgeRoot, 'Public/b.md'), 'Changed.');
  f.db
    .prepare(
      "UPDATE document_state SET content_hash='changed',source_revision=source_revision+1 WHERE note_id='b'",
    )
    .run();
  const pending = f.graph.status(webPrincipal);
  expect(pending.revision).not.toBe(before.revision);
  expect(pending.similarity?.pendingNotes).toBe(1);
  const stale = await f.graph.explore(webPrincipal, query);
  expect(stale.edges).toEqual([]);
  expect(stale.nodes.map((n) => n.id)).toEqual(['a']);
  await f.note('b', 'Public/b.md', 'Changed.', [vector()]);
  const published = f.graph.status(webPrincipal);
  expect(published.revision).not.toBe(pending.revision);
  expect(published.similarity?.state).toBe('ready');
  const refreshed = await f.graph.explore(webPrincipal, query);
  expect(refreshed.edges).toHaveLength(1);
  expect(refreshed.status.revision).toBe(published.revision);
});

it('scopes vector discovery, evidence, status and public revisions before hidden generation changes', async () => {
  const f = await fixture();
  await f.note('a', 'Public/a.md', 'Visible.', [vector()]);
  await f.note('b', 'Public/b.md', 'Neighbor.', [vector()]);
  await f.note('secret', 'Private/secret.md', 'Confidential.', [vector()]);
  const p = { ...webPrincipal, id: 'reader', knowledgeAll: false, allowedPrefixes: ['Public'] };
  const before = f.graph.status(p);
  const graph = await f.graph.explore(p, { focus: 'a', includeSimilarity: true, view: 'notes' });
  expect(graph.nodes.map((n) => n.id).sort()).toEqual(['a', 'b']);
  expect(JSON.stringify(graph)).not.toMatch(/secret|Confidential|Private/);
  expect(before.similarity?.totalNotes).toBe(2);
  await f.note('secret', 'Private/secret.md', 'Hidden update.', [vector(0, 1)]);
  expect(f.graph.status(p).revision).toBe(before.revision);
  expect(f.graph.status(p).similarity?.revision).toBe(before.similarity?.revision);
  expect((await f.graph.explore(p, { includeSimilarity: true })).status.revision).toBe(
    before.revision,
  );
  await expect(
    f.graph.explore(p, { focus: 'secret', includeSimilarity: true }),
  ).rejects.toMatchObject({ statusCode: 404 });
});

it('keeps status and review metadata-only without fetching cached vectors', async () => {
  const f = await fixture();
  await f.note('a', 'Public/a.md', 'Visible.', [vector()]);
  const original = f.db.prepare.bind(f.db);
  let vectorPayloadReads = 0;
  const spy = vi.spyOn(f.db, 'prepare').mockImplementation(((sql: string) => {
    const statement = original(sql);
    if (/\bselect\b/i.test(sql) && /vector_cache/i.test(sql)) {
      for (const method of ['get', 'all'] as const) {
        const read = statement[method].bind(statement) as (...args: unknown[]) => any;
        (statement as any)[method] = (...args: unknown[]) => {
          const result = read(...args);
          for (const row of method === 'all' ? result : [result])
            if (row && Object.values(row).some((value) => value instanceof Uint8Array))
              vectorPayloadReads++;
          return result;
        };
      }
    }
    return statement;
  }) as typeof f.db.prepare);
  try {
    f.graph.status(webPrincipal);
    f.graph.review(webPrincipal);
    f.graph.userState(webPrincipal);
    expect(vectorPayloadReads).toBe(0);
  } finally {
    spy.mockRestore();
  }
});

it('rejects a prepared vector graph when its source changes before the response fence', async () => {
  const f = await fixture();
  await f.note('a', 'Public/a.md', 'First.', [vector()]);
  await f.note('b', 'Public/b.md', 'Second.', [vector()]);
  const original = f.db.prepare.bind(f.db);
  let changed = false;
  const spy = vi.spyOn(f.db, 'prepare').mockImplementation(((sql: string) => {
    // This metadata read occurs during render, after vector preparation. Mutating through
    // the original connection simulates an index/source writer outside this request.
    if (!changed && /SELECT count\(DISTINCT c\.id\)/.test(sql)) {
      changed = true;
      original(
        "UPDATE document_state SET source_revision=source_revision+1 WHERE note_id='b'",
      ).run();
    }
    return original(sql);
  }) as typeof f.db.prepare);
  try {
    await expect(
      f.graph.explore(webPrincipal, { focus: 'a', view: 'notes', includeSimilarity: true }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(changed).toBe(true);
  } finally {
    spy.mockRestore();
  }
});

it('derives vector seeds through canonical merged entity lookups', async () => {
  const f = await fixture();
  await f.note('a', 'Public/a.md', '# Asteroid\nOrbit.', [vector()]);
  await f.note('b', 'Public/b.md', 'Flower meadows.', [vector(0.8, 0.6)]);
  await f.note('c', 'Public/c.md', '# Violin\nMusic.', [vector(0, 1)]);
  for (const id of ['a', 'c']) publishAnalysis(f, id, `Public/${id}.md`);
  const before = await f.graph.explore(webPrincipal);
  const entity = (title: string) =>
    before.nodes.find((n) => n.kind !== 'note' && n.title === title)!.id;
  const from = entity('Asteroid'),
    into = entity('Violin');
  f.graph.command(webPrincipal, {
    action: 'merge',
    requestId: 'merge-vector-seed',
    expectedVersion: 0,
    from,
    into,
  });
  const merged = await f.graph.explore(webPrincipal, {
    focus: into,
    depth: 2,
    includeSimilarity: true,
  });
  expect(merged.nodes.some((n) => n.id === 'b')).toBe(true);
  expect(merged.nodes.some((n) => n.id === from)).toBe(false);
  expect(
    merged.edges.some((e) => e.kind === 'similarity' && [e.source, e.target].includes('b')),
  ).toBe(true);
});
