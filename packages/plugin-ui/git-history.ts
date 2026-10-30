import { ref } from 'vue';

export interface GitHistoryCall {
  <T = any>(kind: 'command' | 'provider', id: string, input: unknown): Promise<T>;
}

export interface GitHistoryEntry {
  commit: string;
  at: string;
  author: string;
  message: string;
}

export const gitRestoreMessages: Record<string, string> = {
  GIT_RESTORE_UNSUPPORTED:
    '当前笔记不支持 Git 恢复：仅支持不超过 1 MiB 的 Markdown 笔记，元数据模式不可恢复。仍可查看历史和差异。',
  GIT_RESTORE_VERSION_TOO_LARGE:
    '所选历史版本超过 1 MiB，无法在页面恢复。仍可查看历史和差异；请部署者在服务器导出该版本，保留当前笔记后再处理。',
  GIT_VERSION_NOT_FOUND:
    '所选版本中没有可恢复的此笔记文件，仍可查看历史和删除差异。请选择其他版本。',
  GIT_OUTPUT_TOO_LARGE:
    '所选历史版本超出恢复读取限制，无法在页面恢复。请部署者在服务器导出该版本，保留当前笔记后再处理。',
  LARGE_FILE_MODE_REQUIRED:
    '当前笔记需要大文件模式，无法使用此 Git 恢复操作。仍可查看历史和差异；请部署者在服务器导出所选版本，保留当前笔记后再处理。',
};

interface GitHistoryContext {
  noteId: string;
  expectedModifiedAt?: string;
}

interface PendingGitRestore {
  noteId: string;
  commit: string;
  expectedModifiedAt: string;
  requestId: string;
}

interface GitHistoryOptions {
  call: GitHistoryCall;
  context(): GitHistoryContext;
  onRestored?(noteId: string): void | Promise<void>;
  friendlyError?(cause: unknown): string;
}

function defaultFriendlyError(cause: unknown): string {
  const response = cause as any;
  const code = response?.data?.code || response?.data?.error?.code || response?.code;
  if (code === 'VERSION_CONFLICT') return '文件已更新，请保留草稿后重新核对';
  if (code === 'WORKSPACE_BUSY') return '工作区正在写入，请稍后重试';
  return response?.message || code || String(cause);
}

