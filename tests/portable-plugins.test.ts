import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, cp, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { pluginHost } from '../apps/server/plugins/host.js';
import { openDatabase } from '../packages/core/db.js';
import type { PluginCatalogEntry } from '../packages/plugin-contracts/index.js';
import { pluginRuntimeFixture } from './support/plugin-runtime.js';
import { pluginServices } from '../apps/server/plugins/services.js';
import { portableConfigFields } from '../apps/server/plugins/portable.js';
import type { PluginManifest } from '../packages/plugin-contracts/index.js';
import { noteService } from '../packages/core/notes.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dooknow-portable-plugin-'));
  const source = join(root, 'source');
  await mkdir(join(source, 'server'), { recursive: true });
  const manifest = {
    id: 'portable-sample', version: '1.0.0', apiVersion: '^1.0.0', title: '用户资料测试插件',
    capabilities: [], server: 'server/index.mjs', contributions: [],
    configSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        label: { type: 'string', default: '默认', 'x-dooknow-portable': true },
        token: { type: 'string', writeOnly: true, 'x-dooknow-portable': true },
        localPath: { type: 'string', default: '' },
      },
    },
  };
  await writeFile(join(source, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(source, 'server/index.mjs'), `export function activate(ctx) {
    ctx.storage.set('activated', true);
    ctx.onConfigure(async () => {
      if (ctx.storage.get('hold-config')) {
        ctx.storage.set('config-validating', true);
        while (!ctx.storage.get('release-config')) await new Promise(resolve => setTimeout(resolve, 5));
      }
    });
    ctx.registerCommand('portable-sample.remember', ({input}) => {
      ctx.userData.set('saved', input);
      ctx.storage.set('preview.path', ctx.dataRoot + '/private-index');
    });
    ctx.registerProvider('portable-sample.saved', () => ctx.userData.get('saved'));
  }`);
  const artifact = join(root, 'sample.tar.gz');
  execFileSync('tar', ['--format=ustar', '-czf', artifact, '-C', source, '.']);
  const entry: PluginCatalogEntry = {
    ...manifest, description: '便携资料测试',
    artifact: {
      url: pathToFileURL(artifact).href,
      sha256: createHash('sha256').update(await readFile(artifact)).digest('hex'),
    },
  };
  const knowledgeRoot = join(root, 'knowledge');
  await mkdir(knowledgeRoot);
  const config = {
    dataRoot: join(root, 'source-data'), knowledgeRoot,
    secret: 'portable-plugin-fixture-secret-at-least-thirty-two-characters',
    origin: 'http://localhost', pluginCatalog: [entry],
  };
  const db = openDatabase(config.dataRoot);
  const host = pluginHost(config, db);
  return { root, knowledgeRoot, config, entry, db, host, close: async () => {
    await host.close(); db.close(); await rm(root, { recursive: true, force: true });
  } };
}

const relativeState = '_data/plugins/portable-sample/state.json';
const owner = { ownerId: 'source-owner' };

it('migrates legacy official Git author preferences while excluding secret and unmarked third-party fields', () => {
  const legacy = {
    id: 'git', version: '1.1.1', apiVersion: '^1.0.0', title: 'Git', capabilities: [],
    server: 'server/index.mjs', contributions: [], configSchema: { type: 'object', properties: {
      authorName: { type: 'string' },
      authorEmail: { type: 'string' },
      localPath: { type: 'string' },
    } },
  } satisfies PluginManifest;
  expect(Object.keys(portableConfigFields(legacy))).toEqual(['authorName', 'authorEmail']);
  expect(portableConfigFields({ ...legacy, id: 'third-party' })).toEqual({});
  expect(Object.keys(portableConfigFields({ ...legacy, configSchema: { properties: {
    authorName: { type: 'string', writeOnly: true },
    authorEmail: { type: 'object' },
  } } }))).toEqual([]);
});

