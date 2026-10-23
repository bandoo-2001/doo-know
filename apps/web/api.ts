import { PASSWORD_POLICY_MESSAGE } from '../../shared/password-policy';

let csrfToken = '';
export class ApiError extends Error {
  constructor(
    public status: number,
    public data: Record<string, unknown>,
  ) {
    super(
      String(
        data.code === 'PASSWORD_TOO_SHORT'
          ? PASSWORD_POLICY_MESSAGE
          : typeof data.error === 'object' && data.error
            ? (data.error as any).message || (data.error as any).code
            : data.error || '请求失败',
      ),
    );
  }
}
export async function refreshCsrf() {
  const r = await fetch('/api/security/csrf', {
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new ApiError(r.status, await r.json());
  csrfToken = (await r.json()).token;
}
export async function api<T = any>(
  url: string,
  method = 'GET',
  body?: unknown,
  options: { notifySessionExpired?: boolean; uploadRequestId?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.uploadRequestId) headers['x-dooknow-upload-id'] = options.uploadRequestId;
  if (method !== 'GET') {
    if (!csrfToken && !url.startsWith('/api/auth/') && !url.startsWith('/api/public/'))
      await refreshCsrf();
    headers['x-csrf-token'] = csrfToken;
    if (body !== undefined && !(body instanceof FormData))
      headers['Content-Type'] = 'application/json';
  }
  const r = await fetch(url, {
    method,
    headers,
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
    ...(body !== undefined ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}),
  });
  const data = await r.json().catch(() => {
    throw new ApiError(0, { error: '响应未完成，请重试；保存操作请先核对结果' });
  });
  if (!r.ok) {
    if (r.status === 401 && !url.startsWith('/api/auth/') && options.notifySessionExpired !== false)
      window.dispatchEvent(new Event('dooknow-session-expired'));
    throw new ApiError(r.status, data);
  }
  return data;
}
export function resetCsrf() {
  csrfToken = '';
}
