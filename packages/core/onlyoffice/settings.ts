import { privateFile } from '../agent/config.js';

function baseUrl(value: string) {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('invalid base URL');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

export type OfficeSettings = {
  browser: URL;
  internal: URL;
  app: URL;
  secret: Uint8Array;
};

export function officeSettings(
  origin: string,
  env = process.env,
): {
  settings?: OfficeSettings;
  error?: string;
} {
  const browser = env.DOOKNOW_ONLYOFFICE_URL?.trim();
  if (!browser) return {};
  try {
    const value = env.DOOKNOW_ONLYOFFICE_JWT_SECRET_FILE
      ? privateFile(env.DOOKNOW_ONLYOFFICE_JWT_SECRET_FILE, 8192).trimEnd()
      : env.DOOKNOW_ONLYOFFICE_JWT_SECRET;
    if (!value || Buffer.byteLength(value) < 32)
      return { error: '请为 ONLYOFFICE 和 DooKnow 配置相同的 JWT 密钥（至少 32 字节）' };
    return {
      settings: {
        browser: baseUrl(browser),
        internal: baseUrl(env.DOOKNOW_ONLYOFFICE_INTERNAL_URL?.trim() || browser),
        app: baseUrl(env.DOOKNOW_ONLYOFFICE_APP_URL?.trim() || origin),
        secret: Buffer.from(value, 'utf8'),
      },
    };
  } catch {
    return { error: '请核对 ONLYOFFICE 的地址和 JWT 密钥文件配置' };
  }
}
