import type { AppConfig } from '../../../shared/contracts.js';

export function normalizeAllowedOrigins(origin: string, additional: unknown = []): string[] {
  if (!Array.isArray(additional) || additional.some((value) => typeof value !== 'string'))
    throw new Error('允许访问地址必须为完整来源列表');
  const values = [origin, ...additional] as string[];
  for (const value of values) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error('允许访问地址必须为完整来源，不含路径或通配符');
    }
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.origin !== value ||
      parsed.hostname.includes('*')
    )
      throw new Error('允许访问地址必须为完整来源，不含路径或通配符');
  }
  return [...new Set(values)];
}

export function allowedOrigins(config: Pick<AppConfig, 'origin' | 'allowedOrigins'>): string[] {
  return normalizeAllowedOrigins(config.origin, config.allowedOrigins);
}

export function isAllowedOrigin(
  config: Pick<AppConfig, 'origin' | 'allowedOrigins'>,
  origin: unknown,
): boolean {
  return typeof origin === 'string' && allowedOrigins(config).includes(origin);
}
