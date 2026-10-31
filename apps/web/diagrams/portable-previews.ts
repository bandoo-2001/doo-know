import { api } from '../api';
import type { PortablePreviewNeed } from '../../../shared/portable-delivery-contracts';
import { renderPrimaryPng } from './primary-api';
import { hashDiagramSource } from './preview-artifact';
import { diagramRendererVersions } from '../../../shared/diagram-primary';
/** Fetch and render only the private portable plan's fixed source. Never saves the original note. */
export async function preparePortablePreviews(value: unknown): Promise<boolean> {
  const data = (value as any)?.data ?? value,
    details = data?.details ?? data;
  const needs: PortablePreviewNeed[] = details?.portablePreviews ?? [];
  if (!needs.length) return false;
  for (const need of needs) {
    const fixed = await api<PortablePreviewNeed & { source: string }>(
      '/api/portable-previews/' + encodeURIComponent(need.previewId),
    );
    if ((await hashDiagramSource(fixed.source)) !== fixed.sourceHash)
      throw Error('便携固定源码摘要不匹配，请重新准备。');
    if (fixed.type !== 'whiteboard' || fixed.renderer !== diagramRendererVersions.whiteboard)
      throw Error('便携图形渲染版本不受支持，请刷新页面。');
    const png = await renderPrimaryPng('whiteboard', {
        source: fixed.source,
        title: fixed.title,
        markdown: '',
      }),
      bytes = new Uint8Array(await png.arrayBuffer());
    let binary = '';
    for (let from = 0; from < bytes.length; from += 8192)
      binary += String.fromCharCode(...bytes.subarray(from, from + 8192));
    await api('/api/portable-previews/' + encodeURIComponent(need.previewId) + '/prepare', 'POST', {
      sourceHash: fixed.sourceHash,
      pngBase64: btoa(binary),
      requestId: 'portable-preview-' + need.previewId,
    });
  }
  return true;
}
/** A plan is an intermediate result; only the retried original request can report completion. */
export async function withPortablePreviews<T>(operation: () => Promise<T>): Promise<T> {
  for (let round = 0; round < 12; round++)
    try {
      return await operation();
    } catch (error) {
      if (!(await preparePortablePreviews(error))) throw error;
    }
  throw Error('便携依赖仍在变化，进度已保存，请从原任务继续。');
}
