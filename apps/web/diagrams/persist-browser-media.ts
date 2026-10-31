import { markdownDestinationSpans } from '../../../shared/markdown-destinations';
import { portableResourceLimits } from '../../../shared/portable-resource-limits';
import { MEDIA_MIMES } from '../../../shared/media';
import { api } from '../api';
const extensions: Record<string, string> = Object.fromEntries(
  Object.entries({
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    ...MEDIA_MIMES,
  }).map(([ext, mime]) => [mime, ext]),
);
/** Browser-owned blob URLs can only be materialized by their owning browser session. */
export async function persistBrowserMedia(noteId: string, markdown: string) {
  const spans = markdownDestinationSpans(markdown).filter((span) => /^blob:/i.test(span.url));
  const uploads = new Map<string, string>();
  for (const span of spans) {
    if (uploads.has(span.url)) continue;
    let response: Response;
    try {
      response = await fetch(span.url, {
        credentials: 'omit',
        signal: AbortSignal.timeout(portableResourceLimits.resourceTimeoutMs),
      });
    } catch {
      throw Error('临时媒体已失效，请重新选择文件上传后再导出');
    }
    if (!response.ok) throw Error('临时媒体无法读取，请重新选择文件上传');
    const declaredSize = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredSize) && declaredSize > portableResourceLimits.mediaBytes)
      throw Error('临时媒体超过附件配额');
    const blob = await response.blob(),
      extension = extensions[blob.type];
    if (!extension) throw Error('临时媒体类型不受支持，请选择 MP4、WebM、MP3、WAV 或已有附件类型');
    const limit = MEDIA_MIMES[extension]
      ? portableResourceLimits.mediaBytes
      : portableResourceLimits.attachmentBytes;
    if (blob.size > limit) throw Error('临时媒体超过附件配额');
    const data = new FormData();
    data.append('file', blob, 'media' + extension);
    const uploaded = await api<{ markdownPath: string }>(
      `/api/notes/${noteId}/assets`,
      'POST',
      data,
      { uploadRequestId: crypto.randomUUID(), timeoutMs: 180000 },
    );
    uploads.set(span.url, uploaded.markdownPath);
  }
  for (const span of spans.sort((a, b) => b.start - a.start))
    markdown = markdown.slice(0, span.start) + uploads.get(span.url)! + markdown.slice(span.end);
  return markdown;
}