/** Browser state shared by the native history dialog and the legacy Git panel. */
export function createGitHistoryModel(options: GitHistoryOptions) {
  const rows = ref<GitHistoryEntry[]>([]),
    cursor = ref<string>(),
    diff = ref(''),
    diffTruncated = ref(false),
    diffCommit = ref<string>(),
    diffLoading = ref(false),
    error = ref(''),
    selected = ref<string>(),
    confirmRestore = ref(false),
    restoreNeedsReload = ref(false),
    restoreBlockedCode = ref(''),
    busy = ref(false),
    pendingRestore = ref<PendingGitRestore>(),
    loading = ref(false);
  let disposed = false,
    generation = 0,
    listRequest = 0,
    diffRequest = 0;
  let diffContext: GitHistoryContext | undefined;
  const friendly = options.friendlyError || defaultFriendlyError;
  const snapshot = () => ({ ...options.context(), generation });
  const isCurrent = (context: GitHistoryContext & { generation: number }) => {
    const current = options.context();
    return (
      !disposed &&
      context.generation === generation &&
      context.noteId === current.noteId &&
      context.expectedModifiedAt === current.expectedModifiedAt
    );
  };

  async function load(next = false): Promise<void> {
    if (disposed || (next && (!cursor.value || loading.value))) return;
    const context = snapshot(),
      request = ++listRequest;
    loading.value = true;
    error.value = '';
    try {
      const result = await options.call<{ items: GitHistoryEntry[]; nextCursor?: string }>(
        'provider',
        'git.history',
        { noteId: context.noteId, ...(next ? { cursor: cursor.value } : {}) },
      );
      if (request !== listRequest || !isCurrent(context)) return;
      rows.value = next ? [...rows.value, ...result.items] : result.items;
      cursor.value = result.nextCursor;
    } catch (cause) {
      if (request === listRequest && isCurrent(context)) error.value = friendly(cause);
    } finally {
      if (request === listRequest && context.generation === generation) loading.value = false;
    }
  }

  async function show(commit: string): Promise<void> {
    if (disposed || busy.value) return;
    if (pendingRestore.value) {
      if (pendingRestore.value.commit !== commit) error.value = '请先核对上一次恢复结果';
      return;
    }
    const context = snapshot(),
      request = ++diffRequest;
    selected.value = commit;
    diffCommit.value = undefined;
    diffContext = undefined;
    restoreBlockedCode.value = '';
    diff.value = '';
    diffTruncated.value = false;
    diffLoading.value = true;
    error.value = '';
    confirmRestore.value = false;
    try {
      const result = await options.call<{
        diff: string;
        truncated?: boolean;
        restore?: { supported: boolean; code?: string };
      }>('provider', 'git.diff', { noteId: context.noteId, commit });
      if (request !== diffRequest || !isCurrent(context)) return;
      diff.value = result.truncated ? '差异超过 256 KiB，请在服务器查看。' : result.diff;
      diffTruncated.value = result.truncated === true;
      restoreBlockedCode.value =
        result.restore?.supported === false ? result.restore.code || 'GIT_RESTORE_UNSUPPORTED' : '';
      diffCommit.value = commit;
      diffContext = context;
    } catch (cause) {
      if (request === diffRequest && isCurrent(context)) error.value = friendly(cause);
    } finally {
      if (request === diffRequest && context.generation === generation) diffLoading.value = false;
    }
  }

  async function restore(): Promise<boolean> {
    if (
      disposed ||
      !confirmRestore.value ||
      busy.value ||
      restoreNeedsReload.value ||
      restoreBlockedCode.value ||
      diffLoading.value ||
      !diffCommit.value ||
      diffCommit.value !== selected.value
    )
      return false;
    const context = snapshot();
    if (!pendingRestore.value) {
      if (
        !context.expectedModifiedAt ||
        !diffContext ||
        diffContext.noteId !== context.noteId ||
        diffContext.expectedModifiedAt !== context.expectedModifiedAt
      ) {
        restoreNeedsReload.value = true;
        confirmRestore.value = false;
        return false;
      }
      pendingRestore.value = {
        noteId: context.noteId,
        commit: diffCommit.value,
        expectedModifiedAt: context.expectedModifiedAt,
        requestId: crypto.randomUUID(),
      };
    }
    const request = pendingRestore.value;
    busy.value = true;
    error.value = '';
    try {
      try {
        await options.call('command', 'git.restore', request);
      } catch (cause) {
        const response = cause as any,
          status = response?.status ?? response?.statusCode,
          data = response?.data || {},
          code = data.code || data.error?.code || response?.code || response?.message,
          retryable = data.retryable || data.error?.retryable || response?.retryable;
        if (gitRestoreMessages[String(code)]) {
          pendingRestore.value = undefined;
          confirmRestore.value = false;
          if (isCurrent(context)) {
            restoreBlockedCode.value = String(code);
            error.value = '';
          }
        } else {
          if (
            status >= 400 &&
            status < 500 &&
            !retryable &&
            !String(code).includes('OUTCOME_UNKNOWN')
          ) {
            pendingRestore.value = undefined;
            confirmRestore.value = false;
            if (isCurrent(context)) restoreNeedsReload.value = true;
          }
          if (isCurrent(context)) error.value = friendly(cause);
        }
        return false;
      }
      // The write is known to have succeeded. A notification/refresh failure cannot
      // turn it into an uncertain write or allow the same confirmation to run again.
      pendingRestore.value = undefined;
      confirmRestore.value = false;
      try {
        await options.onRestored?.(request.noteId);
      } catch (cause) {
        if (isCurrent(context)) error.value = friendly(cause);
      }
      return true;
    } finally {
      busy.value = false;
    }
  }

  function cancelRestore(): void {
    if (busy.value || pendingRestore.value) return;
    confirmRestore.value = false;
  }

  function reset(): void {
    if (disposed) return;
    if (busy.value || pendingRestore.value) {
      error.value = '请先核对上一次恢复结果';
      return;
    }
    generation++;
    listRequest++;
    diffRequest++;
    rows.value = [];
    cursor.value = undefined;
    diff.value = '';
    diffTruncated.value = false;
    diffCommit.value = undefined;
    diffContext = undefined;
    diffLoading.value = false;
    error.value = '';
    selected.value = undefined;
    confirmRestore.value = false;
    restoreNeedsReload.value = false;
    restoreBlockedCode.value = '';
    loading.value = false;
  }

  function dispose(): void {
    disposed = true;
    generation++;
    listRequest++;
    diffRequest++;
    loading.value = false;
    diffLoading.value = false;
  }

  return {
    rows,
    cursor,
    diff,
    diffTruncated,
    diffCommit,
    diffLoading,
    error,
    selected,
    confirmRestore,
    restoreNeedsReload,
    restoreBlockedCode,
    busy,
    pendingRestore,
    loading,
    load,
    show,
    restore,
    cancelRestore,
    reset,
    dispose,
  };
}
