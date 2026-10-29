export class BridgeError extends Error {
  requiredScope?: string;
  currentModifiedAt?: string;
  issues?: SafeIssue[];
  recovery?: Recovery;
  tool?: string;
  constructor(
    public code: string,
    public status = 400,
    public retryable = false,
    public requestId?: string,
    message = code,
  ) {
    super(message);
  }
}

const tools = ['search', 'fetch', 'search_notes', 'get_note_info', 'get_note_outline', 'read_note', 'list_notes', 'create_note', 'update_note', 'patch_note', 'archive_note', 'refresh_index', 'index_status', 'get_blog_status', 'publish_blog_post', 'unpublish_blog_post', 'operation_status', 'cancel_operation', 'query_to_doos', 'get_to_doo_context', 'create_to_doo_task', 'update_to_doo_task', 'set_to_doo_status', 'batch_to_doos', 'preview_to_doo_plan', 'apply_to_doo_plan', 'manage_to_doo'] as const;
const scopes = ['knowledge:read', 'knowledge:write', 'knowledge:index', 'blog:publish', 'to-doo:read', 'to-doo:write'] as const;
const fields = ['query', 'mode', 'freshness', 'filters', 'directory', 'category', 'tags', 'updatedAfter', 'limit', 'cursor', 'id', 'noteId', 'snapshotId', 'maxBytes', 'range', 'startLine', 'endLine', 'lineByteOffset', 'fileName', 'content', 'requestId', 'expectedModifiedAt', 'expectedContentHash', 'edits', 'type', 'before', 'after', 'startByte', 'endByte', 'expectedRangeHash', 'insert', 'scope', 'jobId', 'expectedPublicationVersion', 'metadata', 'slug', 'title', 'summary', 'pinned', 'cover', 'operationId'] as const;
const issueMessages = {
  invalid_type: '字段缺失或类型不正确',
  too_big: '超过字段允许的上限',
  too_small: '未达到字段要求的下限',
  invalid_format: '字段格式不正确',
  invalid_value: '字段值不符合契约',
  invalid_union: '字段不符合任一允许的结构',
  unrecognized_keys: '请求包含契约未声明的字段',
  not_multiple_of: '字段数值不符合要求',
  invalid_key: '字段键不符合契约',
  invalid_element: '字段元素不符合契约',
  custom: '字段组合、范围或预算不符合契约',
} as const;
type SafeIssue = { code: keyof typeof issueMessages; path: (string | number)[]; message: string };
type Issue = { code: string; path: readonly PropertyKey[]; message?: string };
const actions = ['fix_input', 'request_authorization', 'check_operation', 'read_and_merge', 'review_publication', 'restart_read', 'refine_patch', 'wait_and_retry'] as const;
const requestIdPolicies = ['preserve', 'new_after_review', 'not_applicable'] as const;
type Recovery = { action: typeof actions[number]; tool?: typeof tools[number]; requestIdPolicy: typeof requestIdPolicies[number]; message: string };
const safeTool = (value: unknown) => tools.find(tool => tool === value);
const safeRequestId = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\x00-\x1f]/.test(value) ? value : undefined;
const safeVersion = (value: unknown) => typeof value === 'string' && /^\d{1,30}$/.test(value) ? value : undefined;
function safeIssues(issues: readonly Issue[]): SafeIssue[] {
  return issues.slice(0, 8).map(issue => {
    const code = Object.hasOwn(issueMessages, issue.code) ? issue.code as keyof typeof issueMessages : 'invalid_value';
    const path = issue.path.length <= 8 && issue.path.every(key => typeof key === 'number' ? Number.isInteger(key) && key >= 0 && key <= 1000 : fields.some(field => field === key)) ? [...issue.path] as (string | number)[] : [];
    return { code, path, message: issueMessages[code] };
  });
}
function recoveryFor(code: string, tool?: typeof tools[number]): Recovery | undefined {
  if (code === 'INVALID_INPUT') return { action: 'fix_input', ...(tool ? { tool } : {}), requestIdPolicy: 'not_applicable', message: '根据字段问题核对工具契约后修正参数，不要改变原业务意图。' };
  if (code === 'INSUFFICIENT_SCOPE' || code === 'FORBIDDEN') return { action: 'request_authorization', requestIdPolicy: 'not_applicable', message: '核对当前客户端权限和允许访问的目录；工具可见不代表有权调用。' };
  if (code === 'OPERATION_OUTCOME_UNKNOWN') return { action: 'check_operation', tool: 'operation_status', requestIdPolicy: 'preserve', message: '使用原 requestId 查询 operation_status；仅可重试完全相同的原请求，不得生成新 ID。' };
  if (code === 'VERSION_CONFLICT' && (tool === 'publish_blog_post' || tool === 'unpublish_blog_post')) return {
    action: 'review_publication', tool: 'get_blog_status', requestIdPolicy: 'new_after_review',
    message: tool === 'publish_blog_post'
      ? '先查看最新发布版本和原文状态，复核原发布意图；原文变化时读取并审阅最新正文，确认公开内容后使用新的 requestId，不能只替换版本号重试。'
      : '先查看最新发布版本和原文状态，复核原撤下意图；确认仍要撤下当前文章后使用新的 requestId，不能只替换版本号重试。',
  };
  if (code === 'VERSION_CONFLICT' || code === 'RANGE_HASH_CONFLICT') return { action: 'read_and_merge', tool: 'read_note', requestIdPolicy: 'new_after_review', message: '读取新版本正文，保留并合并草稿后核对变更；新操作使用新的 requestId，不能只替换时间戳重试。' };
  if (code === 'IDEMPOTENCY_CONFLICT') return { action: 'check_operation', tool: 'operation_status', requestIdPolicy: 'new_after_review', message: '先按原 requestId 核对原操作结果；确认不同的新操作后使用新的 requestId，不得覆盖原操作。' };
  if (code === 'PATCH_NOT_UNIQUE' || code === 'PATCH_NOT_FOUND') return { action: 'refine_patch', tool: 'read_note', requestIdPolicy: 'new_after_review', message: '重新读取目标范围，核对唯一旧文本或范围哈希；调整后的新操作使用新的 requestId。' };
  if (code === 'LARGE_FILE_MODE_REQUIRED') return { action: 'read_and_merge', tool: 'read_note', requestIdPolicy: 'new_after_review', message: '读取版本快照并核对草稿后使用 patch_note 局部修改；新操作使用新的 requestId。' };
  if (['RESULT_STALE', 'CURSOR_EXPIRED', 'STALE_CURSOR', 'INVALID_CURSOR', 'SNAPSHOT_NOT_FOUND', 'SNAPSHOT_STALE'].includes(code)) return { action: 'restart_read', tool: tool === 'fetch' ? 'search' : tool && ['list_notes', 'search_notes', 'get_note_outline'].includes(tool) ? tool : 'read_note', requestIdPolicy: 'not_applicable', message: '重新发起对应搜索、列表或快照读取；丢弃旧对象标识或游标，不混用不同版本的内容。' };
  if (['READ_RATE_LIMIT', 'READ_RATE_EXCEEDED', 'READ_CONCURRENCY_LIMIT', 'READ_CONCURRENCY_EXCEEDED'].includes(code)) return { action: 'wait_and_retry', ...(tool ? { tool } : {}), requestIdPolicy: 'not_applicable', message: '降低读取并发并等待预算恢复后重试；不要自动遍历剩余内容。' };
}

