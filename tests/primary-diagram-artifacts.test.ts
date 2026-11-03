import { afterEach, beforeEach, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AppConfig } from '../shared/contracts';
import type { Principal } from '../shared/knowledge-contracts';
import { emptyWhiteboard } from '../shared/whiteboard';
import { parseDiagramDocument } from '../shared/diagram-document';
import { diagramRendererVersions, renderPreparedDiagramDocument } from '../shared/diagram-primary';
import { openDatabase, type AppDatabase } from '../packages/core/db';
import { noteService } from '../packages/core/notes';
import { assetService } from '../packages/core/assets';
import { diagramCreationService } from '../packages/core/knowledge/diagram-creation';
import { primaryDiagramService } from '../packages/core/knowledge/primary-diagrams';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=',
  'base64',
);
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const principal: Principal = {
  id: 'owner',
  clientId: 'editor',
  scopes: ['knowledge:read', 'knowledge:write'],
  allowedPrefixes: ['00-Inbox'],
};
let root: string, config: AppConfig, db: AppDatabase;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'primary-diagram-'));
  config = {
    knowledgeRoot: join(root, 'knowledge'),
    dataRoot: join(root, 'data'),
    secret: 'test-secret-only',
    origin: 'http://localhost',
  };
  mkdirSync(join(config.knowledgeRoot, '00-Inbox'), { recursive: true });
  db = openDatabase(config.dataRoot);
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});
function services(p = principal) {
  const notes = noteService(config, db),
    assets = assetService(config, db, notes);
  return {
    notes,
    assets,
    creations: diagramCreationService(config, db, p),
    primary: primaryDiagramService(config, db, notes, assets, p),
  };
}
function reserve(type: 'whiteboard' | 'mindmap' | 'flowchart' = 'whiteboard') {
  return services().creations.reserve({ path: '00-Inbox/图形.md', type, requestId: randomUUID() });
}
function input(
  intentId: string,
  type: 'whiteboard' | 'mindmap' | 'flowchart' = 'whiteboard',
  source = JSON.stringify(emptyWhiteboard()),
) {
  return {
    target: { kind: 'creation' as const, intentId },
    type,
    source,
    sourceHash: hash(source),
    title: '系统 [架构]',
    renderer: diagramRendererVersions[type],
    config: {},
    pngBase64: png.toString('base64'),
    requestId: randomUUID(),
  };
}

it.each(['whiteboard', 'mindmap', 'flowchart'] as const)(
  'prepares %s as immutable artifacts without activating the reserved document',
  (type) => {
    const intent = reserve(type),
      source =
        type === 'whiteboard'
          ? JSON.stringify(emptyWhiteboard())
          : type === 'mindmap'
            ? '- 中文子节点\n'
            : 'flowchart TD\n A[中文]-->B[PNG]\n';
    const s = services(),
      request = input(intent.id, type, source),
      prepared = s.primary.prepare(request);
    expect(prepared).toMatchObject({
      noteId: intent.noteId,
      creationIntentId: intent.id,
      type,
      sourceHash: hash(source),
      previewHash: hash(png),
    });
    expect(prepared.renderHash).toMatch(/^[a-f0-9]{64}$/);
    expect(readFileSync(join(config.knowledgeRoot, prepared.preview.relativePath))).toEqual(png);
    if (type === 'whiteboard')
      expect(readFileSync(join(config.knowledgeRoot, prepared.source!.relativePath), 'utf8')).toBe(
        source,
      );
    else expect(prepared.source).toBeUndefined();
    expect(existsSync(join(config.knowledgeRoot, intent.relativePath))).toBe(false);
    expect(db.prepare('SELECT count(*) AS count FROM notes').get()).toEqual({ count: 0 });
    const markdown = renderPreparedDiagramDocument({
      prepared,
      title: request.title,
      source,
      description: '说明原样保存。\n',
    });
    const parsed = parseDiagramDocument(markdown);
    expect(parsed.status).toBe('diagram');
    if (parsed.status !== 'diagram') throw Error('expected diagram');
    expect(parsed.title).toBe(request.title);
    expect(parsed.primary.binding).toMatchObject({
      sourceHash: hash(source),
      renderHash: prepared.renderHash,
      previewHash: hash(png),
    });
    if (type !== 'whiteboard')
      expect(parsed.primary.source).toEqual({
        format: type === 'mindmap' ? 'markdown-outline' : 'mermaid',
        content: source,
      });
    expect(s.primary.prepare(request)).toEqual(prepared);
  },
);

