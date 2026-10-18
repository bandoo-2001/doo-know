export interface IndexOverview {
  pending: number;
  retrying: number;
  failed: number;
  conflicts: number;
  sync: { status: string };
  error?: string | null;
  lastReconciledAt?: string | null;
  documents?: {
    noteId: string;
    relativePath: string;
    sourceHash: string | null;
    textIndexedHash: string | null;
    vectorIndexedHash: string | null;
    conflict: boolean;
  }[];
}
export interface RuntimeOverview {
  components: { tokenizerReady: boolean; vectorReady: boolean };
  distributionAvailable: boolean;
  externallyManaged: boolean;
  task?: {
    id: string;
    state: string;
    phase: string;
    completedBytes: number;
    totalBytes: number;
    error?: string | null;
  };
}
export function searchSummary(components?: RuntimeOverview['components']) {
  if (!components) return '尚未获取搜索能力';
  if (components.tokenizerReady && components.vectorReady) return '关键词与语义搜索可用';
  if (components.tokenizerReady) return '关键词搜索可用，语义搜索待准备';
  if (components.vectorReady) return '语义搜索可用，关键词搜索待准备';
  return '内容搜索待准备，仍可按文件名查找';
}
export function indexSummary(state?: IndexOverview) {
  if (!state) return '尚未获取索引状态';
  if (state.error) return '原文状态需要检查';
  if (state.conflicts) return `${state.conflicts} 项写入冲突需要核对`;
  if (state.failed) return `${state.failed} 项索引需要处理`;
  const pending = state.pending + state.retrying;
  if (pending) return `正在更新搜索 · ${pending} 项待处理`;
  if (state.sync.status === 'needs_reconciliation') return '同步结果需要核对';
  return state.sync.status === 'idle' ? '索引队列已处理' : '正在同步搜索';
}
