import { openSync, closeSync, fstatSync, readFileSync, constants } from 'node:fs';
import { resolve } from 'node:path';
import type { AppConfig } from '../../shared/contracts.js';
import type { AgentConfig, Principal } from '../../shared/knowledge-contracts.js';
import { validateRelative } from '../files.js';
export function privateFile(path: string, maxBytes = 65536) {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const s = fstatSync(fd);
    if (!s.isFile() || s.nlink !== 1 || s.mode & 0o077 || s.size > maxBytes) throw new Error();
    return readFileSync(fd, 'utf8');
  } catch {
    throw new Error('机器授权文件不可用或权限不正确');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
export function loadAgentConfig(file: string, knowledgeRoot: string): AgentConfig {
  const external = (value: unknown) => {
    if (typeof value !== 'string' || !value.length) throw new Error('机器授权配置缺少凭据文件');
    const p = resolve(value),
      root = resolve(knowledgeRoot);
    if (p === root || p.startsWith(root + '/')) throw new Error('机器凭据不能位于知识库');
    return p;
  };
  let source: any;
  try {
    source = JSON.parse(privateFile(external(file)));
  } catch {
    throw new Error('机器授权配置不可用或格式不正确');
  }
  if (
    typeof source.issuer !== 'string' ||
    !source.issuer.length ||
    typeof source.audience !== 'string' ||
    !source.audience.length ||
    !Array.isArray(source.policies) ||
    source.policies.length > 64
  )
    throw new Error('机器授权配置格式不正确');
  const policies: Principal[] = source.policies.map((p: any) => {
    if (
      typeof p.id !== 'string' ||
      !p.id.length ||
      p.id.length > 256 ||
      typeof p.clientId !== 'string' ||
      !p.clientId.length ||
      p.clientId.length > 256 ||
      !Array.isArray(p.scopes) ||
      p.scopes.some(
        (s: any) => !['knowledge:read', 'knowledge:write', 'knowledge:index'].includes(s),
      ) ||
      !Array.isArray(p.allowedPrefixes) ||
      p.allowedPrefixes.length > 64
    )
      throw new Error('机器授权策略格式不正确');
    for (const prefix of p.allowedPrefixes) {
      if (typeof prefix !== 'string') throw new Error('机器目录策略格式不正确');
      validateRelative(prefix, prefix.toLowerCase().endsWith('.md') ? 'note' : 'folder');
    }
    return {
      id: p.id,
      clientId: p.clientId,
      scopes: [...new Set<string>(p.scopes)],
      allowedPrefixes: [...new Set<string>(p.allowedPrefixes)],
    };
  });
  const serviceToken = privateFile(external(source.serviceTokenFile), 8192).trim(),
    assertionSecret = privateFile(external(source.assertionKeyFile), 8192).trim();
  if (serviceToken.length < 32 || assertionSecret.length < 32 || /[\r\n]/.test(serviceToken))
    throw new Error('机器凭据格式不正确');
  return {
    serviceToken,
    assertionSecret,
    issuer: source.issuer,
    audience: source.audience,
    policies,
  };
}
export function currentAgentConfig(config: AppConfig) {
  return config.agentConfigFile
    ? loadAgentConfig(config.agentConfigFile, config.knowledgeRoot)
    : config.agent;
}
