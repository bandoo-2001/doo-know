import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { pluginHost } from '../apps/server/plugins/host.js';
import { openDatabase } from '../packages/core/db.js';
import type { PluginManifest } from '../packages/plugin-contracts/index.js';
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dooknow-plugin-'));
  const code = join(root, 'package'); await mkdir(join(code, 'server'), { recursive: true });
  const manifest: PluginManifest = { id: 'sample', version: '1.0.0', apiVersion: '^1.0.0', title: '测试插件',
    capabilities: [], server: 'server/index.mjs', configSchema: { type: 'object', additionalProperties: false,
      properties: { label: { type: 'string', default: '默认' }, token: { type: 'string', writeOnly: true }, metadata: { type: 'object' } } },
    contributions: [{ id: 'sample.settings', slot: 'settingsPage', title: '测试设置' }],
  };
  await writeFile(join(code, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(code, 'server/index.mjs'), `export async function activate(ctx) {
    const secret = ctx.secrets.getOrCreate('signature');
    ctx.registerProvider('sample.signature', async () => ({ length: secret.length, same: secret === ctx.secrets.getOrCreate('signature') }));
    ctx.registerCommand('sample.echo', async call => ({ label: ctx.config().label, secretConfigured: !!ctx.config().token, input: call.input }));
    ctx.registerProvider('sample.status', async () => ({ active: true }));
    ctx.onDispose(() => { ctx.storage.set('disposed', (ctx.storage.get('disposed') || 0) + 1); });
  }`);
  const artifact = join(root, 'sample.tar.gz');
  execFileSync('tar', ['--format=ustar', '-czf', artifact, '-C', code, '.']);
  const catalog = [{ ...manifest, description: 'fixture', artifact: { url: pathToFileURL(artifact).href,
    sha256: createHash('sha256').update(await readFile(artifact)).digest('hex') } }];
  const db = openDatabase(join(root, 'data'));
  const config = { dataRoot: join(root, 'data'), secret: 'plugin-only-secret-at-least-thirty-two-characters', origin: 'http://localhost', pluginCatalog: catalog };
  return { root, db, config, catalog, close: async () => { db.close(); await rm(root, { recursive: true, force: true }); } };
}
it('installs a prebuilt plugin, validates private config, dynamically enables and withdraws handlers', async () => {
  const f = await fixture(); const host = pluginHost(f.config, f.db);
  try {
    await host.start(); await host.install('sample');
    expect(host.list()[0].state).toBe('disabled');
    await host.configure('sample', { label: '自定义', token: 'fixture-private-token', metadata: { $secretRef: 'ordinary-business-data' } }, 0);
    expect(JSON.stringify(host.list())).not.toContain('fixture-private-token');
    expect(host.list()[0].config.metadata).toEqual({ $secretRef: 'ordinary-business-data' });
    const originalRef = JSON.parse((f.db.prepare('SELECT config_json FROM platform_plugins WHERE id=?').get('sample') as any).config_json).token.$secretRef;
    await host.configure('sample', { label: '自定义' }, 1);
    expect(JSON.parse((f.db.prepare('SELECT config_json FROM platform_plugins WHERE id=?').get('sample') as any).config_json).token.$secretRef).toBe(originalRef);
    await host.enable('sample'); await host.enable('sample');
    expect(await host.call('sample', { kind: 'provider', id: 'sample.signature', input: {} }, { ownerId: 'fixture-owner' })).toMatchObject({ same: true, length: 64 });
    expect(host.contributions()).toHaveLength(1);
    const context = { ownerId: 'fixture-owner', requestId: 'plugin-call' };
    expect(await host.call('sample', { kind: 'command', id: 'sample.echo', input: { value: 42 } }, context))
      .toEqual({ label: '自定义', secretConfigured: true, input: { value: 42 } });
    await expect(host.configure('sample', { label: 4 }, 2)).rejects.toMatchObject({ code: 'INVALID_PLUGIN_CONFIG' });
    await expect(host.configure('sample', { label: 'new' }, 0)).rejects.toMatchObject({ code: 'CONFIG_VERSION_CONFLICT' });
    await host.disable('sample'); expect(host.contributions()).toHaveLength(0);
    await expect(host.call('sample', { kind: 'command', id: 'sample.echo', input: {} }, context)).rejects.toMatchObject({ code: 'PLUGIN_DISABLED' });
    await host.enable('sample');
    expect(host.storage('sample').get('disposed')).toBe(1);
  } finally { await host.close(); await f.close(); }
});
it('rejects corrupted packages before loading code or installing records', async () => {
  const f = await fixture();
  f.catalog[0].artifact.sha256 = '0'.repeat(64);
  const host = pluginHost(f.config, f.db);
  try { await expect(host.install('sample')).rejects.toMatchObject({ code: 'PLUGIN_CHECKSUM_MISMATCH' }); expect(host.list()).toHaveLength(0); }
  finally { await host.close(); await f.close(); }
});

it('keeps active contributions at the old version until an upgrade restarts the backend', async () => {
  const f = await fixture(); const host = pluginHost(f.config, f.db);
  try {
    await host.install('sample'); await host.enable('sample');
    const manifestFile = join(f.root, 'package/manifest.json');
    const newer = JSON.parse(await readFile(manifestFile, 'utf8'));
    newer.version = '1.1.0'; newer.contributions[0].title = '升级后的设置';
    await writeFile(manifestFile, JSON.stringify(newer));
    const artifact = join(f.root, 'sample-new.tar.gz');
    execFileSync('tar', ['--format=ustar', '-czf', artifact, '-C', join(f.root, 'package'), '.']);
    Object.assign(f.catalog[0], newer, { artifact: { url: pathToFileURL(artifact).href,
      sha256: createHash('sha256').update(await readFile(artifact)).digest('hex') } });
    await host.install('sample');
    expect(host.list()[0].restartRequired).toBe(true);
    expect(host.contributions()[0].title).toBe('测试设置');
    await host.disable('sample');
    await expect(host.enable('sample')).rejects.toMatchObject({ code: 'PLUGIN_RESTART_REQUIRED' });
  } finally { await host.close(); await f.close(); }
});

it('requires a host restart after a plugin cleanup fails', async () => {
  const f = await fixture(); const host = pluginHost(f.config, f.db);
  try {
    await writeFile(join(f.root, 'package/server/index.mjs'), `export function activate(ctx) { ctx.onDispose(() => { throw Error('cleanup failed'); }); }`);
    const artifact = join(f.root, 'cleanup.tar.gz');
    execFileSync('tar', ['--format=ustar', '-czf', artifact, '-C', join(f.root, 'package'), '.']);
    f.catalog[0].artifact = { url: pathToFileURL(artifact).href, sha256: createHash('sha256').update(await readFile(artifact)).digest('hex') };
    await host.install('sample'); await host.enable('sample'); await host.disable('sample');
    expect(host.list()[0].restartRequired).toBe(true);
    await expect(host.enable('sample')).rejects.toMatchObject({ code: 'PLUGIN_RESTART_REQUIRED' });
  } finally { await host.close(); await f.close(); }
});
