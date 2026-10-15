export class BridgeError extends Error {
  requiredScope?: string;
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
  COMPRESSED_REQUEST_NOT_ALLOWED: "请求不能使用内容压缩",
  CALL_CANCELLED: "调用已取消",
};
export function errorBody(error: unknown) {
  const e =
    error instanceof BridgeError
      ? error
      : new BridgeError("INTERNAL_ERROR", 500);
  const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(e.code) ? e.code : "BACKEND_ERROR";
  return {
    error: {
      code,
      message: messages[code] ?? code,
      retryable: e.retryable,
      ...(e.requestId ? { requestId: e.requestId } : {}),
    },
  };
}