export function invalidInput(tool: string, issues: readonly Issue[]): BridgeError {
  const error = new BridgeError('INVALID_INPUT', 400);
  error.issues = safeIssues(issues);
  return annotateError(error, tool, undefined);
}

export function annotateError(error: unknown, tool: string, input: unknown): BridgeError {
  const original = error instanceof BridgeError ? error : new BridgeError('INTERNAL_ERROR', 500);
  const knownTool = safeTool(tool) ?? safeTool(original.tool);
  const requestId = safeRequestId(original.requestId) ?? (knownTool && input && typeof input === 'object' ? safeRequestId((input as Record<string, unknown>).requestId) : undefined);
  const result = new BridgeError(original.code, original.status, original.retryable, requestId);
  result.tool = knownTool;
  result.requiredScope = scopes.find(scope => scope === original.requiredScope);
  result.currentModifiedAt = safeVersion(original.currentModifiedAt);
  if (original.issues) result.issues = safeIssues(original.issues);
  result.recovery = recoveryFor(original.code, knownTool);
  return result;
}

export const bridgeErrorSchema = {
  type: 'object', additionalProperties: false, required: ['error'],
  properties: { error: {
    type: 'object', additionalProperties: false, required: ['code', 'message', 'retryable'],
    properties: {
      code: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,63}$' },
      message: { type: 'string', maxLength: 512 }, retryable: { type: 'boolean' },
      requestId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[^\\x00-\\x1f]+$' },
      requiredScope: { type: 'string', enum: [...scopes] },
      currentModifiedAt: { type: 'string', pattern: '^\\d{1,30}$' },
      issues: { type: 'array', maxItems: 8, items: {
        type: 'object', additionalProperties: false, required: ['code', 'path', 'message'],
        properties: {
          code: { type: 'string', enum: Object.keys(issueMessages) },
          path: { type: 'array', maxItems: 8, items: { anyOf: [{ type: 'string', enum: [...fields] }, { type: 'integer', minimum: 0, maximum: 1000 }] } },
          message: { type: 'string', maxLength: 128 },
        },
      } },
      recovery: {
        type: 'object', additionalProperties: false, required: ['action', 'requestIdPolicy', 'message'],
        properties: { action: { type: 'string', enum: [...actions] }, tool: { type: 'string', enum: [...tools] }, requestIdPolicy: { type: 'string', enum: [...requestIdPolicies] }, message: { type: 'string', maxLength: 256 } },
      },
    },
  } },
};

