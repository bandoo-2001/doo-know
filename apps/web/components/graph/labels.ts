export const graphLabels: Record<string, string> = {
  note: '笔记',
  concept: '概念',
  person: '人物',
  organization: '组织',
  place: '地点',
  event: '事件',
  technology: '技术',
  reference: '引用',
  mentions: '提及',
  cooccurs: '词项共现',
  similarity: '词项相似',
  semantic: '模型关系',
  manual: '人工关系',
};
export const graphReviewStatusLabels: Record<string, string> = {
  suggested: '待审核',
  accepted: '已确认',
  manual: '人工添加',
};
export function graphTaskErrorLabel(code: string): string {
  return (
    (
      {
        MODEL_EXTRACTION_FAILED: '模型分析未完成，可检查连接后重试',
        PARTIAL_SOURCE_LIMIT: '内容较长，目前只分析了部分原文',
        SOURCE_UNAVAILABLE: '暂时无法读取原文',
        SOURCE_TOO_LARGE: '原文超过可分析大小',
        UNSAFE_SOURCE: '原文暂时无法安全读取',
        SOURCE_CHANGED: '原文已更新，等待重新分析',
        ANALYSIS_CANCELED: '分析已取消',
      } as Record<string, string>
    )[code] || '分析暂未完成，可稍后重试'
  );
}
