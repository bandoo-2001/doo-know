import { mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { ServiceHealthError, waitHealthy } from '../apps/server/platform/service.js';
import { readKnowledgeRootIdentity } from '../packages/core/indexing/root-identity.js';
import { installError } from '../scripts/install-error.js';
import type { HostConfig } from '../shared/platform-contracts.js';

const base: HostConfig = {
  dataRoot: '/unused',
  host: '127.0.0.1',
  port: 15183,
  origin: 'http://127.0.0.1:15183',
  secret: 'disposable-test-secret',
};

const fixtures: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});

it('allows a fresh instance without a bound knowledge base to finish installation', async () => {
  const health = { version: '1.1.0-rc.70', phase: 'setup_required' };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(health)));
  await expect(waitHealthy(base, health.version)).resolves.toEqual(health);
});

it('reports a non-DooKnow response without displaying response content', async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('synthetic-secret-value', { status: 502 })),
  );
  const failed = waitHealthy(base, '1.1.0-rc.70').catch((error) => error);
  await vi.advanceTimersByTimeAsync(30_000);
  const error = await failed;
  expect(error).toMatchObject({
    observation: { kind: 'invalid_response', httpStatus: 502 },
  });
  const message = installError(error, { step: '等待服务健康检查', config: base }).message;
  expect(message).toContain('HTTP 502');
  expect(message).toContain('curl --noproxy');
  expect(message).not.toContain('synthetic-secret-value');
});

it('explains a missing original directory and a different replacement directory without changing the binding', () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'dooknow-install-diagnostics-'));
  fixtures.push(dataRoot);
  const root = join(dataRoot, '原知识库');
  mkdirSync(root);
  const identity = readKnowledgeRootIdentity(root);
  const db = new Database(join(dataRoot, 'app.sqlite'));
  try {
    db.exec(`
      CREATE TABLE platform_settings(id INTEGER PRIMARY KEY, knowledge_root TEXT);
      CREATE TABLE index_meta(key TEXT PRIMARY KEY, value TEXT);
    `);
    db.prepare('INSERT INTO platform_settings VALUES(1, ?)').run(root);
    db.prepare("INSERT INTO index_meta VALUES('root_identity', ?)").run(identity);
    renameSync(root, root + '-moved');
    const error = new ServiceHealthError(base.origin + '/healthz', '1.1.0-rc.70', {
      kind: 'phase',
      phase: 'source_unavailable',
      httpStatus: 200,
      version: '1.1.0-rc.70',
    });
    const progress = {
      step: '等待服务健康检查',
      serviceName: 'doo-know-example.service',
      serviceStarted: true,
      config: { ...base, dataRoot },
    };
    const missing = installError(error, progress).message;
    expect(missing).toContain(root);
    expect(missing).toContain('磁盘挂载');
    expect(missing).toContain('回收站');
    expect(missing).toContain('XDG_DATA_HOME');
    expect(missing).toContain('journalctl --user -u doo-know-example.service');
    expect(missing).toContain('重跑原安装命令');

    mkdirSync(root);
    expect(installError(error, progress).message).toContain('原目录身份不同');
    expect(db.prepare("SELECT value FROM index_meta WHERE key='root_identity'").get()).toEqual({
      value: identity,
    });
    expect(db.prepare('SELECT knowledge_root FROM platform_settings WHERE id=1').get()).toEqual({
      knowledge_root: root,
    });
  } finally {
    db.close();
  }
});