const messages: Record<string, string> = {
  UNAUTHORIZED: "需要有效且未撤销的访问令牌",
  INSUFFICIENT_SCOPE: "调用身份缺少所需权限",
  FORBIDDEN: "无权访问此资源",
  INVALID_INPUT: "参数不符合操作契约",
  INVALID_BACKEND_RESPONSE: "后端返回不符合约定的结果",
  REQUEST_TOO_LARGE: "完整请求超过128KiB预算",
  RESPONSE_TOO_LARGE: "完整响应超过64KiB预算",
  LARGE_FILE_MODE_REQUIRED: "大文件必须使用版本绑定的局部patch",
  OPERATION_OUTCOME_UNKNOWN: "使用原requestId查询操作结果；不能生成新ID重试",
  VERSION_CONFLICT: "笔记版本已变化，请保留草稿并重新核对",
  RESULT_STALE: "研究对象的版本、授权或有效期已变化",
  BACKEND_UNAVAILABLE: "后端暂时不可用",
  READ_RATE_LIMIT: "每分钟读取预算已用完",
  READ_CONCURRENCY_LIMIT: "同一调用身份最多两个并发读取",
  READ_RATE_EXCEEDED: "每分钟读取预算已用完",
  READ_CONCURRENCY_EXCEEDED: "同一调用身份最多两个并发读取",
  READ_BUDGET_EXCEEDED: "当前读取会话的页数或字节预算已用完",
  CURSOR_EXPIRED: "游标或读取快照已过期",
  STALE_CURSOR: "游标对应的原文版本已变化",
  INVALID_CURSOR: "游标无效或不适用于本次读取",
  PATCH_NOT_UNIQUE: "待替换文本在快照中出现多次",
  PATCH_NOT_FOUND: "快照中没有找到待替换文本",
  RANGE_HASH_CONFLICT: "目标范围与预期哈希不一致",
  IDEMPOTENCY_CONFLICT: "同一请求标识已用于不同的操作参数",
  COMPRESSED_REQUEST_NOT_ALLOWED: "请求不能使用内容压缩",
  CALL_CANCELLED: "调用已取消",
};
export function errorBody(error: unknown) {
  const e = annotateError(error, '', undefined);
  const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(e.code) ? e.code : "BACKEND_ERROR";
  return {
    error: {
      code,
      message: code === 'VERSION_CONFLICT' && (e.tool === 'publish_blog_post' || e.tool === 'unpublish_blog_post')
        ? '原文或博客发布版本已变化，请核对当前状态与原操作意图'
        : messages[code] ?? code,
      retryable: e.retryable,
      ...(e.requestId ? { requestId: e.requestId } : {}),
      ...(e.requiredScope ? { requiredScope: e.requiredScope } : {}),
      ...(e.currentModifiedAt ? { currentModifiedAt: e.currentModifiedAt } : {}),
      ...(e.issues ? { issues: e.issues } : {}),
      ...(e.recovery ? { recovery: e.recovery } : {}),
    },
  };
}
