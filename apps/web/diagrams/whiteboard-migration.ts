import { prepareOperationPreviews } from './operation-previews';
import { api } from '../api';
import type { WhiteboardMigration } from '../../../shared/whiteboard-migration';
import { renderPrimaryPng } from './primary-api';
import { hashDiagramSource } from './preview-artifact';
async function encodePng(png: Blob) {
  const bytes = new Uint8Array(await png.arrayBuffer());
  let binary = '';
  for (let from = 0; from < bytes.length; from += 8192)
    binary += String.fromCharCode(...bytes.subarray(from, from + 8192));
  return btoa(binary);
}
/** Reopening reads fixed server snapshots; every source is rendered before any target cutover. */
export async function continueWhiteboardMigration(
  job: WhiteboardMigration,
): Promise<WhiteboardMigration> {
  job = await api<WhiteboardMigration>('/api/whiteboard-migrations/' + encodeURIComponent(job.id));
  for (let round = 0; round < 12; round++) {
    if (['committing', 'committed', 'references_pending', 'rolling_back'].includes(job.status))
      return api(
        '/api/whiteboard-migrations/' + encodeURIComponent(job.id) + '/resume',
        'POST',
        {},
      );
    if (!['planned', 'prepared', 'awaiting-native-previews'].includes(job.status)) return job;
    job = await api<WhiteboardMigration>(
      '/api/whiteboard-migrations/' + encodeURIComponent(job.id) + '/resume',
      'POST',
      {},
    );
    if (job.nativePreviewNeeds?.length) {
      await prepareOperationPreviews({
        code: 'DIAGRAM_PREVIEW_REQUIRED',
        details: { documents: job.nativePreviewNeeds },
      });
      continue;
    }
    if (job.status === 'planned') {
      if ((await hashDiagramSource(job.source)) !== job.sourceHash)
        throw Error('迁移源文件摘要不匹配，请重新预检');
      const png = await renderPrimaryPng('whiteboard', {
        source: job.source,
        title: job.title,
        markdown: job.markdown || '',
      });
      job = await api<WhiteboardMigration>('/api/whiteboard-migrations/prepare', 'POST', {
        migrationId: job.id,
        sourceHash: job.sourceHash,
        pngBase64: await encodePng(png),
        requestId: 'migration-preview-' + job.id,
      });
    }
    if (job.status === 'prepared') {
      job = await api<WhiteboardMigration>('/api/whiteboard-migrations/commit', 'POST', {
        migrationId: job.id,
        requestId: 'migration-commit-' + job.id,
      });
      if (job.status !== 'awaiting-native-previews') return job;
    }
  }
  throw Error('迁移关联仍在变化，进度已保存，请刷新后续跑');
}
