let csrfToken = '';
export class ApiError extends Error {
  constructor(
    public status: number,
    public data: Record<string, unknown>,
  ) {
    super(String(data.error || '请求失败'));
  }
}
export async function refreshCsrf() {
  const r = await fetch('/api/security/csrf', { cache: 'no-store' });
  if (!r.ok) throw new ApiError(r.status, await r.json());
  csrfToken = (await r.json()).token;
}
export async function api<T = any>(url: string, method = 'GET', body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (method !== 'GET') {
    if (!csrfToken && !url.startsWith('/api/auth/')) await refreshCsrf();
    headers['x-csrf-token'] = csrfToken;
    if (body !== undefined && !(body instanceof FormData))
      headers['Content-Type'] = 'application/json';
  }
  const r = await fetch(url, {
    method,
    headers,
    cache: 'no-store',
    ...(body !== undefined ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}),
  });
  const data = await r.json().catch(() => ({ error: '服务暂时不可用' }));
  if (!r.ok) {
    if (r.status === 401 && !url.startsWith('/api/auth/'))
      window.dispatchEvent(new Event('dooknow-session-expired'));
    throw new ApiError(r.status, data);
  }
  return data;
}
export function resetCsrf() {
  csrfToken = '';
}
