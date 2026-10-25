import { ApiError } from './api';
import type {
  PublicShareSource,
  ShareSaveInput,
  ShareSaveReply,
} from '../../shared/share-contracts';
/** Public capabilities use their own signed CSRF exchange, independent of owner sessions. */
async function request<T>(
  token: string,
  suffix: string,
  method = 'GET',
  body?: unknown,
  csrf?: string,
): Promise<T> {
  const response = await fetch(`/api/public/shares/${encodeURIComponent(token)}${suffix}`, {
    method,
    cache: 'no-store',
    credentials: 'same-origin',
    signal: AbortSignal.timeout(15000),
    headers:
      body === undefined ? {} : { 'Content-Type': 'application/json', 'x-csrf-token': csrf || '' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => {
    throw new ApiError(0, { error: '响应未完成，请重试；当前编辑已保留。' });
  });
  if (!response.ok) throw new ApiError(response.status, data);
  return data;
}
export function readPublicShareSource(token: string) {
  return request<PublicShareSource>(token, '/source');
}
export async function savePublicShareSource(token: string, input: ShareSaveInput) {
  const csrf = await request<{ token: string }>(token, '/csrf');
  return request<ShareSaveReply>(token, '/source', 'PUT', input, csrf.token);
}
/** Resolve relative resources only through this capability; never invoke owner asset APIs. */
export function publicShareAsset(token: string, source: string): string | undefined {
  if (
    !source ||
    source.startsWith('/') ||
    source.includes('\\') ||
    source.startsWith('#') ||
    /^[a-z][a-z0-9+.-]*:/i.test(source)
  )
    return;
  return `/api/public/shares/${encodeURIComponent(token)}/asset?source=${encodeURIComponent(source)}`;
}
