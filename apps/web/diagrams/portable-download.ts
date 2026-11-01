import { withPortablePreviews } from './portable-previews';
import { api } from '../api';
/** Download the frozen delivery named by the server; Markdown and archives retain their real formats. */
export async function downloadPortableDocument(noteId: string) {
  const requestId = crypto.randomUUID();
  const result = await withPortablePreviews(() =>
    api<{
      fileName: string;
      downloadUrl: string;
      kind: 'markdown' | 'archive';
      mime: string;
    }>('/api/portable-deliveries', 'POST', {
      selection: { kind: 'single', noteId },
      requestId,
    }),
  );
  const response = await fetch(result.downloadUrl, {
    cache: 'no-store',
    credentials: 'same-origin',
    redirect: 'error',
    signal: AbortSignal.timeout(180000),
  });
  if (!response.ok) throw Error('便携导出文件未能下载，请重试');
  const { downloadBlob } = await import('../whiteboards/download');
  downloadBlob(await response.blob(), result.fileName);
}
