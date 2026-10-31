import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { openDatabase, type AppDatabase } from '../packages/core/db';
import { noteService } from '../packages/core/notes';
import { assetService } from '../packages/core/assets';
import { primaryDiagramService } from '../packages/core/knowledge/primary-diagrams';
import { diagramCreationService } from '../packages/core/knowledge/diagram-creation';
import { emptyWhiteboard } from '../shared/whiteboard';
import { diagramRendererVersions, renderPreparedDiagramDocument } from '../shared/diagram-primary';
import { diagramResourceSchema } from '../shared/diagram-resource';
import type { AppConfig } from '../shared/contracts';
import type { Principal } from '../shared/knowledge-contracts';
const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=',
    'base64',
  ),
  sha = (s: string) => createHash('sha256').update(s).digest('hex');
const principal: Principal = {
  id: 'owner',
  clientId: 'resource-reader',
  scopes: ['knowledge:read', 'knowledge:write'],
  allowedPrefixes: ['00-Inbox'],
};
let root: string, config: AppConfig, db: AppDatabase;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'diagram-resource-'));
  config = {
    knowledgeRoot: join(root, 'knowledge'),
    dataRoot: join(root, 'data'),
    secret: 'test-only',
    origin: 'http://localhost',
  };
  mkdirSync(join(config.knowledgeRoot, '00-Inbox'), { recursive: true });
  db = openDatabase(config.dataRoot);
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});
function service(p = principal) {
  const notes = noteService(config, db),
    assets = assetService(config, db, notes);
  return primaryDiagramService(config, db, notes, assets, p);
}
function fixture(type: 'whiteboard' | 'mindmap' | 'flowchart' = 'whiteboard') {
  const intent = diagramCreationService(config, db, principal).reserve({
      path: '00-Inbox/resource.md',
      type,
      requestId: randomUUID(),
    }),
    source =
      type === 'whiteboard'
        ? JSON.stringify(emptyWhiteboard())
        : type === 'mindmap'
          ? '- 子节点\n'
          : 'flowchart TD\n A-->B\n';
  const primary = service(),
    prepared = primary.prepare({
      target: { kind: 'creation', intentId: intent.id },
      type,
      source,
      sourceHash: sha(source),
      title: '完整标题 [中文]',
      renderer: diagramRendererVersions[type],
      config: {},
      pngBase64: png.toString('base64'),
      requestId: randomUUID(),
    }),
    markdown = renderPreparedDiagramDocument({ prepared, title: prepared.title, source });
  const note = primary.commit({ preparedId: prepared.id, markdown, requestId: randomUUID() });
  return { note, source, prepared, markdown, primary };
}
it.each(['whiteboard', 'mindmap', 'flowchart'] as const)(
  'resolves a %s resource independently of its Markdown main-file response',
  (type) => {
    const f = fixture(type),
      resource = f.primary.resolve(f.note.id);
    expect(resource).toMatchObject({
      version: 1,
      noteId: f.note.id,
      documentType: type,
      title: f.note.title,
      role: 'primary',
      documentHash: sha(f.markdown),
      source: {
        format:
          type === 'whiteboard'
            ? 'excalidraw'
            : type === 'mindmap'
              ? 'markdown-outline'
              : 'mermaid',
        hash: sha(f.source),
        content: f.source,
      },
      preview: { state: 'ready' },
      capabilities: { canEdit: true, canDownloadSource: true },
    });
    expect(diagramResourceSchema.safeParse(resource).success).toBe(true);
  },
);
it('reports missing source data while retaining the PNG and never fabricating an empty scene', () => {
  const f = fixture();
  unlinkSync(join(config.knowledgeRoot, f.prepared.source!.relativePath));
  const resource = f.primary.resolve(f.note.id);
  expect(resource).toMatchObject({
    preview: { hash: f.prepared.previewHash, state: 'stale' },
    capabilities: { canEdit: false, canDownloadSource: false },
    issues: expect.arrayContaining([expect.objectContaining({ code: 'DIAGRAM_SOURCE_UNAVAILABLE' })]),
  });
  expect(resource.source).not.toHaveProperty('content');
  expect(resource.source).not.toHaveProperty('path');
});
it('marks an externally changed source as conflicting and does not present its old PNG as current', () => {
  const f = fixture(),
    changed = JSON.stringify({ ...emptyWhiteboard(), appState: { viewBackgroundColor: '#eee' } });
  writeFileSync(join(config.knowledgeRoot, f.prepared.source!.relativePath), changed);
  const resource = f.primary.resolve(f.note.id);
  expect(resource).toMatchObject({
    source: { hash: sha(changed) },
    preview: { state: 'stale' },
    capabilities: { canEdit: false, canDownloadSource: true },
    issues: expect.arrayContaining([expect.objectContaining({ code: 'DIAGRAM_SOURCE_CONFLICT' })]),
  });
});
it('keeps source editing available when only its PNG must be regenerated', () => {
  const f = fixture();
  unlinkSync(join(config.knowledgeRoot, f.prepared.preview.relativePath));
  expect(f.primary.resolve(f.note.id)).toMatchObject({
    preview: { state: 'missing' },
    capabilities: { canEdit: true, canDownloadSource: true },
    issues: [expect.objectContaining({ code: 'DIAGRAM_PREVIEW_MISSING' })],
  });
});
it('uses an authorized opaque handle rather than oversized inline source data when requested', () => {
  const f = fixture();
  let captured = '';
  const resource = f.primary.resolve(f.note.id, {
    maxInlineBytes: 1,
    sourceHandle: (snapshot) => {
      captured = snapshot.content;
      return 'opaque-owned-source';
    },
  });
  expect(resource.source).toMatchObject({ readHandle: 'opaque-owned-source' });
  expect(resource.source).not.toHaveProperty('content');
  expect(captured).toBe(f.source);
});
it('checks current note rights, source proof and read-only capability independently', () => {
  const f = fixture();
  expect(
    service({ ...principal, allowedPrefixes: [f.note.relativePath] }).resolve(f.note.id)
      .capabilities.canDownloadSource,
  ).toBe(true);
  expect(
    service({ ...principal, scopes: ['knowledge:read'] }).resolve(f.note.id).capabilities.canEdit,
  ).toBe(false);
  expect(() =>
    service({ ...principal, allowedPrefixes: ['30-Knowledge'] }).resolve(f.note.id),
  ).toThrowError(expect.objectContaining({ statusCode: 403 }));
  expect(() => service({ ...principal, id: 'share:untrusted' }).resolve(f.note.id)).toThrowError(
    expect.objectContaining({ statusCode: 403 }),
  );
});
