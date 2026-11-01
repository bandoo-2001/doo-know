import { api } from '../api';
import type { DraftRecord } from '../drafts';
import type { DocumentSessionState } from './document-session';
import { parseWhiteboard } from '../../../shared/whiteboard';
import { hashDiagramSource } from './preview-artifact';
import type { HistoryApi } from '../note-history';
export function heldDraftDownload(record: DraftRecord) {
  const d = record.diagram;
  if (d) {
    const formats = {
      markdown: '.md',
      excalidraw: '.excalidraw',
      mermaid: '.mmd',
      'markdown-outline': '.outline.md',
    };
    return {
      content: record.content,
      extension:
        d.version === 2 && Object.hasOwn(formats, d.payloadFormat)
          ? formats[d.payloadFormat]
          : '.draft.txt',
    };
  }
  try {
    parseWhiteboard(record.content);
    return { content: record.content, extension: '.excalidraw' };
  } catch {
    return { content: record.content, extension: '.md' };
  }
}
export function isLegacySceneDraft(
  record: DraftRecord,
  state: Pick<DocumentSessionState, 'type' | 'documentHash'>,
) {
  if (state.type !== 'whiteboard' || !state.documentHash || record.kind !== 'note') return false;
  const d = record.diagram;
  if (
    d &&
    (d.version !== 2 ||
      d.documentType !== 'whiteboard' ||
      d.payloadFormat !== 'excalidraw' ||
      d.documentMarkdown !== undefined ||
      d.pending !== undefined)
  )
    return false;
  try {
    parseWhiteboard(record.content);
    return true;
  } catch {
    return false;
  }
}
export async function convertLegacySceneDraft(
  record: DraftRecord,
  state: DocumentSessionState,
  call: HistoryApi = api,
) {
  if (!isLegacySceneDraft(record, state)) throw Error('旧草稿格式无法安全转换，请下载保留');
  const result = await call<{
    source: string;
    sourceHash: string;
    expectedDocumentHash: string;
    expectedSourceHash: string;
  }>(
    '/api/notes/' + encodeURIComponent(state.noteId) + '/diagram/legacy-draft-conversion',
    'POST',
    {
      draft: record.content,
      baseRevision: record.baseRevision,
      expectedDocumentHash: state.documentHash,
      expectedSourceHash: state.sourceHash,
    },
  );
  if (
    result.expectedDocumentHash !== state.documentHash ||
    result.expectedSourceHash !== state.sourceHash
  )
    throw Error('原文版本已变化，旧草稿仍保留');
  if ((await hashDiagramSource(result.source)) !== result.sourceHash)
    throw Error('转换后的草稿摘要不匹配，旧草稿仍保留');
  parseWhiteboard(result.source);
  return { markdown: state.markdown, source: result.source, title: state.title };
}
