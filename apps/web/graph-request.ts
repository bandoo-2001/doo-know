import { api } from './api';

/** getRandomValues also works in HTTP previews where randomUUID is unavailable. */
export function graphRequestId(): string {
  const browser = globalThis.crypto;
  if (typeof browser?.randomUUID === 'function') return browser.randomUUID();
  if (typeof browser?.getRandomValues !== 'function')
    throw Error('当前浏览器无法生成安全请求标识，请更换浏览器后重试');
  const bytes = browser.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Model calls have their own bounded server deadline; keep ordinary API requests at 15s. */
export const graphApi: typeof api = (url, method, body, options = {}) =>
  api(url, method, body, {
    ...options,
    ...(/^\/api\/graph\/(?:ask|settings\/test)(?:\?|$)/.test(url) ? { timeoutMs: 135000 } : {}),
  });
