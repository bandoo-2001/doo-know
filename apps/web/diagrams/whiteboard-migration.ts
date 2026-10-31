import { api } from '../api';
import type { WhiteboardMigration } from '../../../shared/whiteboard-migration';
import { renderPrimaryPng } from './primary-api';
import { hashDiagramSource } from './preview-artifact';
/** Every restart reads the fixed server plan; no IndexedDB draft can replace final source bytes. */
export async function continueWhiteboardMigration(
  job: WhiteboardMigration,
): Promise<WhiteboardMigration> {
  job = await api<WhiteboardMigration>('/api/whiteboard-migrations/' + encodeURIComponent(job.id));
  if (['committing', 'committed', 'references_pending', 'rolling_back'].includes(job.status))
    return api('/api/whiteboard-migrations/' + encodeURIComponent(job.id) + '/resume', 'POST', {});
  if (job.status === 'awaiting-native-previews')
    throw Error('关联白板中的原生链接需要更新预览，迁移尚未切换。');
  if (job.status === 'planned') {
    if ((await hashDiagramSource(job.source)) !== job.sourceHash)
      throw Error('迁移源文件摘要不匹配，请重新预检');
    const png = await renderPrimaryPng('whiteboard', {
      source: job.source,
      title: job.title,
      markdown: job.markdown || '',
    });
    const bytes = new Uint8Array(await png.arrayBuffer());
    let binary = '';
    for (let from = 0; from < bytes.length; from += 8192)
      binary += String.fromCharCode(...bytes.subarray(from, from + 8192));
    job = await api<WhiteboardMigration>('/api/whiteboard-migrations/prepare', 'POST', {
      migrationId: job.id,
      sourceHash: job.sourceHash,
      pngBase64: btoa(binary),
      requestId: 'migration-preview-' + job.id,
    });
  }
  if (job.status === 'prepared')
    return api('/api/whiteboard-migrations/commit', 'POST', {
      migrationId: job.id,
      requestId: 'migration-commit-' + job.id,
    });
  return job;
}
