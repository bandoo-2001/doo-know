import { it, expect } from 'vitest';
import {
  parseWhiteboard,
  emptyWhiteboard,
  whiteboardText,
  documentTitle,
} from '../shared/whiteboard';
import { parseImport, importPreview } from '../apps/server/platform/transfer-import';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
it('retains embedded raster files and extracts only live text nodes', () => {
  const scene = emptyWhiteboard();
  scene.elements = [
    { id: 't1', type: 'text', text: '架构文字' },
    { id: 't2', type: 'text', text: '删除文字', isDeleted: true },
  ];
  scene.files = {
    image1: { id: 'image1', mimeType: 'image/png', dataURL: 'data:image/png;base64,iVBORw0KGgo=' },
  };
  const content = JSON.stringify(scene);
  expect(parseWhiteboard(content).files).toEqual(scene.files);
  expect(whiteboardText(content)).toBe('架构文字');
  expect(documentTitle('00-Inbox/架构.excalidraw', content)).toBe('架构');
});
it('rejects invalid scene structures and active content', () => {
  for (const value of [
    null,
    {},
    { ...emptyWhiteboard(), elements: {} },
    { ...emptyWhiteboard(), elements: [{ id: 'a', type: 'text', x: '10' }] },
    { ...emptyWhiteboard(), elements: [{ id: 'a', type: 'text', link: 'javascript:alert(1)' }] },
    {
      ...emptyWhiteboard(),
      files: {
        a: { id: 'a', mimeType: 'image/svg+xml', dataURL: 'data:image/svg+xml;base64,PHN2Zz4=' },
      },
    },
    {
      ...emptyWhiteboard(),
      files: {
        a: { id: 'a', mimeType: 'image/png', dataURL: 'https://example.invalid/private.png' },
      },
    },
  ])
    expect(() => parseWhiteboard(JSON.stringify(value))).toThrow();
});
it('rejects nonfinite geometry, corrupt freehand points and prototype keys before mounting the canvas', () => {
  for (const element of [
    { id: 'a', type: 'rectangle', x: 1e100 },
    { id: 'a', type: 'freedraw', points: [null] },
    { id: 'a', type: 'rectangle', boundElementIds: {} },
    { id: 'a', type: 'rectangle', groupIds: 'invalid' },
    { id: 'a', type: 'rectangle', boundElements: [null] },
    { id: 'a', type: 'arrow', startBinding: { elementId: [] } },
    JSON.parse('{"id":"a","type":"rectangle","customData":{"__proto__":{"polluted":true}}}'),
  ])
    expect(() =>
      parseWhiteboard(JSON.stringify({ ...emptyWhiteboard(), elements: [element] })),
    ).toThrow();
});
it('validates persistent canvas settings and vector-valued element fields', () => {
  for (const appState of [
    { gridSize: {} },
    { viewBackgroundColor: [] },
    { gridModeEnabled: 'yes' },
    { exportScale: 1e100 },
  ])
    expect(() => parseWhiteboard(JSON.stringify({ ...emptyWhiteboard(), appState }))).toThrow();
  for (const element of [
    { id: 'a', type: 'image', scale: {} },
    { id: 'a', type: 'freedraw', lastCommittedPoint: 'bad' },
  ])
    expect(() =>
      parseWhiteboard(JSON.stringify({ ...emptyWhiteboard(), elements: [element] })),
    ).toThrow();
});
it('imports whiteboards as UTF-8 documents and keeps the native extension when renaming collisions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'whiteboard-import-'));
  try {
    await mkdir(join(root, '00-Inbox'));
    const request = parseImport({
      folderPath: '00-Inbox',
      collision: 'rename',
      entries: [
        { path: '设计.excalidraw', encoding: 'utf8', content: JSON.stringify(emptyWhiteboard()) },
      ],
    });
    const preview = importPreview(root, request);
    expect(preview.items[0]).toMatchObject({
      kind: 'note',
      targetPath: '00-Inbox/设计.excalidraw',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
