import { it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { activate } from '../plugins/git/server/index.js';
import { pluginRuntimeFixture } from './support/plugin-runtime.js';
import { pluginServices } from '../server/plugins/services.js';
import type { PluginContext, PluginCall } from '../packages/plugin-sdk/index.js';
async function fixture() {
  const f = await pluginRuntimeFixture(),
    commands = new Map<string, (c: PluginCall) => any>(),
    providers = new Map<string, (c: PluginCall) => any>(),
    data = new Map<string, any>();
  const services = pluginServices(
    f.platform,
    f.db,
    'git',
    ['knowledge:read', 'knowledge:write', 'workspace:git'],
    { ownerId: f.principal.id, principal: f.principal, channel: 'web' },
  );
  const context = {
    id: 'git',
    dataRoot: join(f.config.dataRoot, 'plugins/git'),
    config: () => ({ authorName: 'Fixture', authorEmail: 'fixture@example.invalid' }),
    registerCommand: (id: string, fn: any) => {
      commands.set(id, fn);
      return () => commands.delete(id);
    },
    registerProvider: (id: string, fn: any) => {
      providers.set(id, fn);
      return () => providers.delete(id);
    },
    storage: {
      get: (k: string) => data.get(k),
      set: (k: string, v: any) => data.set(k, v),
      delete: (k: string) => data.delete(k),
      entries: (p = '') =>
        [...data].filter(([k]) => k.startsWith(p)).map(([key, value]) => ({ key, value })),
    },
    onDispose: () => {},
    onConfigure: () => {},
  } as unknown as PluginContext;
  activate(context);
  const call = (id: string, input: any = {}) =>
    (commands.get(id) || providers.get(id))!({ input, ownerId: f.principal.id, services });
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', f.config.knowledgeRoot, ...args], { encoding: 'utf8' }).trim();
  await call('git.initialize', { requestId: 'init' });
  await writeFile(join(f.config.knowledgeRoot, '00-Inbox/source.md'), '# original\n\n');
  return { ...f, call, git, services };
}
it('recovers the original commit after reference publication but before its database receipt is saved', async () => {
  const f = await fixture();
  const execute = f.services.workspace!.exec;
  try {
    const preview = await f.call('git.preview', { message: 'Recover reference publication' });
    let crashed = false;
    f.services.workspace!.exec = async (args, options) => {
      const result = await execute(args, options);
      if (args.includes('update-ref') && !crashed) {
        crashed = true;
        throw Error('simulated process loss');
      }
      return result;
    };
    await expect(
      f.call('git.commit', { token: preview.token, requestId: 'lost-reference-response' }),
    ).rejects.toThrow();
    const published = f.git('rev-parse', 'HEAD');
    expect(f.git('rev-list', '--count', 'HEAD')).toBe('1');
    f.services.workspace!.exec = execute;
    const recovered = await f.call('git.commit', {
      token: preview.token,
      requestId: 'lost-reference-response',
    });
    expect(recovered).toMatchObject({
      commit: published,
      published: true,
      needsReconciliation: false,
    });
    expect(f.git('rev-list', '--count', 'HEAD')).toBe('1');
    expect(f.git('status', '--porcelain')).toBe('');
  } finally {
    await f.close();
  }
}, 45000);
it('preserves an externally locked index after a published commit, returns a fixed receipt and requires explicit reconciliation', async () => {
  const f = await fixture();
  const execute = f.services.workspace!.exec;
  try {
    const preview = await f.call('git.preview', { message: 'Index lock after publication' });
    f.services.workspace!.exec = async (args, options) => {
      const result = await execute(args, options);
      if (args.includes('update-ref'))
        await writeFile(join(f.config.knowledgeRoot, '.git/index.lock'), 'external lock', {
          flag: 'wx',
        });
      return result;
    };
    const result = await f.call('git.commit', { token: preview.token, requestId: 'locked-index' });
    expect(result).toMatchObject({ published: true, needsReconciliation: true });
    expect(await readFile(join(f.config.knowledgeRoot, '.git/index.lock'), 'utf8')).toBe(
      'external lock',
    );
    await expect(readFile(join(f.config.knowledgeRoot, '.git/index'))).rejects.toThrow();
    f.services.workspace!.exec = execute;
    expect(await f.call('git.commit', { token: preview.token, requestId: 'locked-index' })).toEqual(
      result,
    );
    await rm(join(f.config.knowledgeRoot, '.git/index.lock'));
    await expect(
      f.call('git.preview', { message: 'Blocked pending reconciliation' }),
    ).rejects.toMatchObject({ code: 'GIT_RECONCILIATION_REQUIRED' });
    const pending = await f.call('git.status');
    expect(pending.pending).toHaveLength(1);
    await f.call('git.acknowledge', { operationId: pending.pending[0].operationId, confirm: true });
    expect((await f.call('git.status')).pending).toHaveLength(0);
  } finally {
    await f.close();
  }
}, 45000);
it('detects an index changed after preview without overwriting the external staging, and restores exact UTF-8 bytes', async () => {
  const f = await fixture();
  try {
    const preview = await f.call('git.preview', { message: 'Initial' }),
      initial = await f.call('git.commit', { token: preview.token, requestId: 'first' });
    const headersNote = await f.services.knowledge.create({
      directory: '00-Inbox',
      fileName: 'other.md',
      content: '# untouched\n',
      requestId: 'other',
    });
    const stale = await f.call('git.preview', { message: 'Before external stage' });
    f.git('add', '00-Inbox/other.md');
    const before = await readFile(join(f.config.knowledgeRoot, '.git/index'));
    await expect(
      f.call('git.commit', { token: stale.token, requestId: 'stale-index' }),
    ).rejects.toMatchObject({ code: 'PREVIEW_STALE' });
    expect(await readFile(join(f.config.knowledgeRoot, '.git/index'))).toEqual(before);
    f.platform.get().notes.scan();
    const notes = f.platform.get().notes.tree();
    const id = (f.db.prepare("SELECT id FROM notes WHERE path='00-Inbox/source.md'").get() as any)
      .id;
    await writeFile(join(f.config.knowledgeRoot, '00-Inbox/source.md'), '# changed');
    const info = await f.services.knowledge.info({ noteId: id });
    const restored = await f.call('git.restore', {
      noteId: id,
      commit: initial.commit,
      expectedModifiedAt: info.modifiedAt,
      requestId: 'restore-newlines',
    });
    expect(restored.id).toBe(id);
    expect(await readFile(join(f.config.knowledgeRoot, '00-Inbox/source.md'), 'utf8')).toBe(
      '# original\n\n',
    );
    expect(headersNote.id).toBeTruthy();
    expect(notes.length).toBeGreaterThan(0);
  } finally {
    await f.close();
  }
}, 45000);
