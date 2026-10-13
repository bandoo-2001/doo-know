import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { AgentConfig, Principal } from '../../shared/knowledge-contracts.js';
import { fail } from '../knowledge/errors.js';
import { validateRelative } from '../files.js';
import type { AppDatabase } from '../db.js';
const equal = (a: string, b: string) => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
export const underPrefix = (path: string, prefix: string) =>
  path === prefix || path.startsWith(prefix + '/');
export function authorizeAgent(
  req: FastifyRequest,
  config?: AgentConfig,
  notBefore = 0,
): Principal {
  if (!config || !equal(String(req.headers.authorization || ''), `Bearer ${config.serviceToken}`))
    return fail(401, 'UNAUTHORIZED');
  try {
    const token = req.headers['x-agent-assertion'];
    if (typeof token !== 'string' || token.length > 8192) throw new Error();
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error();
    const [h, b, s] = parts;
    if (
      !equal(
        s,
        createHmac('sha256', config.assertionSecret).update(`${h}.${b}`).digest('base64url'),
      )
    )
      throw new Error();
    const header = JSON.parse(Buffer.from(h, 'base64url').toString()),
      claims = JSON.parse(Buffer.from(b, 'base64url').toString());
    const now = Math.floor(Date.now() / 1000);
    if (
      header.alg !== 'HS256' ||
      header.typ !== 'JWT' ||
      claims.iss !== config.issuer ||
      claims.aud !== config.audience ||
      !Number.isInteger(claims.exp) ||
      !Number.isInteger(claims.iat) ||
      claims.exp <= now ||
      claims.iat > now + 5 ||
      claims.exp - claims.iat > 60 ||
      claims.sub === 'web-owner' ||
      String(claims.sub).startsWith('share:') ||
      String(claims.sub).startsWith('system:') ||
      (claims.tokenIssuedAt != null &&
        (!Number.isInteger(claims.tokenIssuedAt) ||
          claims.tokenIssuedAt <= 0 ||
          claims.tokenIssuedAt > now + 5)) ||
      (notBefore > 0 &&
        (!Number.isInteger(claims.tokenIssuedAt) || claims.tokenIssuedAt <= notBefore)) ||
      !Array.isArray(claims.scopes) ||
      !Array.isArray(claims.allowedPrefixes)
    )
      throw new Error();
    const policy = config.policies.find(
      (p) => p.id === claims.sub && p.clientId === claims.clientId,
    );
    if (!policy) throw new Error();
    const prefixes: string[] = [];
    for (const p of claims.allowedPrefixes) {
      if (typeof p !== 'string') throw new Error();
      validateRelative(p, p.toLowerCase().endsWith('.md') ? 'note' : 'folder');
      for (const allowed of policy.allowedPrefixes) {
        if (underPrefix(p, allowed)) prefixes.push(p);
        else if (underPrefix(allowed, p)) prefixes.push(allowed);
      }
    }
    return {
      id: policy.id,
      clientId: policy.clientId,
      scopes: policy.scopes.filter((s) => claims.scopes.includes(s)),
      allowedPrefixes: [...new Set(prefixes)],
      ...(claims.tokenIssuedAt != null ? { tokenIssuedAt: claims.tokenIssuedAt } : {}),
    };
  } catch {
    return fail(401, 'UNAUTHORIZED');
  }
}
export function authorizationCutoff(db: AppDatabase) {
  return Number(
    (db.prepare("SELECT value FROM index_meta WHERE key='remote_auth_not_before'").get() as any)
      ?.value || 0,
  );
}
export function checkTokenCutoff(db: AppDatabase, p: Principal) {
  const cutoff = authorizationCutoff(db);
  if (
    cutoff &&
    p.id !== 'web-owner' &&
    !p.id.startsWith('share:') &&
    !p.id.startsWith('system:') &&
    (!p.tokenIssuedAt || p.tokenIssuedAt <= cutoff)
  )
    fail(401, 'UNAUTHORIZED');
}
export function requireScope(p: Principal, scope: string) {
  if (!p.scopes.includes(scope)) fail(403, 'FORBIDDEN');
}
export function authorizePath(p: Principal, path: string, scope = 'knowledge:read') {
  requireScope(p, scope);
  validateRelative(path, 'note');
  if (!p.allowedPrefixes.some((prefix) => underPrefix(path, prefix))) fail(403, 'FORBIDDEN');
}
