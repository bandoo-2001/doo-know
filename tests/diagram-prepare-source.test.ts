import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../apps/web/api';
import * as artifacts from '../apps/web/diagrams/preview-artifact';
import { emptyWhiteboard } from '../shared/whiteboard';
import { prepareDiagramSource } from '../apps/web/diagrams/prepare-source';

vi.mock('../apps/web/api', () => ({ api: vi.fn() }));
vi.mock('../apps/web/diagrams/preview-artifact', async original => ({
  ...await original<typeof import('../apps/web/diagrams/preview-artifact')>(),
  preparePreview: vi.fn(),
}));
const mermaid = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock('mermaid', () => ({ default: mermaid }));
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><path d="M0 0H40V20Z"/></svg>';
const png = new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: 'image/png' });
const id = '10000000-0000-4000-8000-000000000001';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(artifacts.preparePreview).mockImplementation(async input => ({ kind: input.kind, sourceHash: 'a'.repeat(64), preview: png }));
  mermaid.render.mockResolvedValue({ svg });
});

describe('preparing a source and PNG without publishing', () => {
  it('keeps exact SVG source bytes and returns the rasterizer output without making an API request', async () => {
    const source = '<?xml version="1.0"?>\r\n<!-- source -->\r\n' + svg;
    expect(await prepareDiagramSource({ kind: 'svg', code: source, noteId: id })).toEqual({ source, png });
    expect(vi.mocked(api).mock.calls).toEqual([]);
  });

  it('rejects unsafe SVG before starting rasterization or a request', async () => {
    await expect(prepareDiagramSource({ kind: 'svg', code: '<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>' })).rejects.toThrow(/SVG/);
    expect(vi.mocked(artifacts.preparePreview).mock.calls).toEqual([]);
    expect(vi.mocked(api).mock.calls).toEqual([]);
  });

  it('renders Mermaid under the same bounded strict settings before preparing its PNG', async () => {
    const code = 'flowchart TD\nA[开始] --> B[完成]';
    expect(await prepareDiagramSource({ kind: 'mermaid', code })).toEqual({ source: code, png });
    expect(mermaid.initialize).toHaveBeenCalledWith(expect.objectContaining({
      startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true,
      maxTextSize: 50000, maxEdges: 500, htmlLabels: false, flowchart: { htmlLabels: false },
    }));
    expect(vi.mocked(api).mock.calls).toEqual([]);
  });

  it('rejects resource-bearing Mermaid before invoking its renderer', async () => {
    await expect(prepareDiagramSource({ kind: 'mermaid', code: 'flowchart TD\nA@{ img: "https://outside.invalid/x" }' })).rejects.toThrow(/资源|支持/);
    expect(mermaid.render.mock.calls).toEqual([]);
  });

  it('rejects unsafe or oversized generated Mermaid SVG before rasterization', async () => {
    for (const markup of [svg.replace('<path', '<image href="https://outside.invalid/x"/><path'), svg.replace('width="40"', 'width="8193"')]) {
      mermaid.render.mockResolvedValueOnce({ svg: markup });
      await expect(prepareDiagramSource({ kind: 'mermaid', code: 'graph TD\nA-->B' })).rejects.toThrow(/资源|安全|尺寸|像素/);
    }
    expect(vi.mocked(artifacts.preparePreview).mock.calls).toEqual([]);
  });

  it('resolves a canonical whiteboard by its stable ID using a read request and preserves its exact source', async () => {
    const source = JSON.stringify({ ...emptyWhiteboard(), dooknow: { id } }, null, 2);
    vi.mocked(api).mockResolvedValue({ id, content: source });
    expect(await prepareDiagramSource({ kind: 'excalidraw', code: id + '\n', noteId: 'parent' })).toEqual({ source, png });
    expect(vi.mocked(api).mock.calls).toEqual([['/api/notes/' + id]]);
  });

  it('resolves a relative whiteboard reference in its parent note context', async () => {
    const source = JSON.stringify(emptyWhiteboard());
    vi.mocked(api).mockResolvedValue({ id, content: source });
    expect(await prepareDiagramSource({ kind: 'excalidraw', code: '../设计.excalidraw', noteId: 'parent' })).toEqual({ source, png });
    expect(vi.mocked(api).mock.calls).toEqual([['/api/notes/parent/whiteboards/resolve?source=..%2F%E8%AE%BE%E8%AE%A1.excalidraw']]);
  });

  it('rejects missing context, remote references and invalid scenes without publishing', async () => {
    await expect(prepareDiagramSource({ kind: 'excalidraw', code: 'board.excalidraw' })).rejects.toThrow(/原笔记|上下文/);
    await expect(prepareDiagramSource({ kind: 'excalidraw', code: 'https://outside.invalid/x.excalidraw', noteId: 'parent' })).rejects.toThrow(/引用/);
    expect(vi.mocked(api).mock.calls).toEqual([]);
    vi.mocked(api).mockResolvedValue({ id, content: '{}' });
    await expect(prepareDiagramSource({ kind: 'excalidraw', code: id })).rejects.toThrow(/白板/);
    expect(vi.mocked(artifacts.preparePreview).mock.calls).toEqual([]);
  });

  it('rejects embedded remote surfaces before the whiteboard exporter is called', async () => {
    vi.mocked(api).mockResolvedValue({ id, content: JSON.stringify({ ...emptyWhiteboard(), elements: [{ id: 'embed', type: 'embeddable', link: 'https://outside.invalid' }] }) });
    await expect(prepareDiagramSource({ kind: 'excalidraw', code: id })).rejects.toThrow(/资源|嵌入/);
    expect(vi.mocked(artifacts.preparePreview).mock.calls).toEqual([]);
  });

  it('retains caller source on preview failure and rejects PNG output exceeding the existing attachment cap', async () => {
    const input = Object.freeze({ kind: 'svg' as const, code: svg });
    vi.mocked(artifacts.preparePreview).mockRejectedValueOnce(Error('PNG encoding failed'));
    await expect(prepareDiagramSource(input)).rejects.toThrow('PNG encoding failed');
    expect(input.code).toBe(svg);
    vi.mocked(artifacts.preparePreview).mockResolvedValueOnce({ kind: 'svg', sourceHash: 'a'.repeat(64), preview: new Blob([new Uint8Array(10 * 1024 ** 2 + 1)], { type: 'image/png' }) });
    await expect(prepareDiagramSource(input)).rejects.toThrow(/10 MiB|超过/);
  });
});
