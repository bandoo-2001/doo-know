import { api } from '../api';
import { parseWhiteboard, whiteboardId, whiteboardReference } from '../../../shared/whiteboard';
import { validateSvgSource } from '../../../shared/svg-policy';
import { isDiagramKind } from '../../../shared/diagram-fences';
import {
  assertGeneratedSvgSafe,
  assertMermaidSourceSafe,
  preparePreview,
  type DiagramKind,
} from './preview-artifact';

export type DiagramSourceInput = { kind: DiagramKind; code: string; noteId?: string };
export type PreparedDiagramSource = { source: string; png: Blob };

export async function readWhiteboardSource({
  code,
  noteId,
}: Pick<DiagramSourceInput, 'code' | 'noteId'>) {
  const reference = whiteboardReference(code);
  if (!reference) throw Error('白板引用格式不正确');
  let url: string;
  if (whiteboardId(reference)) url = '/api/notes/' + encodeURIComponent(reference);
  else if (noteId)
    url = `/api/notes/${encodeURIComponent(noteId)}/whiteboards/resolve?source=${encodeURIComponent(reference)}`;
  else throw Error('请从原笔记打开此白板引用');
  const board = await api<{ content?: unknown }>(url);
  if (typeof board.content !== 'string') throw Error('白板响应缺少有效源码');
  const scene = parseWhiteboard(board.content);
  if (scene.elements.some((element) => ['iframe', 'embeddable'].includes(element.type)))
    throw Error('白板包含不支持的嵌入资源，源码已保留');
  return board.content;
}

/** Prepares a bounded immutable source/PNG pair. Publication belongs to the caller. */
export async function prepareDiagramSource(
  input: DiagramSourceInput,
): Promise<PreparedDiagramSource> {
  if (!isDiagramKind(input.kind) || typeof input.code !== 'string') throw Error('不支持此图形格式');
  const { kind, code, noteId } = input;
  let source = code;
  let generatedSvg = '';
  if (kind === 'svg') {
    const validation = validateSvgSource(new TextEncoder().encode(source));
    if (!validation.ok) throw Error(validation.message);
  } else if (kind === 'mermaid') {
    assertMermaidSourceSafe(source);
    const { default: mermaid } = await import('mermaid');
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      theme:
        typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark'
          ? 'dark'
          : 'default',
      maxTextSize: 50000,
      maxEdges: 500,
      flowchart: { htmlLabels: false },
      htmlLabels: false,
    });
    const rendered = await mermaid.render('dooknow-save-preview-' + crypto.randomUUID(), source);
    generatedSvg = rendered.svg;
    assertGeneratedSvgSafe(generatedSvg);
  } else {
    source = await readWhiteboardSource({ code, noteId });
  }
  const prepared = await preparePreview(
    kind === 'mermaid' ? { kind, source, svg: generatedSvg } : { kind, source },
  );
  if (prepared.preview.type !== 'image/png' || prepared.preview.size === 0)
    throw Error('PNG 预览生成失败，源码已保留');
  if (prepared.preview.size > 10 * 1024 ** 2) throw Error('PNG 预览不能超过 10 MiB，源码已保留');
  return { source, png: prepared.preview };
}
