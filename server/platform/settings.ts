import { accessSync, constants, lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, relative, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AppConfig } from '../../shared/contracts.js';
import type { HostConfig, PlatformStatus } from '../../shared/platform-contracts.js';
import type { AppDatabase } from '../db.js';
import { webPrincipal } from '../knowledge/core.js';
import { beginOperation, completeOperation, existingResult } from '../knowledge/operations.js';
import { fail } from '../knowledge/errors.js';
import { assertRoot } from '../indexing/reconcile.js';

interface Binding { knowledge_root: string; time_zone: string; binding_version: number; onboarding_completed_at: number | null }
export function platformSettings(config: HostConfig, db: AppDatabase) {
  db.exec(`CREATE TABLE IF NOT EXISTS platform_settings (
    id INTEGER PRIMARY KEY CHECK(id=1),schema_version INTEGER NOT NULL DEFAULT 1,
    knowledge_root TEXT NOT NULL,time_zone TEXT NOT NULL,configured_at INTEGER NOT NULL,
    binding_version INTEGER NOT NULL,setup_operation_id TEXT NOT NULL REFERENCES operations(id));`);
  if (!(db.prepare('PRAGMA table_info(platform_settings)').all() as any[]).some(c => c.name === 'onboarding_completed_at'))
    db.exec('ALTER TABLE platform_settings ADD COLUMN onboarding_completed_at INTEGER');
  const validations = new Map<string, { owner: string; path: string; dev: string; ino: string; expires: number }>();
  const binding = () => db.prepare('SELECT * FROM platform_settings WHERE id=1').get() as Binding | undefined;
  const strictChild = (path: string, parent: string) => path.startsWith(parent + sep);
  const overlap = (a: string, b: string) => a === b || strictChild(a, b) || strictChild(b, a);
  function checkRoot(input: unknown) {
    if (typeof input !== 'string' || !input || input.includes('\0') || !input.startsWith('/'))
      fail(400, 'INVALID_KNOWLEDGE_ROOT');
    const path = resolve(input);
    const allowed = (config.allowedKnowledgeBases || [homedir()]).map(p => resolve(p));
    const parent = allowed.find(p => strictChild(path, p));
    if (!parent) fail(403, 'FORBIDDEN_KNOWLEDGE_ROOT');
    try {
      if (realpathSync(parent) !== parent) fail(400, 'INVALID_KNOWLEDGE_ROOT');
      let current = parent;
      for (const component of relative(parent, path).split(sep)) {
        if (component.startsWith('.')) fail(400, 'INVALID_KNOWLEDGE_ROOT');
        current = resolve(current, component);
        const s = lstatSync(current);
        if (!s.isDirectory() || s.isSymbolicLink()) fail(400, 'INVALID_KNOWLEDGE_ROOT');
      }
      for (const forbidden of [config.dataRoot, config.applicationRoot, config.pluginRoot || resolve(config.dataRoot, '../plugins'), config.secretFile && resolve(config.secretFile, '..')].filter(Boolean) as string[]) {
        let canonical = resolve(forbidden);
        try { canonical = realpathSync(canonical); } catch {}
        if (overlap(path, canonical)) fail(403, 'FORBIDDEN_KNOWLEDGE_ROOT');
      }
      accessSync(path, constants.R_OK | constants.W_OK | constants.X_OK);
      const s = lstatSync(path, { bigint: true });
      return { path: realpathSync(path), dev: String(s.dev), ino: String(s.ino) };
    } catch (e) {
      if (e instanceof Error && 'statusCode' in e) throw e;
      fail(400, 'INVALID_KNOWLEDGE_ROOT');
    }
  }
  function configured(): AppConfig | undefined {
    const saved = binding();
    const legacy = config.knowledgeRoot;
    if (saved && legacy) {
      try { if (realpathSync(legacy) !== realpathSync(saved.knowledge_root)) fail(503, 'CONFIGURATION_CONFLICT'); }
      catch (e) { if (e instanceof Error && 'statusCode' in e) throw e; fail(503, 'SOURCE_UNAVAILABLE'); }
    }
    const root = legacy || saved?.knowledge_root;
    if (!root) {
      if (db.prepare('SELECT 1 FROM notes LIMIT 1').get() || db.prepare("SELECT 1 FROM index_meta WHERE key='root_identity'").get())
        fail(503, 'CONFIGURATION_CONFLICT');
      return;
    }
    return { ...config, knowledgeRoot: root };
  }
  function status(runtimeReady: boolean, initializing: boolean, error?: string): PlatformStatus {
    const saved = binding();
    let business: AppConfig | undefined;
    try { business = configured(); if (business) assertRoot(business, db); }
    catch (e) { error = (e as any).code || 'SOURCE_UNAVAILABLE'; }
    const owner = !!db.prepare('SELECT id FROM user LIMIT 1').get();
    const phase = error === 'CONFIGURATION_CONFLICT' ? 'configuration_error' : error ? 'source_unavailable'
      : !owner ? 'owner_required' : !business ? 'setup_required' : initializing ? 'initializing'
      : runtimeReady ? 'ready' : 'initializing';
    return { phase, setupRequired: phase === 'setup_required',
      configurationSource: config.knowledgeRoot ? 'deployment' : saved ? 'application' : 'none',
      ...(business ? { knowledgeRoot: business.knowledgeRoot } : {}),
      timeZone: saved?.time_zone || 'Asia/Shanghai', bindingVersion: saved?.binding_version || 0,
      onboardingRequired: !!saved && !saved.onboarding_completed_at,
      allowedKnowledgeBases: config.allowedKnowledgeBases || [homedir()],
      components: { knowledge: runtimeReady && !error, search: false }, ...(error ? { code: error } : {}) };
  }
  function validate(owner: string, input: unknown) {
    const root = checkRoot(input), now = Date.now();
    for (const [key, v] of validations) if (v.expires <= now) validations.delete(key);
    const own = [...validations].filter(([, v]) => v.owner === owner);
    if (own.length >= 16) validations.delete(own[0][0]);
    const validationId = randomBytes(32).toString('base64url'), expires = now + 5 * 60000;
    validations.set(validationId, { owner, ...root, expires });
    return { knowledgeRoot: root.path, validationId, expiresAt: new Date(expires).toISOString() };
  }
  function complete(owner: string, input: any) {
    if (!input || typeof input.knowledgeRoot !== 'string' || !input.knowledgeRoot.startsWith('/')) fail(400, 'INVALID_KNOWLEDGE_ROOT');
    let timeZone: string;
    try { timeZone = new Intl.DateTimeFormat('en', { timeZone: input.timeZone || 'Asia/Shanghai' }).resolvedOptions().timeZone; }
    catch { fail(400, 'INVALID_TIME_ZONE'); }
    const knowledgeRoot = resolve(input.knowledgeRoot);
    return db.transaction(() => {
      const { operation, fresh } = beginOperation(db, { ...webPrincipal, id: owner, clientId: 'platform-web' },
        'platform_setup', input.requestId, { knowledgeRoot, timeZone });
      if (!fresh) return existingResult(operation);
      if (binding() || config.knowledgeRoot) fail(409, 'SETUP_ALREADY_COMPLETE');
      if (db.prepare('SELECT 1 FROM notes LIMIT 1').get() || db.prepare("SELECT 1 FROM index_meta WHERE key='root_identity'").get()) fail(503, 'CONFIGURATION_CONFLICT');
      const proof = validations.get(input.validationId);
      if (!proof || proof.owner !== owner || proof.expires <= Date.now()) fail(409, 'VALIDATION_EXPIRED');
      const root = checkRoot(knowledgeRoot);
      if (root.path !== proof.path || root.dev !== proof.dev || root.ino !== proof.ino) fail(409, 'KNOWLEDGE_ROOT_CHANGED');
      assertRoot({ ...config, knowledgeRoot }, db);
      const identity = db.prepare("SELECT value FROM index_meta WHERE key='root_identity'").get() as { value: string };
      if (identity.value !== JSON.stringify({ path: root.path, dev: root.dev, ino: root.ino })) fail(409, 'KNOWLEDGE_ROOT_CHANGED');
      db.prepare('INSERT INTO platform_settings(id,knowledge_root,time_zone,configured_at,binding_version,setup_operation_id) VALUES(1,?,?,?,?,?)')
        .run(knowledgeRoot, timeZone, Date.now(), 1, operation.id);
      const receipt = { configSaved: true, operationId: operation.id, bindingVersion: 1, knowledgeRoot };
      completeOperation(db, operation.id, receipt);
      return receipt;
    }).immediate();
  }
  function finish() {
    if (!binding()) fail(409, 'SETUP_REQUIRED');
    db.prepare('UPDATE platform_settings SET onboarding_completed_at=? WHERE id=1 AND onboarding_completed_at IS NULL').run(Date.now());
    return { completed: true };
  }
  return { configured, status, validate, complete, finish };
}
