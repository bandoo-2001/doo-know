import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
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
export function fixture(override: Partial<GraphModelPort> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'semantic-graph-'));
  const config = {
    knowledgeRoot: join(root, 'notes'),
    dataRoot: join(root, 'data'),
    secret: 'test',
    origin: 'http://test',
  };
  mkdirSync(config.knowledgeRoot);
  const db = openDatabase(config.dataRoot);
  const model = {
    settings: () => ({
      version: 0,
      provider: 'none',
      baseUrl: '',
      model: '',
      automatic: true,
      remoteContentAllowed: false,
      apiKeyConfigured: false,
      timeoutMs: 1000,
      maxInputCharacters: 12000,
    }),
    fingerprint: () => 'local-1',
    extract: vi.fn(async () => ({ entities: [], relations: [] })),
    ...override,
  } as GraphModelPort;
  const service = createKnowledgeGraph(config, db, {} as NoteService, model);
  cleanup.push(
    () => rmSync(root, { recursive: true, force: true }),
    () => db.close(),
    () => service.close(),
  );
  function note(id: string, path: string, text: string) {
    mkdirSync(join(config.knowledgeRoot, path, '..'), { recursive: true });
    writeFileSync(join(config.knowledgeRoot, path), text);
    db.prepare('INSERT INTO notes(id,path) VALUES(?,?)').run(id, path);
  }
  return { root, config, db, service, model, note };
}
async function complete(f: ReturnType<typeof fixture>, count = 1) {
  await vi.waitFor(() => expect(f.service.status(webPrincipal).completed).toBe(count), {
    timeout: 8000,
    interval: 50,
  });
}
it('automatically extracts body concepts, updates external edits and removes deletes without graph requests', async () => {
  const f = fixture();
  f.note(
    'a',
    'Public/a.md',
    '# Research\nGraph theory connects knowledge networks. Graph theory improves retrieval.',
  );
  f.service.start();
  await complete(f);
  expect(
    (await f.service.explore(webPrincipal, {})).nodes.some(
      (n) => n.title.toLowerCase() === 'theory',
    ),
  ).toBe(true);
  writeFileSync(join(f.config.knowledgeRoot, 'Public/a.md'), '# New\nAstronomy explores galaxies.');
  await vi.waitFor(
    async () =>
      expect(
        (await f.service.explore(webPrincipal, {})).nodes.some((n) => n.title === 'Astronomy'),
      ).toBe(true),
    { timeout: 8000 },
  );
  unlinkSync(join(f.config.knowledgeRoot, 'Public/a.md'));
  expect((await f.service.explore(webPrincipal, {})).nodes).toEqual([]);
});
it('filters sources before aggregate metadata and respects case-sensitive paths', async () => {
  const f = fixture();
  f.note('a', 'Public/a.md', '# Public\nGraph networks connect concepts.');
  f.note('s', 'public/secret.md', '# Secret\nGraph forbidden hidden.');
  f.service.start();
  await complete(f, 2);
  const p = { ...webPrincipal, knowledgeAll: false, allowedPrefixes: ['Public'] };
  const graph = await f.service.explore(p, {});
  expect(JSON.stringify(graph)).not.toContain('Secret');
  expect(JSON.stringify(graph)).not.toContain('forbidden');
  const entity = graph.nodes.find((n) => n.title === 'Graph');
  expect(entity?.sourceCount).toBe(1);
  expect(f.service.status(p).total).toBe(1);
});
it('rejects invalid model quotes and stale publication after a source changes during extraction', async () => {
  let release!: (x: any) => void;
  const f = fixture({
    settings: () => ({
      version: 1,
      provider: 'ollama',
      baseUrl: 'http://localhost:11434',
      model: 'test',
      automatic: true,
      remoteContentAllowed: false,
      apiKeyConfigured: false,
      timeoutMs: 1000,
      maxInputCharacters: 12000,
    }),
    extract: vi.fn(
      () =>
        new Promise<any>((r) => {
          release = r;
        }),
    ),
  });
  f.note('a', 'Public/a.md', '# Source\nAlpha develops Beta.');
  f.service.start();
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  writeFileSync(join(f.config.knowledgeRoot, 'Public/a.md'), '# Changed\nGamma replaces Alpha.');
  release({
    entities: [{ name: 'Forged', kind: 'person', quote: 'not in source' }],
    relations: [],
  });
  await new Promise((r) => setTimeout(r, 100));
  expect(JSON.stringify(await f.service.explore(webPrincipal, {}))).not.toContain('Forged');
  expect(JSON.stringify(await f.service.explore(webPrincipal, {}))).not.toContain('develops');
});
it('indexes sources larger than the legacy 256KiB ceiling in bounded chunks', async () => {
  const f = fixture();
  f.note(
    'a',
    'Public/a.md',
    '# Large\n' + 'Knowledge graphs connect retrieval systems.\n'.repeat(7000),
  );
  f.service.start();
  await complete(f);
  expect((await f.service.explore(webPrincipal, {})).nodes.length).toBeGreaterThan(1);
});
it('background compensation updates stored results without a query and handles restoration after deletion', async () => {
  const f = fixture();
  f.note('a', 'Public/a.md', '# Original\nAstronomy studies galaxies.');
  f.service.start();
  await complete(f);
  const stored = () =>
    JSON.parse(
      (f.db.prepare('SELECT data FROM graph_analysis_sources WHERE note_id=?').get('a') as any)
        ?.data ?? 'null',
    );
  writeFileSync(
    join(f.config.knowledgeRoot, 'Public/a.md'),
    '# Revised\nBiology studies organisms.',
  );
  await vi.waitFor(() => expect(stored()?.title).toBe('Revised'), { timeout: 8000 });
  unlinkSync(join(f.config.knowledgeRoot, 'Public/a.md'));
  await vi.waitFor(() => expect(stored()).toBeNull(), { timeout: 8000 });
  writeFileSync(
    join(f.config.knowledgeRoot, 'Public/a.md'),
    '# Restored\nChemistry studies molecules.',
  );
  await vi.waitFor(() => expect(stored()?.title).toBe('Restored'), { timeout: 8000 });
});
it('excludes fenced code across chunks and recognizes heading/tag/alias phrases', async () => {
  const f = fixture();
  f.note(
    'a',
    'Public/a.md',
    '---\ntags: ["Graph theory"]\naliases: ["Knowledge systems"]\n---\n# Network Research\n```\n' +
      'SecretToken hiddenCode\n'.repeat(900) +
      '```\nPublicConcept retrieval.',
  );
  f.service.start();
  await complete(f);
  const graph = await f.service.explore(webPrincipal, {});
  expect(graph.nodes.some((n) => n.title === 'Graph theory')).toBe(true);
  expect(graph.nodes.some((n) => n.title === 'Knowledge systems')).toBe(true);
  expect(graph.nodes.some((n) => n.title === 'Network Research')).toBe(true);
  expect(JSON.stringify(graph.nodes)).not.toContain('SecretToken');
});
it('does not publish an in-flight model result after a managed conflict or configuration change', async () => {
  let release!: (v: any) => void,
    fingerprint = 'first';
  const f = fixture({
    fingerprint: () => fingerprint,
    settings: () => ({
      version: 1,
      provider: 'ollama',
      baseUrl: 'http://localhost:11434',
      model: 'fixture',
      automatic: true,
      remoteContentAllowed: false,
      apiKeyConfigured: false,
      timeoutMs: 1000,
      maxInputCharacters: 12000,
    }),
    extract: vi.fn(() => new Promise<any>((r) => (release = r))),
  });
  f.note('a', 'Public/a.md', '# A\nAlpha connects Beta.');
  f.service.start();
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  f.db
    .prepare(
      'INSERT INTO document_state(note_id,content_hash,source_revision,conflict) VALUES(?,?,?,?)',
    )
    .run('a', 'hash', 1, 1);
  fingerprint = 'second';
  release({
    entities: [{ name: 'Alpha', kind: 'concept', quote: 'Alpha connects Beta.' }],
    relations: [],
  });
  await new Promise((r) => setTimeout(r, 100));
  expect(f.db.prepare('SELECT * FROM graph_analysis_sources').all()).toEqual([]);
  expect((await f.service.explore(webPrincipal, {})).nodes).toEqual([]);
});
it('a superseded worker cannot delete a newer worker publication', async () => {
  let release!: (v: any) => void;
  const settings = {
    version: 1,
    provider: 'ollama' as const,
    baseUrl: 'http://localhost',
    model: 'fixture',
    automatic: true,
    remoteContentAllowed: false,
    apiKeyConfigured: false,
    timeoutMs: 1000,
    maxInputCharacters: 12000,
  };
  const f = fixture({
    settings: () => settings,
    extract: vi.fn(() => new Promise<any>((r) => (release = r))),
  });
  const second = createKnowledgeGraph(f.config, f.db, {} as NoteService, {
    ...f.model,
    extract: async () => ({ entities: [], relations: [] }),
  });
  cleanup.push(() => second.close());
  f.note('a', 'Public/a.md', '# Old\nAlpha research.');
  f.service.start();
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  writeFileSync(join(f.config.knowledgeRoot, 'Public/a.md'), '# New\nBeta research.');
  f.db
    .prepare('INSERT INTO document_state(note_id,content_hash,source_revision) VALUES(?,?,?)')
    .run('a', 'new', 2);
  second.start();
  await vi.waitFor(() => expect(second.status(webPrincipal).completed).toBe(1));
  release({ entities: [], relations: [] });
  await new Promise((r) => setTimeout(r, 30));
  expect(
    JSON.parse((f.db.prepare('SELECT data FROM graph_analysis_sources').get() as any).data).title,
  ).toBe('New');
});
it('honors provider input limits below 1000 and accepts valid long model quotes', async () => {
  const quote = 'A'.repeat(2500),
    name = 'N'.repeat(150);
  const long = fixture({
    settings: () => ({
      version: 1,
      provider: 'ollama',
      baseUrl: 'http://localhost',
      model: 'fixture',
      automatic: true,
      remoteContentAllowed: false,
      apiKeyConfigured: false,
      timeoutMs: 1000,
      maxInputCharacters: 3000,
    }),
    extract: async () => ({ entities: [{ name, kind: 'person', quote }], relations: [] }),
  });
  long.note('a', 'Public/a.md', quote);
  long.service.start();
  await complete(long);
  expect((await long.service.explore(webPrincipal, {})).nodes.some((n) => n.title === name)).toBe(
    true,
  );
  const small = fixture({
    settings: () => ({
      version: 1,
      provider: 'ollama',
      baseUrl: 'http://localhost',
      model: 'fixture',
      automatic: true,
      remoteContentAllowed: false,
      apiKeyConfigured: false,
      timeoutMs: 1000,
      maxInputCharacters: 100,
    }),
    extract: async (text) => {
      expect(text.length).toBeLessThanOrEqual(100);
      return { entities: [], relations: [] };
    },
  });
  small.note('a', 'Public/a.md', '# Bounded\n' + 'Alpha research. '.repeat(20));
  small.service.start();
  await complete(small);
});
it('discovers externally added files with a bounded fallback when host indexing is disabled', async () => {
  const f = fixture();
  (f.config as any).indexing = { enabled: false };
  // Recreate after selecting host mode; no noteService scan or browser request is involved.
  await f.service.close();
  const service = createKnowledgeGraph(f.config, f.db, {} as NoteService, f.model);
  cleanup.push(() => service.close());
  mkdirSync(join(f.config.knowledgeRoot, 'External'));
  writeFileSync(
    join(f.config.knowledgeRoot, 'External/new.md'),
    '# New external\nDiscovery finds concepts.',
  );
  service.start();
  await vi.waitFor(
    () =>
      expect(f.db.prepare("SELECT id FROM notes WHERE path='External/new.md'").get()).toBeTruthy(),
    { timeout: 8000 },
  );
  await vi.waitFor(() => expect(service.status(webPrincipal).completed).toBe(1), { timeout: 8000 });
  expect((await service.explore(webPrincipal, { q: 'Discovery' })).nodes.length).toBeGreaterThan(0);
});
it('turning automatic off preserves published results and explicit rebuild drains once', async () => {
  let automatic = true;
  const f = fixture({
    settings: () => ({
      version: 1,
      provider: 'none',
      baseUrl: '',
      model: '',
      automatic,
      remoteContentAllowed: false,
      apiKeyConfigured: false,
      timeoutMs: 1000,
      maxInputCharacters: 12000,
    }),
  });
  f.note('a', 'Public/a.md', '# Stable\nAstronomy studies galaxies.');
  f.service.start();
  await complete(f);
  const before = (await f.service.explore(webPrincipal, {})).nodes.map((n) => n.id);
  automatic = false;
  await new Promise((r) => setTimeout(r, 350));
  expect((await f.service.explore(webPrincipal, {})).nodes.map((n) => n.id)).toEqual(before);
  expect(f.service.status(webPrincipal)).toMatchObject({ automatic: false, state: 'paused' });
  f.note('b', 'Public/b.md', '# Pending\nBiology studies organisms.');
  await new Promise((r) => setTimeout(r, 350));
  expect(f.service.status(webPrincipal).completed).toBe(1);
  f.service.control(webPrincipal, { action: 'rebuild' });
  await complete(f, 2);
  await vi.waitFor(() => expect(f.service.status(webPrincipal).state).toBe('paused'));
  f.note('c', 'Public/c.md', '# Still pending\nChemistry studies molecules.');
  await new Promise((r) => setTimeout(r, 350));
  expect(f.service.status(webPrincipal).completed).toBe(2);
});
it('recovers a dead process lease after restart and reports source-budget partial results explicitly', async () => {
  const f = fixture();
  f.note('a', 'Public/a.md', '# Recovery\nAstronomy studies galaxies.');
  f.db
    .prepare(
      "UPDATE graph_analysis_jobs SET state='running',owner_pid=2147483647,owner_start='dead',lease_until=? WHERE note_id='a'",
    )
    .run(Date.now() + 999999);
  await f.service.close();
  const restarted = createKnowledgeGraph(f.config, f.db, {} as NoteService, f.model);
  cleanup.push(() => restarted.close());
  restarted.start();
  await vi.waitFor(() => expect(restarted.status(webPrincipal).completed).toBe(1));
  const g = fixture();
  g.note('large', 'Public/large.md', '# Bounded\n' + 'Astronomy studies galaxies.\n'.repeat(45000));
  g.service.start();
  await vi.waitFor(() => expect(g.service.status(webPrincipal).failed).toBe(1), { timeout: 10000 });
  expect(g.service.status(webPrincipal).errors[0].code).toBe('PARTIAL_SOURCE_LIMIT');
  expect((await g.service.explore(webPrincipal, {})).index.complete).toBe(false);
});
