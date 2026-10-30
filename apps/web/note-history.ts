import type {
  FileOperation,
  FileReply,
  ReadInput,
  ReadPage,
} from '../../shared/knowledge-contracts';

export type HistoryApi = <T = unknown>(url: string, method?: string, body?: unknown) => Promise<T>;

export type NoteRevision = {
  id: string;
  createdAt: string;
  modifiedAt: string;
  sizeBytes: number;
};

export const HISTORY_COMPARE_MAX_BYTES = 1024 * 1024;
export const HISTORY_READ_SESSION_MAX_PAGES = 200;
const PATCH_MAX_BYTES = 256 * 1024;
const SNAPSHOT_MAX_ATTEMPTS = 60;
const utf8 = new TextEncoder();

/** A Git write may briefly retain the workspace lease after its reply. */
export async function readRevisionList(
  call: HistoryApi,
  noteId: string,
  cursor?: string,
  active: () => boolean = () => true,
): Promise<{ items: NoteRevision[]; nextCursor?: string } | undefined> {
  const url =
    `/api/notes/${encodeURIComponent(noteId)}/revisions` +
    (cursor ? `?cursor=${encodeURIComponent(cursor)}` : '');
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!active()) return;
    try {
      const result = await call<{ items: NoteRevision[]; nextCursor?: string }>(url, 'GET');
      return active() ? result : undefined;
    } catch (cause) {
      if (!active()) return;
      const error = cause as { status?: number; data?: { code?: string; retryable?: boolean } };
      if (
        attempt === 2 ||
        error?.status !== 503 ||
        error.data?.code !== 'WORKSPACE_BUSY' ||
        error.data.retryable !== true
      )
        throw cause;
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
  }
}

/** Continue in the same snapshot after the server's per-session page allowance is exhausted. */
export function nextRevisionReadInput(
  page: ReadPage,
  pagesInSession: number,
): ReadInput | undefined {
  if (!page.hasMore) return;
  const maxBytes = 128 * 1024;
  if (pagesInSession < HISTORY_READ_SESSION_MAX_PAGES) {
    if (!page.nextCursor) throw new Error('历史版本分页游标缺失，请重试');
    return { cursor: page.nextCursor, maxBytes };
  }
  const lastNewline = page.content.lastIndexOf('\n');
  const lineByteOffset =
    lastNewline < 0
      ? page.lineByteOffset + utf8.encode(page.content).byteLength
      : utf8.encode(page.content.slice(lastNewline + 1)).byteLength;
  return {
    snapshotId: page.snapshotId,
    maxBytes,
    range: {
      startLine: page.endLine + (page.content.endsWith('\n') ? 1 : 0),
      lineByteOffset,
    },
  };
}

function snapshotError(operation: FileOperation): Error {
  if (operation.status === 'cancelled') return new Error('历史版本准备已取消，请重试');
  if (operation.status === 'needs_reconciliation')
    return new Error('历史版本准备需要核对恢复状态，请稍后重试');
  return new Error('历史版本准备失败，请重试');
}

/** Read one immutable page, preserving the same request across snapshot preparation. */
export async function readRevisionPage(
  call: HistoryApi,
  noteId: string,
  revisionId: string,
  input: ReadInput = {},
  active: () => boolean = () => true,
): Promise<ReadPage | undefined> {
  const url = `/api/notes/${encodeURIComponent(noteId)}/revisions/${encodeURIComponent(revisionId)}/read`;
  let polls = 0;
  for (let attempt = 0; attempt < SNAPSHOT_MAX_ATTEMPTS; attempt++) {
    if (!active()) return;
    const reply = await call<FileReply<ReadPage>>(url, 'POST', input);
    if (!active()) return;
    if (reply.kind === 'ready') return reply.data;
    let operation = reply.operation;
    while (['queued', 'running', 'committing'].includes(operation.status)) {
      if (polls >= SNAPSHOT_MAX_ATTEMPTS) throw new Error('历史版本准备超时，请重试');
      await new Promise<void>((resolve) => setTimeout(resolve, 1000));
      if (!active()) return;
      operation = await call<FileOperation>(
        `/api/operations/${encodeURIComponent(operation.operationId)}`,
        'GET',
      );
      polls++;
      if (!active()) return;
    }
    if (operation.status !== 'succeeded') throw snapshotError(operation);
  }
  throw new Error('历史版本准备超时，请重试');
}

type RevisionDiff = {
  status: 'ready' | 'empty' | 'too-large' | 'too-complex';
  diff: string;
};

/** Generate only complete patches; aborted and oversized comparisons carry no partial text. */
export async function createRevisionDiff(previous: string, current: string): Promise<RevisionDiff> {
  if (
    utf8.encode(previous).byteLength > HISTORY_COMPARE_MAX_BYTES ||
    utf8.encode(current).byteLength > HISTORY_COMPARE_MAX_BYTES
  )
    return { status: 'too-large', diff: '' };
  if (previous === current) return { status: 'empty', diff: '' };

  const { createTwoFilesPatch } = await import('diff');
  const patch = await new Promise<string | undefined>((resolve) => {
    createTwoFilesPatch('note.md', 'note.md', previous, current, '历史版本', '当前已保存版本', {
      context: 3,
      timeout: 250,
      maxEditLength: 10_000,
      callback: resolve,
    });
  });
  if (patch === undefined) return { status: 'too-complex', diff: '' };
  if (utf8.encode(patch).byteLength > PATCH_MAX_BYTES) return { status: 'too-large', diff: '' };
  return { status: 'ready', diff: patch };
}
