import { api } from '../api';
import type { NoteDocument } from '../../../shared/contracts';
import type { DiagramResource } from '../../../shared/diagram-resource';
import {
  diagramRendererVersions,
  type PreparedDiagramPrimary,
} from '../../../shared/diagram-primary';
import type { DiagramDocumentType } from '../../../shared/diagram-document';
import type { DiagramPreparationInput } from '../../../shared/diagram-document-contracts';
import { hashDiagramSource, assertMermaidSourceSafe, preparePreview } from './preview-artifact';
import { parseMindmapOutline } from '../../../shared/mindmap-outline';
import { diagramPlainTitle } from '../../../shared/diagram-primary';
import { emptyWhiteboard, parseWhiteboard } from '../../../shared/whiteboard';
import type { DocumentSnapshot } from './document-session';
export type CreationIntent = {
  id: string;
  noteId: string;
  relativePath: string;
  documentType: DiagramDocumentType;
  status: string;
};
export const diagramFormat = {
  whiteboard: 'excalidraw',
  mindmap: 'markdown-outline',
  flowchart: 'mermaid',
} as const;
export function initialDiagramSource(type: DiagramDocumentType) {
  return type === 'whiteboard'
    ? JSON.stringify(emptyWhiteboard())
    : type === 'mindmap'
      ? '- 新节点\n'
      : 'flowchart TD\n  A[开始] --> B[完成]\n';
}
export function reserveDiagram(path: string, type: DiagramDocumentType, requestId: string) {
  return api<CreationIntent>('/api/diagram-documents/intents', 'POST', { path, type, requestId });
}
export function readDiagram(id: string) {
  return api<DiagramResource>('/api/notes/' + encodeURIComponent(id) + '/diagram');
}
export async function renderPrimaryPng(type: DiagramDocumentType, snapshot: DocumentSnapshot) {
  if (type === 'mindmap') {
    const { renderMindmapPng } = await import('./mindmap');
    return renderMindmapPng(
      parseMindmapOutline(diagramPlainTitle(snapshot.title) + '\n\n' + snapshot.source),
    );
  }
  if (type === 'whiteboard') {
    const scene = parseWhiteboard(snapshot.source);
    if (!scene.elements?.some((e: any) => !e.isDeleted)) {
      const canvas = document.createElement('canvas');
      canvas.width = 800;
      canvas.height = 600;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw Error('无法生成 PNG');
      ctx.fillStyle = scene.appState?.viewBackgroundColor || '#ffffff';
      ctx.fillRect(0, 0, 800, 600);
      return new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(Error('PNG 失败'))), 'image/png'),
      );
    }
    return (await preparePreview({ kind: 'excalidraw', source: snapshot.source })).preview;
  }
  assertMermaidSourceSafe(snapshot.source);
  const { default: mermaid } = await import('mermaid');
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    theme: 'default',
    maxEdges: 500,
    maxTextSize: 50000,
    flowchart: { htmlLabels: false },
    htmlLabels: false,
  });
  const rendered = await mermaid.render('primary-' + crypto.randomUUID(), snapshot.source);
  return (await preparePreview({ kind: 'mermaid', source: snapshot.source, svg: rendered.svg }))
    .preview;
}
export async function preparePrimary(
  type: DiagramDocumentType,
  snapshot: DocumentSnapshot,
  png: Blob,
  target: DiagramPreparationInput['target'],
  render?: DiagramResource['render'],
) {
  const bytes = new Uint8Array(await png.arrayBuffer());
  let binary = '';
  for (let from = 0; from < bytes.length; from += 8192)
    binary += String.fromCharCode(...bytes.subarray(from, from + 8192));
  return api<PreparedDiagramPrimary>('/api/diagram-documents/prepare', 'POST', {
    target,
    type,
    source: snapshot.source,
    sourceHash: await hashDiagramSource(snapshot.source),
    title: snapshot.title,
    renderer: diagramRendererVersions[type],
    config: render?.config || {},
    pngBase64: btoa(binary),
    requestId: crypto.randomUUID(),
  });
}
export function commitPrimary(request: {
  preparedId: string;
  markdown: string;
  requestId: string;
}) {
  return api<NoteDocument>('/api/diagram-documents/commit', 'POST', {
    preparedId: request.preparedId,
    markdown: request.markdown,
    requestId: request.requestId,
  });
}
