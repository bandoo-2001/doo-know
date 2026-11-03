import { expect, it } from 'vitest';
import { diagramResourceSchema, diagramPreviewRequiredSchema } from '../shared/diagram-resource';
import { documentType } from '../shared/whiteboard';
import { readFileSync } from 'node:fs';

it('keeps extension compatibility while deriving explicit types from complete Markdown', () => {
  expect(documentType('旧白板.excalidraw')).toBe('whiteboard');
  expect(documentType('普通.md', '# 笔记\n```mermaid\nA-->B\n```')).toBe('markdown');
  for (const type of ['whiteboard', 'mindmap', 'flowchart']) {
    const source = readFileSync(
      new URL('./fixtures/diagram-documents/' + type + '.md', import.meta.url),
      'utf8',
    );
    expect(documentType(type + '.md', source)).toBe(type);
    expect(documentType(type + '.md', source.replace('"version":1', '"version":99'))).toBe(
      'markdown',
    );
  }
});

it('represents an inline authoritative source and preview without requiring a source attachment', () => {
  const resource = {
    version: 1,
    noteId: 'note-one',
    documentType: 'mindmap',
    role: 'primary',
    documentHash: 'a'.repeat(64),
    source: { format: 'markdown-outline', hash: 'b'.repeat(64), content: '- 子节点\n' },
    preview: {
      path: 'assets/preview.png',
      hash: 'c'.repeat(64),
      renderHash: 'd'.repeat(64),
      state: 'ready',
    },
    capabilities: { canEdit: true, canDownloadSource: true },
  };
  expect(diagramResourceSchema.parse(resource).source).toEqual(resource.source);
  expect(diagramResourceSchema.safeParse({ ...resource, role: 'mindmap' }).success).toBe(false);
  expect(
    diagramResourceSchema.safeParse({ ...resource, preview: { ...resource.preview, hash: 'bad' } })
      .success,
  ).toBe(false);
  expect(
    diagramResourceSchema.safeParse({
      ...resource,
      source: { format: 'excalidraw', hash: 'b'.repeat(64) },
    }).success,
  ).toBe(false);
});

it('retains structured versioned pending previews for persisted tasks and retries', () => {
  const error = {
    code: 'DIAGRAM_PREVIEW_REQUIRED',
    planId: 'plan-one',
    documents: [
      {
        noteId: 'n',
        role: 'primary',
        documentHash: 'a'.repeat(64),
        sourceHash: 'b'.repeat(64),
        renderHash: 'c'.repeat(64),
      },
    ],
  };
  expect(diagramPreviewRequiredSchema.parse(error)).toEqual(error);
  expect(diagramPreviewRequiredSchema.safeParse({ ...error, documents: [] }).success).toBe(false);
  expect(
    diagramPreviewRequiredSchema.safeParse({ code: error.code, message: 'prepare something' })
      .success,
  ).toBe(false);
});

it('supports public preview metadata without exposing a source path, content or handle', () => {
  const resource = {
    version: 1,
    noteId: 'note-one',
    documentType: 'whiteboard',
    role: 'primary',
    documentHash: 'a'.repeat(64),
    source: { format: 'excalidraw', hash: 'b'.repeat(64) },
    preview: {
      path: 'assets/preview.png',
      hash: 'c'.repeat(64),
      renderHash: 'd'.repeat(64),
      state: 'ready',
    },
    capabilities: { canEdit: false, canDownloadSource: false },
  };
  expect(diagramResourceSchema.safeParse(resource).success).toBe(true);
  expect(
    diagramResourceSchema.safeParse({
      ...resource,
      source: { ...resource.source, path: 'assets/private.excalidraw' },
    }).success,
  ).toBe(false);
});

it('rejects a primary source format inconsistent with its explicit document type', () => {
  const resource = {
    version: 1,
    noteId: 'n',
    documentType: 'flowchart',
    role: 'primary',
    documentHash: 'a'.repeat(64),
    source: { format: 'excalidraw', hash: 'b'.repeat(64), content: '{}' },
    capabilities: { canEdit: true, canDownloadSource: true },
  };
  expect(diagramResourceSchema.safeParse(resource).success).toBe(false);
});