it('validates source hash, canonical inline bytes, PNG and renderer before creating artifacts', () => {
  const intent = reserve(),
    s = services(),
    request = input(intent.id);
  for (const changed of [
    { sourceHash: 'f'.repeat(64) },
    { pngBase64: Buffer.from('not png').toString('base64') },
    { renderer: 'unrecognized-renderer' },
  ])
    expect(() => s.primary.prepare({ ...request, ...changed })).toThrow();
  expect(existsSync(join(config.knowledgeRoot, '00-Inbox/_doo-assets'))).toBe(false);
  s.creations.cancel(intent.id);
  const flow = reserve('flowchart'),
    bad = input(flow.id, 'flowchart', 'flowchart TD\n A-->B');
  expect(() => s.primary.prepare(bad)).toThrow();
});

it('checks lease ownership and current authority for all retries', () => {
  const intent = reserve(),
    request = input(intent.id),
    prepared = services().primary.prepare(request);
  expect(() => services({ ...principal, clientId: 'other' }).primary.prepare(request)).toThrowError(
    expect.objectContaining({ statusCode: 404 }),
  );
  expect(() =>
    services({ ...principal, allowedPrefixes: ['30-Knowledge'] }).primary.prepare(request),
  ).toThrowError(expect.objectContaining({ statusCode: 403 }));
  db.prepare('UPDATE diagram_prepared_primaries SET expires_at=1 WHERE id=?').run(prepared.id);
  expect(() => services().primary.prepare(request)).toThrowError(
    expect.objectContaining({ code: 'DIAGRAM_PREPARATION_EXPIRED' }),
  );
});

it('recovers an idempotent receipt across restart and detects externally overwritten immutable artifacts', () => {
  const intent = reserve(),
    request = input(intent.id),
    first = services().primary.prepare(request);
  db.close();
  db = openDatabase(config.dataRoot);
  expect(services().primary.prepare(request)).toEqual(first);
  const changed = JSON.stringify({
    ...emptyWhiteboard(),
    appState: { viewBackgroundColor: '#eeeeee' },
  });
  expect(() =>
    services().primary.prepare({ ...request, source: changed, sourceHash: hash(changed) }),
  ).toThrowError(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }));
  writeFileSync(join(config.knowledgeRoot, first.source!.relativePath), changed);
  expect(() => services().primary.prepare(request)).toThrowError(
    expect.objectContaining({ code: 'DIAGRAM_ARTIFACT_CONFLICT' }),
  );
});

it('does not let an ordinary upload use an unpublished identity', () => {
  const intent = reserve();
  expect(() => services().assets.upload(intent.noteId, 'a.png', 'image/png', png)).toThrowError(
    expect.objectContaining({ statusCode: 404 }),
  );
});

