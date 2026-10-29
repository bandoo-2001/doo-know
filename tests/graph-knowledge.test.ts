import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../packages/core/db';
import { createKnowledgeGraph } from '../packages/core/graph/knowledge-service';
import { webPrincipal } from '../packages/core/knowledge/core';
import type { GraphModelPort } from '../shared/graph-semantic-contracts';
import type { NoteService } from '../packages/core/notes';
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const settings = {
  version: 1,
  provider: 'ollama' as const,
  baseUrl: 'http://localhost:11434',
  model: 'fixture',
  automatic: true,
  remoteContentAllowed: false,
  apiKeyConfigured: false,
  timeoutMs: 1000,
  maxInputCharacters: 12000,
};
const extraction = {
  entities: [
    { name: 'Ada', kind: 'person' as const, quote: 'Ada designs Engines.' },
    { name: 'Engines', kind: 'technology' as const, quote: 'Ada designs Engines.' },
    { name: 'Forged', kind: 'organization' as const, quote: 'unseen evidence' },
  ],
  relations: [
    {
      source: 'Ada',
      target: 'Engines',
      predicate: 'designs',
      quote: 'Ada designs Engines.',
      confidence: 0.9,
    },
  ],
};
function fixture(modelChanges: Partial<GraphModelPort> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'graph-knowledge-')),
    config = {
      knowledgeRoot: join(root, 'notes'),
      dataRoot: join(root, 'data'),
      secret: 'test',
      origin: 'http://test',
    };
  mkdirSync(config.knowledgeRoot);
  const db = openDatabase(config.dataRoot),
    model = {
      settings: () => settings,
      fingerprint: () => 'fixture-1',
      extract: vi.fn(async () => extraction),
      ...modelChanges,
    } as GraphModelPort;
  const service = createKnowledgeGraph(config, db, {} as NoteService, model);
  cleanup.push(
    () => rmSync(root, { recursive: true, force: true }),
    () => db.close(),
    () => service.close(),
  );
  function note(id: string, path: string, body: string) {
    mkdirSync(join(config.knowledgeRoot, path, '..'), { recursive: true });
    writeFileSync(join(config.knowledgeRoot, path), body);
    db.prepare('INSERT INTO notes(id,path) VALUES(?,?)').run(id, path);
  }
  return { config, root, db, service, model, note };
}
async function ready(f: ReturnType<typeof fixture>, n = 1) {
  await vi.waitFor(() => expect(f.service.status(webPrincipal).completed).toBe(n), {
    timeout: 8000,
    interval: 50,
  });
}
it('publishes only exact model evidence, reviews, CAS/idempotency and persistent rejection after rebuild', async () => {
  const f = fixture();
  f.note('a', 'Public/a.md', '# Biography\nAda designs Engines.');
  f.service.start();
  await ready(f);
  let graph = await f.service.explore(webPrincipal, {});
  expect(graph.nodes.some((n) => n.title === 'Forged')).toBe(false);
  const review = f.service.review(webPrincipal, {});
  expect(review).toHaveLength(1);
  expect(review[0].evidence[0]).toMatchObject({
    startLine: 2,
    endLine: 2,
    quote: 'Ada designs Engines.',
    method: 'model',
  });
  const input = {
    requestId: 'ignore-1',
    expectedVersion: 0,
    action: 'review' as const,
    id: review[0].id,
    decision: 'ignore' as const,
  };
  expect(f.service.command(webPrincipal, input).version).toBe(1);
  expect(f.service.command(webPrincipal, input).version).toBe(1);
  expect(() => f.service.command(webPrincipal, { ...input, requestId: 'ignore-2' })).toThrow();
  expect(f.service.review(webPrincipal, {})).toHaveLength(0);
  expect(f.service.review(webPrincipal, { status: 'ignored' })).toHaveLength(1);
  f.service.control(webPrincipal, { action: 'rebuild' });
  await ready(f);
  expect(f.service.review(webPrincipal, {})).toHaveLength(0);
  graph = await f.service.explore(webPrincipal, {});
  expect(graph.edges.some((e) => e.kind === 'semantic')).toBe(false);
  const file = JSON.parse(
    readFileSync(join(f.config.knowledgeRoot, '_data/apps/knowledge-graph/state.json'), 'utf8'),
  );
  expect(file.data.decisions[review[0].id].decision).toBe('ignore');
});
it('supports aliases, entity merges, manual edges, saved views, paths and bounded grounded context', async () => {
  const f = fixture();
  f.note('a', 'Public/a.md', '# Biography\nAda designs Engines.');
  f.service.start();
  await ready(f);
  const r = f.service.review(webPrincipal, {})[0];
  let version = 0;
  f.service.command(webPrincipal, {
    requestId: 'alias',
    expectedVersion: version++,
    action: 'alias',
    entityId: r.source.id,
    alias: 'Augusta',
  });
  const search = await f.service.explore(webPrincipal, { q: 'Augusta' });
  expect(search.nodes).toHaveLength(1);
  f.service.command(webPrincipal, {
    requestId: 'manual',
    expectedVersion: version++,
    action: 'manual-relation',
    source: r.source.id,
    target: r.target.id,
    predicate: 'studies',
    noteId: 'a',
  });
  let graph = await f.service.explore(webPrincipal, { focus: r.source.id, target: r.target.id });
  expect(graph.path).toEqual([r.source.id, r.target.id]);
  expect(graph.edges.some((e) => e.kind === 'manual')).toBe(true);
  const context = await f.service.questionContext(webPrincipal, {
    question: 'Ada engines',
    nodeId: r.source.id,
  });
  expect(context.some((e) => e.quote === 'Ada designs Engines.')).toBe(true);
  const views = f.service.command(webPrincipal, {
    requestId: 'save',
    expectedVersion: version++,
    action: 'save-view',
    name: 'People',
    query: { nodeKinds: ['person'] },
  });
  expect(views.views[0].name).toBe('People');
  const local = (await f.service.explore(webPrincipal, {})).nodes.find(
    (n) => n.kind === 'concept' && n.title === 'Ada',
  )!;
  f.service.command(webPrincipal, {
    requestId: 'merge',
    expectedVersion: version++,
    action: 'merge',
    from: local.id,
    into: r.source.id,
  });
  graph = await f.service.explore(webPrincipal, {});
  expect(graph.nodes.some((n) => n.id === local.id)).toBe(false);
  expect(graph.nodes.find((n) => n.id === r.source.id)?.kind).toBe('person');
  f.service.control(webPrincipal, { action: 'rebuild' });
  await ready(f);
  expect(f.service.userState(webPrincipal).views).toHaveLength(1);
});
it('source filtering protects model metadata, review counts and question evidence', async () => {
  const f = fixture({
    extract: vi.fn(async (text: string) =>
      text.includes('Secret')
        ? {
            entities: [
              {
                name: 'Ada',
                kind: 'person' as const,
                description: 'Secret description',
                quote: 'Secret Ada.',
              },
              { name: 'Hidden', kind: 'organization' as const, quote: 'Secret Ada.' },
            ],
            relations: [
              {
                source: 'Ada',
                target: 'Hidden',
                predicate: 'hidden',
                quote: 'Secret Ada.',
                confidence: 1,
              },
            ],
          }
        : extraction,
    ),
  });
  f.note('s', 'private/s.md', '# Secret\nSecret Ada.');
  f.note('a', 'Public/a.md', '# Biography\nAda designs Engines.');
  f.service.start();
  await ready(f, 2);
  const p = {
    ...webPrincipal,
    id: 'reader',
    knowledgeAll: false,
    allowedPrefixes: [],
    knowledgeResourcePaths: [{ kind: 'note' as const, id: 'a', path: 'Public/a.md' }],
  };
  const graph = await f.service.explore(p, {});
  expect(JSON.stringify(graph)).not.toMatch(/Secret|Hidden|hidden/);
  expect(graph.status.suggested).toBe(1);
  expect(f.service.review(p, {})).toHaveLength(1);
  const evidence = await f.service.questionContext(p, { question: 'Ada' });
  expect(evidence.every((e) => e.noteId === 'a')).toBe(true);
  expect(() =>
    f.service.command(p, {
      requestId: 'x',
      expectedVersion: 0,
      action: 'save-view',
      name: 'x',
      query: {},
    }),
  ).toThrow();
});
it('model failure leaves honest local evidence and explicit retry can recover', async () => {
  let fail = true;
  const f = fixture({
    extract: vi.fn(async () => {
      if (fail) throw Error('sensitive backend detail');
      return extraction;
    }),
  });
  f.note('a', 'Public/a.md', '# Biography\nAda designs Engines.');
  f.service.start();
  await vi.waitFor(() => expect(f.service.status(webPrincipal).failed).toBe(1));
  const graph = await f.service.explore(webPrincipal, {});
  expect(graph.nodes.length).toBeGreaterThan(1);
  expect(graph.status.errors[0].code).toBe('MODEL_EXTRACTION_FAILED');
  expect(JSON.stringify(graph)).not.toContain('sensitive');
  fail = false;
  f.service.control(webPrincipal, { action: 'retry' });
  await ready(f);
  expect(f.service.review(webPrincipal, {})).toHaveLength(1);
});
it('cancel and close abort a provider that ignores signals and never publish late results', async () => {
  let release!: (v: any) => void;
  const f = fixture({ extract: vi.fn(() => new Promise<any>((r) => (release = r))) });
  f.note('a', 'Public/a.md', '# Biography\nAda designs Engines.');
  f.service.start();
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  f.service.control(webPrincipal, { action: 'cancel' });
  await f.service.close();
  release(extraction);
  expect(f.db.prepare('SELECT 1 FROM graph_analysis_sources').get()).toBeUndefined();
  expect(
    f.db.prepare("SELECT 1 FROM graph_analysis_jobs WHERE state='running'").get(),
  ).toBeUndefined();
});
it('portable decisions import into a new library database and malformed/conflicting files fail closed', async () => {
  const f = fixture();
  f.note('a', 'Public/a.md', '# Biography\nAda designs Engines.');
  f.service.start();
  await ready(f);
  f.service.command(webPrincipal, {
    requestId: 'view',
    expectedVersion: 0,
    action: 'save-view',
    name: 'Portable',
    query: { view: 'notes' },
  });
  const destination = join(f.root, 'copy');
  cpSync(f.config.knowledgeRoot, destination, { recursive: true });
  const db = openDatabase(join(f.root, 'other-data')),
    copy = createKnowledgeGraph(
      { ...f.config, knowledgeRoot: destination },
      db,
      {} as NoteService,
      f.model,
    );
  cleanup.push(
    () => db.close(),
    () => copy.close(),
  );
  expect(copy.userState(webPrincipal).views[0].name).toBe('Portable');
  expect(copy.userState(webPrincipal).version).toBe(1);
  writeFileSync(join(destination, '_data/apps/knowledge-graph/state.json'), '{}');
  expect(() => copy.userState(webPrincipal)).toThrow();
});
it('reports unconfigured vector similarity without lexical fallback and enforces output limits', async () => {
  const f = fixture({ settings: () => ({ ...settings, provider: 'none' }) });
  for (let i = 0; i < 8; i++)
    f.note('n' + i, `Public/${i}.md`, '# Knowledge\nGraph theory connects retrieval networks.');
  f.service.start();
  await ready(f, 8);
  const graph = await f.service.explore(webPrincipal, {
    view: 'notes',
    includeSimilarity: true,
    limit: 3,
  });
  expect(graph.nodes).toHaveLength(3);
  expect(graph.truncated).toBe(true);
  expect(graph.edges.some((e) => e.kind === 'similarity')).toBe(false);
  expect(graph.similarity).toMatchObject({ state: 'unconfigured', method: 'embedding' });
  const full = await f.service.explore(webPrincipal, { view: 'notes', includeSimilarity: true });
  expect(full.edges.some((e) => e.kind === 'similarity')).toBe(false);
  expect(full.status.similarity?.state).toBe('unconfigured');
  await expect(f.service.explore(webPrincipal, { limit: 1001 })).rejects.toMatchObject({
    statusCode: 400,
  });
});
it('searches, focuses and edits analyzed tail resources beyond the default source page', async () => {
  const { sourceAccess, hash } = await import('../packages/core/graph/analysis-source');
  const { analyzer } = await import('../packages/core/graph/analysis-content');
  const { publishLookup } = await import('../packages/core/graph/analysis-lookup');
  const f = fixture({ settings: () => ({ ...settings, provider: 'none' }) }),
    access = sourceAccess(f.config, f.db);
  function published(id: string, path: string, body: string) {
    f.note(id, path, body);
    const file = access.read(path),
      work = analyzer(body, path, id, hash(body), 0);
    work.local({ text: body, line: 1 });
    if (id === 'tail')
      work.enhance(
        { text: body, line: 1 },
        {
          entities: [
            {
              name: 'UniqueTailTerm',
              kind: 'technology',
              quote: 'UniqueTailTerm explores cosmic theory.',
            },
            {
              name: 'cosmic theory',
              kind: 'concept',
              quote: 'UniqueTailTerm explores cosmic theory.',
            },
          ],
          relations: [
            {
              source: 'UniqueTailTerm',
              target: 'cosmic theory',
              predicate: 'explores',
              quote: 'UniqueTailTerm explores cosmic theory.',
              confidence: 0.8,
            },
          ],
        },
        'fixture',
      );
    const data = work.result();
    f.db
      .prepare('INSERT INTO graph_analysis_sources VALUES(?,?,?,?,?,?,?,?)')
      .run(
        id,
        path,
        file.fingerprint,
        null,
        null,
        'fixture-1',
        JSON.stringify(data),
        new Date().toISOString(),
      );
    publishLookup(f.db, id, path, data);
    f.db.prepare("UPDATE graph_analysis_jobs SET state='done' WHERE note_id=?").run(id);
  }
  for (let i = 0; i < 513; i++)
    published('prefix' + i, `Public/prefix-${i}.md`, '# Common\nGeneric research.');
  published(
    'tail',
    'Public/tail.md',
    '# Tailneedle\nUniqueTailTerm explores cosmic theory. [peer](peer.md)',
  );
  published('peer', 'Public/peer.md', '# Peer\nRelated subject.');
  expect((await f.service.explore(webPrincipal, {})).truncated).toBe(true);
  expect(f.service.review(webPrincipal, {})).toHaveLength(1);
  expect(f.service.review(webPrincipal, { q: 'UniqueTailTerm' })).toHaveLength(1);
  expect(f.service.status(webPrincipal).suggested).toBe(1);
  const search = await f.service.explore(webPrincipal, { q: 'UniqueTailTerm' }),
    node = search.nodes.find((n) => n.title === 'UniqueTailTerm')!;
  expect(node).toBeTruthy();
  const focus = await f.service.explore(webPrincipal, { focus: node.id, depth: 2 });
  expect(focus.nodes.some((n) => n.id === 'tail')).toBe(true);
  const refs = await f.service.explore(webPrincipal, { view: 'notes', focus: 'tail', depth: 1 });
  expect(refs.nodes.some((n) => n.id === 'peer')).toBe(true);
  f.service.command(webPrincipal, {
    requestId: 'tail-alias',
    expectedVersion: 0,
    action: 'alias',
    entityId: node.id,
    alias: 'Tail synonym',
  });
  expect(
    (await f.service.explore(webPrincipal, { q: 'Tail synonym' })).nodes.some(
      (n) => n.id === node.id,
    ),
  ).toBe(true);
  const context = await f.service.questionContext(webPrincipal, {
    question: 'What is UniqueTailTerm?',
  });
  expect(context.some((e) => e.noteId === 'tail')).toBe(true);
});
it('review search paginates after source and relation filtering', async () => {
  const f = fixture({
    extract: async () => ({
      entities: extraction.entities,
      relations: [
        ...extraction.relations,
        { ...extraction.relations[0], predicate: 'studies' },
        { ...extraction.relations[0], predicate: 'builds' },
      ],
    }),
  });
  f.note('a', 'Public/a.md', '# Biography\nAda designs Engines.');
  f.service.start();
  await ready(f);
  const all = f.service.review(webPrincipal, { q: 'Ada', limit: 100 });
  expect(all).toHaveLength(3);
  expect(f.service.review(webPrincipal, { q: 'Ada', offset: 1, limit: 1 })).toEqual([all[1]]);
  expect(f.service.review(webPrincipal, { q: 'designs' })).toHaveLength(1);
  expect(() => f.service.review(webPrincipal, { offset: -1 })).toThrow();
  expect(() => f.service.review(webPrincipal, { limit: 101 })).toThrow();
});
it('does not disclose unanchored owner aliases or predicate edits to restricted principals', async () => {
  const f = fixture();
  f.note('a', 'Public/a.md', '# Biography\nAda designs Engines.');
  f.service.start();
  await ready(f);
  const relation = f.service.review(webPrincipal, {})[0],
    p = { ...webPrincipal, id: 'reader', knowledgeAll: false, allowedPrefixes: ['Public'] };
  const before = f.service.status(p).revision;
  f.service.command(webPrincipal, {
    requestId: 'private-alias',
    expectedVersion: 0,
    action: 'alias',
    entityId: relation.source.id,
    alias: 'Private project alias',
  });
  expect(f.service.status(p).revision).toBe(before);
  f.service.command(webPrincipal, {
    requestId: 'private-predicate',
    expectedVersion: 1,
    action: 'review',
    id: relation.id,
    decision: 'accept',
    predicate: 'Private owner phrase',
  });
  const graph = await f.service.explore(p, {});
  expect(JSON.stringify(graph)).not.toContain('Private');
  expect(graph.edges.find((e) => e.id === relation.id)?.label).toBe('designs');
  expect(JSON.stringify(await f.service.explore(webPrincipal, {}))).toContain(
    'Private project alias',
  );
});
it('bounds loaded derived JSON bytes before reading payloads and polls status without payload reads', async () => {
  const { sourceAccess, hash } = await import('../packages/core/graph/analysis-source');
  const { analyzer } = await import('../packages/core/graph/analysis-content');
  const { publishLookup } = await import('../packages/core/graph/analysis-lookup');
  const f = fixture(),
    access = sourceAccess(f.config, f.db);
  for (let i = 0; i < 6; i++) {
    const id = 'bounded' + i,
      path = `Public/bounded-${i}.md`,
      body = `# Bounded ${i}\nAda designs Engines.`;
    f.note(id, path, body);
    const file = access.read(path),
      work = analyzer(body, path, id, hash(body), 0);
    work.local({ text: body, line: 1 });
    work.enhance({ text: body, line: 1 }, extraction, 'fixture');
    const data = work.result(),
      serialized = JSON.stringify({ ...data, budgetFixture: 'x'.repeat(3 * 1024 * 1024) });
    f.db
      .prepare('INSERT INTO graph_analysis_sources VALUES(?,?,?,?,?,?,?,?)')
      .run(
        id,
        path,
        file.fingerprint,
        null,
        null,
        'fixture-1',
        serialized,
        new Date().toISOString(),
      );
    publishLookup(f.db, id, path, data);
    f.db.prepare("UPDATE graph_analysis_jobs SET state='done' WHERE note_id=?").run(id);
  }
  const originalPrepare = f.db.prepare.bind(f.db);
  let loaded = 0,
    payloadReads = 0;
  const spy = vi.spyOn(f.db, 'prepare').mockImplementation(((sql: string) => {
    const statement = originalPrepare(sql);
    if (
      /^\s*SELECT\b/i.test(sql) &&
      /(?:s\.\*|\bdata\b)/i.test(sql) &&
      /graph_analysis_sources/i.test(sql)
    ) {
      for (const method of ['get', 'all'] as const) {
        const original = statement[method].bind(statement) as (...args: any[]) => any;
        (statement as any)[method] = (...args: any[]) => {
          const result = original(...args);
          for (const row of method === 'all' ? result : [result])
            if (row && typeof row.data === 'string') {
              loaded += Buffer.byteLength(row.data);
              payloadReads++;
            }
          return result;
        };
      }
    }
    return statement;
  }) as typeof f.db.prepare);
  try {
    const graph = await f.service.explore(webPrincipal, { view: 'notes', limit: 100 });
    expect(loaded).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(graph.truncated).toBe(true);
    expect(graph.index.complete).toBe(false);
    expect(graph.nodes.length).toBeLessThan(6);
    loaded = 0;
    payloadReads = 0;
    f.service.status(webPrincipal);
    expect(payloadReads).toBe(0);
    loaded = 0;
    f.service.review(webPrincipal, {});
    expect(loaded).toBeLessThanOrEqual(16 * 1024 * 1024);
    loaded = 0;
    const focused = await f.service.explore(webPrincipal, { focus: 'bounded5', view: 'notes' });
    expect(focused.nodes.some((n) => n.id === 'bounded5')).toBe(true);
    expect(loaded).toBeLessThanOrEqual(16 * 1024 * 1024);
  } finally {
    spy.mockRestore();
  }
});
it('creates cross-note manual relations using either evidence note and explores manual and merged neighbors', async () => {
  const f = fixture({ settings: () => ({ ...settings, provider: 'none' }) });
  f.note('a', 'Public/a.md', '# Astronaut\nOrbital astronauts.');
  f.note('b', 'Public/b.md', '# Violin\nOrchestral violins.');
  f.note('c', 'Public/c.md', '# Mountain\nAlpine peaks.');
  f.note('d', 'Public/d.md', '# Cello\nChamber instrument.');
  f.service.start();
  await ready(f, 4);
  const graph = await f.service.explore(webPrincipal, {}),
    entity = (title: string) => graph.nodes.find((n) => n.kind !== 'note' && n.title === title)!.id;
  const a = entity('Astronaut'),
    b = entity('Violin'),
    c = entity('Mountain'),
    d = entity('Cello');
  f.service.command(webPrincipal, {
    action: 'manual-relation',
    requestId: 'manual-cross-a',
    expectedVersion: 0,
    source: a,
    target: b,
    predicate: 'inspires',
    noteId: 'a',
  });
  f.service.command(webPrincipal, {
    action: 'manual-relation',
    requestId: 'manual-cross-b',
    expectedVersion: 1,
    source: b,
    target: c,
    predicate: 'recalls',
    noteId: 'b',
  });
  const one = await f.service.explore(webPrincipal, { focus: a, depth: 1 });
  expect(one.nodes.some((n) => n.id === b)).toBe(true);
  expect(one.nodes.some((n) => n.id === c)).toBe(false);
  expect(one.edges.some((e) => e.kind === 'manual')).toBe(true);
  const two = await f.service.explore(webPrincipal, { focus: a, depth: 2 });
  expect(two.nodes.some((n) => n.id === c)).toBe(true);
  expect((await f.service.explore(webPrincipal, { focus: a, target: c })).path).toEqual([a, b, c]);
  f.service.command(webPrincipal, {
    action: 'merge',
    requestId: 'manual-merge',
    expectedVersion: 2,
    from: b,
    into: d,
  });
  const merged = await f.service.explore(webPrincipal, { focus: a, depth: 1 });
  expect(merged.nodes.some((n) => n.id === d && n.title === 'Cello')).toBe(true);
  expect(merged.edges.some((e) => e.kind === 'manual' && e.target === d)).toBe(true);
});
it('returns one principal-wide revision across filtered views and metadata-only polling', async () => {
  const f = fixture({ settings: () => ({ ...settings, provider: 'none' }) });
  f.note('a', 'Public/a.md', '# Astronaut\nOrbital astronauts.');
  f.note('b', 'Public/b.md', '# Violin\nOrchestral violins.');
  f.service.start();
  await ready(f, 2);
  const revision = f.service.status(webPrincipal).revision;
  for (const query of [
    {},
    { q: 'Astronaut' },
    { focus: 'a', depth: 1 as const },
    { folder: 'Public', view: 'notes' as const },
    { q: 'missing' },
  ])
    expect((await f.service.explore(webPrincipal, query)).status.revision).toBe(revision);
  expect(f.service.status(webPrincipal).revision).toBe(revision);
  const p = { ...webPrincipal, id: 'reader', knowledgeAll: false, allowedPrefixes: ['Public'] },
    restricted = f.service.status(p).revision;
  expect((await f.service.explore(p, { q: 'Violin' })).status.revision).toBe(restricted);
});
it('keeps unconfigured vector similarity honest independently from model suggestions', async () => {
  const f = fixture();
  f.note('a', 'Public/a.md', '# Shared\nAda designs Engines.');
  f.note('b', 'Public/b.md', '# Shared\nAda designs Engines.');
  f.service.start();
  await ready(f, 2);
  const shown = await f.service.explore(webPrincipal, {
    includeSimilarity: true,
    includeSuggested: false,
  });
  expect(shown.edges.some((e) => e.kind === 'similarity')).toBe(false);
  expect(shown.similarity?.state).toBe('unconfigured');
  expect(shown.edges.some((e) => e.kind === 'semantic')).toBe(false);
  const hidden = await f.service.explore(webPrincipal, {
    includeSimilarity: false,
    includeSuggested: true,
  });
  expect(hidden.edges.some((e) => e.kind === 'similarity')).toBe(false);
  expect(hidden.edges.some((e) => e.kind === 'semantic')).toBe(true);
});