it('copies opted config and user data to a fresh machine without installing or activating its plugin', async () => {
  const f = await fixture();
  let downloads = 0;
  const server = createServer((_req, res) => { downloads++; res.writeHead(404).end(); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const targetRoot = join(f.root, 'copied-knowledge');
  const targetDb = openDatabase(join(f.root, 'target-data'));
  let target: ReturnType<typeof pluginHost> | undefined;
  try {
    await f.host.install(f.entry.id);
    await f.host.configure(f.entry.id, { label: '保留的偏好', token: 'fixture-private-plugin-key', localPath: '/machine-only/runtime' }, 0);
    expect(existsSync(join(f.knowledgeRoot, relativeState))).toBe(true);
    await f.host.enable(f.entry.id);
    await f.host.call(f.entry.id, { kind: 'command', id: 'portable-sample.remember', input: { favorite: 'note-stable-id', count: 7 } }, owner);
    await cp(f.knowledgeRoot, targetRoot, { recursive: true });
    const serialized = await readFile(join(targetRoot, relativeState), 'utf8');
    for (const local of ['fixture-private-plugin-key', '$secretRef', '/machine-only/runtime', 'private-index', 'source-owner'])
      expect(serialized).not.toContain(local);
    expect(JSON.parse(serialized).data.config).toEqual({ label: '保留的偏好' });
    const targetEntry = { ...f.entry, artifact: { ...f.entry.artifact, url: `http://127.0.0.1:${(server.address() as any).port}/never-download` } };
    target = pluginHost({ ...f.config, knowledgeRoot: targetRoot, dataRoot: join(f.root, 'target-data'), pluginCatalog: [targetEntry] }, targetDb);
    await target.start();
    expect(target.list()).toEqual([]);
    expect(target.contributions()).toEqual([]);
    expect(target.dataDependencies()).toMatchObject([{ id: f.entry.id, version: '1.0.0', state: 'missing' }]);
    expect(downloads).toBe(0);
    expect(targetDb.prepare('SELECT 1 FROM platform_plugins').get()).toBeUndefined();

    targetEntry.artifact.url = f.entry.artifact.url;
    const installed = await target.install(f.entry.id);
    expect(installed).toMatchObject({ state: 'disabled', desiredEnabled: false, config: { label: '保留的偏好', localPath: '' }, configuredSecrets: [] });
    expect(target.storage(f.entry.id).get('activated')).toBeUndefined();
    expect(target.dataDependencies()[0].state).toBe('disabled');
    await target.enable(f.entry.id);
    expect(await target.call(f.entry.id, { kind: 'provider', id: 'portable-sample.saved', input: {} }, { ownerId: 'target-owner' })).toEqual({ favorite: 'note-stable-id', count: 7 });
    expect(target.storage(f.entry.id).get('preview.path')).toBeUndefined();
    await target.uninstall(f.entry.id);
    expect(target.dataDependencies()[0].state).toBe('missing');
    expect(existsSync(join(targetRoot, relativeState))).toBe(true);
  } finally {
    await target?.close(); targetDb.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await f.close();
  }
});

it('refreshes synced plugin preferences and rejects a stale configuration save', async () => {
  const f = await fixture();
  try {
    await f.host.install(f.entry.id);
    await f.host.configure(f.entry.id, { label: '原偏好', token: 'fixture-preserved-local-key' }, 0);
    expect(existsSync(join(f.knowledgeRoot, relativeState))).toBe(true);
    const original = f.host.list()[0];
    const file = join(f.knowledgeRoot, relativeState);
    const synced = JSON.parse(await readFile(file, 'utf8'));
    synced.revision = 'synced-preferences-revision';
    synced.data.config.label = '来自另一台机器';
    await writeFile(file, JSON.stringify(synced));
    const refreshed = f.host.list()[0];
    expect(refreshed.config.label).toBe('来自另一台机器');
    expect(refreshed.configuredSecrets).toEqual(['token']);
    expect(refreshed.configVersion).toBeGreaterThan(original.configVersion);
    await expect(f.host.configure(f.entry.id, { label: '旧草稿' }, original.configVersion)).rejects.toMatchObject({ code: 'CONFIG_VERSION_CONFLICT' });
  } finally { await f.close(); }
});

it('preserves a synced configuration that arrives while an active plugin validates a stale save', async () => {
  const f = await fixture();
  try {
    await f.host.install(f.entry.id);
    await f.host.configure(f.entry.id, { label: '原偏好' }, 0);
    await f.host.enable(f.entry.id);
    f.host.storage(f.entry.id).set('hold-config', true);
    const saving = f.host.configure(f.entry.id, { label: '过期提交' }, 1);
    const rejected = expect(saving).rejects.toMatchObject({ code: 'CONFIG_VERSION_CONFLICT' });
    await expect.poll(() => f.host.storage(f.entry.id).get('config-validating')).toBe(true);
    const file = join(f.knowledgeRoot, relativeState);
    const synced = JSON.parse(await readFile(file, 'utf8'));
    synced.revision = 'synced-during-async-validation';
    synced.data.config.label = '同步的新偏好';
    const expected = JSON.stringify(synced);
    await writeFile(file, expected);
    f.host.storage(f.entry.id).set('release-config', true);
    await rejected;
    expect(await readFile(file, 'utf8')).toBe(expected);
    const local = f.db.prepare('SELECT config_json FROM platform_plugins WHERE id=?').get(f.entry.id) as { config_json: string };
    expect(JSON.parse(local.config_json).label).toBe('原偏好');
    expect(f.host.list()[0].config.label).toBe('同步的新偏好');
  } finally {
    f.host.storage(f.entry.id).set('release-config', true);
    await f.close();
  }
});

it('reports an unavailable data dependency without creating an installed plugin record', async () => {
  const f = await fixture();
  let empty: ReturnType<typeof pluginHost> | undefined;
  const db = openDatabase(join(f.root, 'empty-data'));
  try {
    await f.host.install(f.entry.id);
    await f.host.configure(f.entry.id, { label: '保留' }, 0);
    expect(existsSync(join(f.knowledgeRoot, relativeState))).toBe(true);
    empty = pluginHost({ ...f.config, dataRoot: join(f.root, 'empty-data'), pluginCatalog: [] }, db);
    await empty.start();
    expect(empty.dataDependencies()).toMatchObject([{ id: f.entry.id, state: 'unavailable' }]);
    expect(empty.list()).toEqual([]);
    expect(db.prepare('SELECT 1 FROM platform_plugins').get()).toBeUndefined();
  } finally { await empty?.close(); db.close(); await f.close(); }
});

it('refuses symlinked portable plugin data without reading or replacing its external target', async () => {
  const f = await fixture();
  try {
    await f.host.install(f.entry.id);
    const directory = join(f.knowledgeRoot, '_data/plugins/portable-sample');
    await mkdir(directory, { recursive: true });
    const outside = join(f.root, 'outside.json');
    await writeFile(outside, 'external-file-sentinel');
    await rm(join(directory, 'state.json'), { force: true });
    await symlink(outside, join(directory, 'state.json'));
    await expect(f.host.configure(f.entry.id, { label: '拒绝越界' }, 0)).rejects.toMatchObject({ statusCode: 503 });
    expect(await readFile(outside, 'utf8')).toBe('external-file-sentinel');
  } finally { await f.close(); }
});

it.each(['disable', 'uninstall'] as const)('allows %s of an active plugin after its portable data becomes corrupt', async (action) => {
  const f = await fixture();
  try {
    await f.host.install(f.entry.id);
    await f.host.enable(f.entry.id);
    const file = join(f.knowledgeRoot, relativeState);
    await writeFile(file, 'malformed-portable-file-sentinel');
    await f.host[action](f.entry.id);
    const local = f.db.prepare('SELECT installed,state,desired_enabled FROM platform_plugins WHERE id=?').get(f.entry.id);
    expect(local).toEqual({ installed: action === 'uninstall' ? 0 : 1, state: 'disabled', desired_enabled: 0 });
    await expect(f.host.call(f.entry.id, { kind: 'provider', id: 'portable-sample.saved', input: {} }, owner))
      .rejects.toMatchObject({ code: 'PLUGIN_DISABLED' });
    expect(await readFile(file, 'utf8')).toBe('malformed-portable-file-sentinel');
  } finally { await f.close(); }
});

it('reports a failed local startup without executing a previously enabled plugin whose portable data is corrupt', async () => {
  const f = await fixture();
  let restarted: ReturnType<typeof pluginHost> | undefined;
  try {
    await f.host.install(f.entry.id);
    await f.host.enable(f.entry.id);
    await f.host.close();
    f.host.storage(f.entry.id).delete('activated');
    f.db.prepare("UPDATE platform_plugins SET state='enabled',active_version=installed_version WHERE id=?").run(f.entry.id);
    const file = join(f.knowledgeRoot, relativeState);
    await writeFile(file, 'startup-corrupt-data-sentinel');
    restarted = pluginHost(f.config, f.db);
    await restarted.start();
    expect(f.db.prepare('SELECT state,desired_enabled,active_version,error FROM platform_plugins WHERE id=?').get(f.entry.id))
      .toEqual({ state: 'failed', desired_enabled: 1, active_version: null, error: 'PORTABLE_PLUGIN_DATA_INVALID' });
    expect(restarted.list()[0].state).toBe('failed');
    expect(restarted.storage(f.entry.id).get('activated')).toBeUndefined();
    await expect(restarted.call(f.entry.id, { kind: 'provider', id: 'portable-sample.saved', input: {} }, owner))
      .rejects.toMatchObject({ code: 'PLUGIN_DISABLED' });
    expect(await readFile(file, 'utf8')).toBe('startup-corrupt-data-sentinel');
  } finally { await restarted?.close(); await f.close(); }
});

it('keeps ordinary note writes available when an unrelated plugin data file is corrupt', async () => {
  const f = await fixture();
  try {
    const notes = noteService(f.config, f.db);
    await f.host.install(f.entry.id);
    const file = join(f.knowledgeRoot, relativeState);
    await writeFile(file, 'unrelated-corrupt-plugin-data');
    const note = notes.createNote('', 'README.md', '# still writable', 'note-independent-of-plugin');
    expect(note.content).toBe('# still writable');
    expect(await readFile(join(f.knowledgeRoot, 'README.md'), 'utf8')).toBe('# still writable');
    expect(await readFile(file, 'utf8')).toBe('unrelated-corrupt-plugin-data');
  } finally { await f.close(); }
});

it('includes external note identities before a Git snapshot so later discovery does not invalidate it', async () => {
  const f = await pluginRuntimeFixture();
  try {
    const runtime = f.platform.get();
    await runtime.collections.close();
    execFileSync('git', ['init', '--initial-branch=main', f.config.knowledgeRoot]);
    await writeFile(join(f.config.knowledgeRoot, '00-Inbox/external.md'), '# external note');
    const services = pluginServices(f.platform, f.db, 'git',
      ['knowledge:read', 'knowledge:write', 'workspace:git'],
      { ownerId: f.principal.id, principal: f.principal, channel: 'web' });
    const workspace = services.workspace!;
    const env = { GIT_INDEX_FILE: join(f.config.dataRoot, 'snapshot-index') };
    const snapshot = () => workspace.exclusive(async () => {
      expect((await workspace.exec(['add', '--all', '--', '.'], { env })).code).toBe(0);
      return (await workspace.exec(['write-tree'], { env })).stdout.toString().trim();
    });
    const preview = await snapshot();
    runtime.notes.scan();
    expect(await snapshot()).toBe(preview);
  } finally { await f.close(); }
});
