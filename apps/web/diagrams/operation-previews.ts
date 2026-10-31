import { api } from '../api';
import type { FixedDiagramSnapshot } from '../../../packages/core/knowledge/diagram-operation-previews';
import { renderPrimaryPng } from './primary-api';
import { prepareDiagramSource } from './prepare-source';
/** Render only server-fixed final source. Callers retry the same operation identity afterward. */
export async function prepareOperationPreviews(value: unknown): Promise<boolean> {
  const data = (value as any)?.data ?? value,
    details = data?.previewRequired ?? data?.details ?? data;
  if (
    data?.code !== 'DIAGRAM_PREVIEW_REQUIRED' &&
    !data?.previewRequired &&
    !details?.documents?.some((d: any) => d.snapshotId)
  )
    return false;
  const documents = [...(details.documents ?? [])];
  let nextCursor = details.nextCursor;
  while (nextCursor) {
    if (typeof details.operationId !== 'string') throw Error('操作计划分页标识缺失');
    const page = await api<{ documents: unknown[]; nextCursor?: string }>(
      '/api/document-operation-previews/needs?operationId=' +
        encodeURIComponent(details.operationId) +
        '&cursor=' +
        encodeURIComponent(nextCursor),
    );
    documents.push(...page.documents);
    nextCursor = page.nextCursor;
  }
  const ids = [...new Set<string>(documents.map((d: any) => d.snapshotId).filter(Boolean))];
  if (!ids.length) return false;
  for (const id of ids) {
    const snapshot = await api<FixedDiagramSnapshot>(
      '/api/diagram-operation-previews/' + encodeURIComponent(id),
    );
    const fixed = snapshot.input;
    const png =
      fixed.kind === 'svg'
        ? (await prepareDiagramSource({ kind: 'svg', code: snapshot.source })).png
        : await renderPrimaryPng(fixed.type, {
            markdown: '',
            source: snapshot.source,
            title: fixed.title,
          });
    const bytes = new Uint8Array(await png.arrayBuffer());
    let binary = '';
    for (let from = 0; from < bytes.length; from += 8192)
      binary += String.fromCharCode(...bytes.subarray(from, from + 8192));
    await api('/api/diagram-operation-previews/' + encodeURIComponent(id) + '/prepare', 'POST', {
      sourceHash: snapshot.sourceHash,
      pngBase64: btoa(binary),
      requestId: 'operation-preview-' + id,
    });
  }
  return true;
}
export async function withOperationPreviews<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (await prepareOperationPreviews(error)) return operation();
    throw error;
  }
}

export async function completeOrganizationOperation(operationId: string) {
  for (let attempt = 0; attempt < 1200; attempt++) {
    const operation = await api<
      import('../../../shared/organization-contracts').OrganizationOperation
    >('/api/organization/operations/' + encodeURIComponent(operationId));
    if (operation.status === 'succeeded') return operation;
    if (operation.status === 'awaiting_preview') {
      if (!(await prepareOperationPreviews(operation))) throw Error('操作计划缺少图形准备信息');
      await api(
        '/api/organization/operations/' + encodeURIComponent(operationId) + '/resume',
        'POST',
        {},
      );
    } else if (['failed', 'cancelled', 'needs_reconciliation'].includes(operation.status))
      throw Error(operation.error?.code ?? '文件操作未完成');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error('操作仍在处理中，请从操作记录继续核对');
}
