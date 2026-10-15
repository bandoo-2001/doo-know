import { createHash, timingSafeEqual } from 'node:crypto';
import type { AppDatabase } from '../../../packages/core/db.js';
import type { HostConfig } from '../../../shared/platform-contracts.js';
import { validateRelative } from '../../../packages/core/files.js';
import { initializeTunnelIdentity } from './tunnel-identity.js';
import { pluginHost } from '../plugins/host.js';
import { readInstance, activeDatabaseProcesses } from './instance.js';
const denied = () => {
  throw Error('旧 Tunnel 凭据、签发时间或授权策略无效；拒绝自动承接');
};
export function legacyTunnelAuthorization(options: {
  bearer: string;
  tokens: unknown;
  bridgePolicies: unknown;
  backendPolicies: unknown;
  notBefore: number;
}) {
  const { bearer } = options,
    records = (options.tokens as any)?.tokens;
  if (
    typeof bearer !== 'string' ||
    bearer.length < 32 ||
    bearer.length > 8192 ||
    /[\r\n]/.test(bearer) ||
    !Array.isArray(records) ||
    records.length > 128
  )
    denied();
  const hash = createHash('sha256').update(bearer).digest();
  const matches = records.filter(
    (record: any) =>
      typeof record?.sha256 === 'string' &&
      /^[a-f0-9]{64}$/.test(record.sha256) &&
      timingSafeEqual(hash, Buffer.from(record.sha256, 'hex')),
  );
  if (matches.length !== 1) denied();
  const record = matches[0],
    now = Math.floor(Date.now() / 1000),
    expiresAt = Math.floor(Date.parse(record.expiresAt) / 1000);
  if (
    record.revoked ||
    !Number.isInteger(record.issuedAt) ||
    record.issuedAt <= 0 ||
    record.issuedAt > now + 5 ||
    record.issuedAt <= options.notBefore ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= now ||
    typeof record.id !== 'string' ||
    !record.id ||
    record.id.length > 256 ||
    typeof record.clientId !== 'string' ||
    !record.clientId ||
    record.clientId.length > 256
  )
    denied();
  function policy(input: unknown) {
    if (!Array.isArray(input) || input.length > 128) denied();
    const found = (input as any[]).filter(
      (p) => p?.id === record.id && p?.clientId === record.clientId,
    );
    if (found.length !== 1) denied();
    const p = found[0];
    if (
      !Array.isArray(p.scopes) ||
      !p.scopes.length ||
      p.scopes.some(
        (s: unknown) =>
          !['knowledge:read', 'knowledge:write', 'knowledge:index'].includes(s as string),
      ) ||
      !Array.isArray(p.allowedPrefixes) ||
      !p.allowedPrefixes.length ||
      p.allowedPrefixes.length > 64
    )
      denied();
    const prefixes = p.allowedPrefixes.map((prefix: unknown) => {
      if (typeof prefix !== 'string') denied();
      const normalized = (prefix as string).replace(/\/+$/, '');
      try {
        validateRelative(normalized, normalized.toLowerCase().endsWith('.md') ? 'note' : 'folder');
      } catch {
        denied();
      }
      return normalized;
    });
    return { scopes: p.scopes as string[], prefixes: prefixes as string[] };
  }
  const bridge = policy(options.bridgePolicies),
    backend = policy(options.backendPolicies),
    scopes = [...new Set(bridge.scopes.filter((s) => backend.scopes.includes(s)))];
  const prefixes = [
    ...new Set(
      bridge.prefixes.flatMap((a) =>
        backend.prefixes.flatMap((b) =>
          a === b || a.startsWith(b + '/') ? [a] : b.startsWith(a + '/') ? [b] : [],
        ),
      ),
    ),
  ];
  if (!scopes.includes('knowledge:read') || !prefixes.length) denied();
  return {
    principalId: record.id as string,
    clientId: record.clientId as string,
    issuedAt: record.issuedAt as number,
    expiresAt,
    scopes,
    allowedPrefixes: prefixes,
  };
}
export async function adoptLegacyTunnel(
  db: AppDatabase,
  config: HostConfig,
  options: {
    bearer: string;
    tokens: unknown;
    bridgePolicies: unknown;
    backendPolicies: unknown;
    compatPort: number;
    tunnelOrigin?: string;
  },
) {
  if (readInstance(config.dataRoot) || activeDatabaseProcesses(config.dataRoot).length)
    throw Error('承接前必须停止平台及独立数据进程');
  const notBefore = Number(
      (db.prepare("SELECT value FROM index_meta WHERE key='remote_auth_not_before'").get() as any)
        ?.value || 0,
    ),
    legacy = legacyTunnelAuthorization({ ...options, notBefore });
  if (
    !Number.isInteger(options.compatPort) ||
    options.compatPort < 1024 ||
    options.compatPort > 65535
  )
    throw Error('兼容端口不正确');
  if (options.tunnelOrigin) {
    const url = new URL(options.tunnelOrigin);
    if (
      url.protocol !== 'https:' ||
      url.origin !== options.tunnelOrigin ||
      url.username ||
      url.password
    )
      throw Error('Tunnel 外部地址须为 HTTPS 来源');
  }
  const owner = (db.prepare('SELECT id FROM user LIMIT 1').get() as any)?.id;
  if (!owner) throw Error('主人账号缺失');
  initializeTunnelIdentity(db);
  const existing = db
    .prepare('SELECT * FROM mcp_tunnel_identity WHERE owner_id=?')
    .get(owner) as any;
  if (
    existing &&
    (existing.principal_id !== legacy.principalId || existing.client_id !== legacy.clientId)
  )
    throw Error('已经存在不同的 Tunnel 身份，请先核对幂等归属');
  const host = pluginHost(config, db);
  let item = host.list().find((p) => p.id === 'mcp');
  if (!item) {
    await host.install('mcp');
    item = host.list().find((p) => p.id === 'mcp');
  }
  if (!item) throw Error('MCP 官方插件未安装');
  await host.configure(
    'mcp',
    {
      mode: 'tunnel',
      readOnly: !legacy.scopes.includes('knowledge:write'),
      allowIndex: legacy.scopes.includes('knowledge:index'),
      allowedPrefixes: legacy.allowedPrefixes,
      tunnelToken: options.bearer,
      compatPort: options.compatPort,
      tunnelOrigin: options.tunnelOrigin || '',
    },
    item.configVersion,
  );
  const info = host.secretInfo('mcp', 'tunnelToken');
  if (!info) throw Error('受控凭据未保存');
  db.transaction(() => {
    db.prepare(
      `INSERT INTO mcp_tunnel_identity(owner_id,principal_id,client_id,credential_reference,issued_at,expires_at,revoked,source_migrated) VALUES(?,?,?,?,?,?,0,1)
    ON CONFLICT(owner_id) DO UPDATE SET credential_reference=excluded.credential_reference,issued_at=excluded.issued_at,expires_at=excluded.expires_at,revoked=0,source_migrated=1`,
    ).run(
      owner,
      legacy.principalId,
      legacy.clientId,
      info.reference,
      legacy.issuedAt,
      legacy.expiresAt,
    );
    db.prepare(
      "UPDATE platform_plugins SET desired_enabled=1,state='disabled',active_version=NULL WHERE id='mcp'",
    ).run();
  }).immediate();
  return {
    adopted: true,
    receiptIdentityPreserved: true,
    originalIssuancePreserved: true,
    compatPort: options.compatPort,
    readOnly: !legacy.scopes.includes('knowledge:write'),
  };
}