it('binds existing document preparation to both full Markdown bytes and actual source bytes', () => {
  const s = services(),
    intent = reserve(),
    initial = input(intent.id),
    prepared = s.primary.prepare(initial);
  const markdown = renderPreparedDiagramDocument({
    prepared,
    title: initial.title,
    source: initial.source,
    description: '原始说明\n',
  });
  writeFileSync(join(config.knowledgeRoot, intent.relativePath), markdown);
  s.notes.scan();
  const note = db
    .prepare('SELECT id FROM notes WHERE path=? AND active=1')
    .get(intent.relativePath) as { id: string };
  const request = {
    ...input(intent.id),
    target: {
      kind: 'document' as const,
      noteId: note.id,
      expectedDocumentHash: hash(markdown),
      expectedSourceHash: initial.sourceHash,
    },
  };
  const existing = s.primary.prepare(request);
  expect(existing).toMatchObject({
    noteId: note.id,
    documentHash: hash(markdown),
    baselineSourceHash: initial.sourceHash,
  });
  expect(existing.creationIntentId).toBeUndefined();
  writeFileSync(join(config.knowledgeRoot, intent.relativePath), markdown + '外部编辑\n');
  expect(() => s.primary.prepare({ ...request, requestId: randomUUID() })).toThrowError(
    expect.objectContaining({ code: 'VERSION_CONFLICT' }),
  );
  writeFileSync(join(config.knowledgeRoot, intent.relativePath), markdown);
  writeFileSync(
    join(config.knowledgeRoot, prepared.source!.relativePath),
    JSON.stringify({ ...emptyWhiteboard(), appState: { viewBackgroundColor: '#eee' } }),
  );
  expect(() => s.primary.prepare({ ...request, requestId: randomUUID() })).toThrowError(
    expect.objectContaining({ code: 'DIAGRAM_SOURCE_CONFLICT' }),
  );
});

it('resumes partial uploads after failed registration without activating a partial main file', () => {
  const intent = reserve(),
    request = input(intent.id);
  db.exec(
    "CREATE TRIGGER primary_png_failure BEFORE INSERT ON assets WHEN NEW.path LIKE '%.png' BEGIN SELECT RAISE(FAIL, 'fixture png failure'); END",
  );
  expect(() => services().primary.prepare(request)).toThrow();
  expect(existsSync(join(config.knowledgeRoot, intent.relativePath))).toBe(false);
  db.exec('DROP TRIGGER primary_png_failure');
  db.close();
  db = openDatabase(config.dataRoot);
  const completed = services().primary.prepare(request);
  expect(completed.sourceHash).toBe(request.sourceHash);
  expect(db.prepare('SELECT count(*) AS count FROM assets').get()).toEqual({ count: 2 });
  expect(services().primary.prepare(request)).toEqual(completed);
});

it.each(['\n- 子节点\n', '\n', ' \n- 子节点\n'])(
  'rejects inline source whose exact byte range cannot survive serialization (%j)',
  (source) => {
    const intent = reserve('mindmap');
    expect(() => services().primary.prepare(input(intent.id, 'mindmap', source))).toThrow();
    expect(existsSync(join(config.knowledgeRoot, '00-Inbox/_doo-assets'))).toBe(false);
  },
);

it.each([
  'hello\n\n    code',
  'hello\n\n\tcode',
  '文字\n```text\n<!-- dooknow:primary:end -->\n```',
])(
  'prepares and serializes arbitrary whiteboard text without creating unintended blocks (%j)',
  (text) => {
    const intent = reserve(),
      source = JSON.stringify({
        ...emptyWhiteboard(),
        elements: [{ id: 'label', type: 'text', text }],
      }),
      request = input(intent.id, 'whiteboard', source);
    const prepared = services().primary.prepare(request);
    const markdown = renderPreparedDiagramDocument({ prepared, title: request.title, source });
    const parsed = parseDiagramDocument(markdown);
    expect(parsed.status).toBe('diagram');
    if (parsed.status !== 'diagram') throw Error('expected diagram');
    expect(parsed.primary.summary).toBe(text + '\n');
  },
);

it('serializes a bounded whiteboard label containing many fence runs without argument-stack overflow', () => {
  const text = '`a'.repeat(140_000),
    intent = reserve(),
    source = JSON.stringify({
      ...emptyWhiteboard(),
      elements: [{ id: 'label', type: 'text', text }],
    }),
    request = input(intent.id, 'whiteboard', source);
  const prepared = services().primary.prepare(request);
  const markdown = renderPreparedDiagramDocument({ prepared, title: request.title, source });
  const parsed = parseDiagramDocument(markdown);
  expect(parsed.status).toBe('diagram');
  if (parsed.status !== 'diagram') throw Error('expected diagram');
  expect(parsed.primary.summary).toBe(text + '\n');
});
