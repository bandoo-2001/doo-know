import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as Vue from 'vue';
import * as host from '../packages/plugin-ui/host';
import { afterEach, expect, it } from 'vitest';
import type { PluginView } from '../packages/plugin-contracts';

const cleanup: (() => Promise<unknown>)[] = [];
const releasePending: (() => void)[] = [];
function deferred<T>(fallback: T) {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  releasePending.push(() => resolve(fallback));
  return { promise, resolve };
}
const bundleURL = '/plugins/example/1.0.0/' + 'a'.repeat(64) + '/web/index.js';
function registry(owner: string, enabled = false) {
  const manifest = {
    id: 'example',
    title: 'Fixture',
    version: '1.0.0',
    apiVersion: '^1.0.0',
    server: 'server/index.mjs',
    web: 'web/index.js',
    capabilities: [],
    configSchema: { properties: {} },
    contributions: [
      {
        id: 'example.settings',
        title: 'Fixture',
        slot: 'settingsPage' as const,
        component: 'example.settings',
      },
    ],
  };
  const plugin: PluginView = {
    id: 'example',
    installedVersion: '1.0.0',
    desiredEnabled: enabled,
    state: enabled ? 'enabled' : 'disabled',
    configVersion: 1,
    restartRequired: false,
    manifest,
    config: { owner },
    configuredSecrets: [],
    ...(enabled ? { webUrl: bundleURL } : {}),
  };
  return {
    catalog: [],
    installed: [plugin],
    contributions: enabled
      ? manifest.contributions.map((item) => ({ ...item, pluginId: 'example' }))
      : [],
  };
}
function runtime(api: (...args: any[]) => Promise<any>, activate?: (api: any) => unknown) {
  const source = ts.transpileModule(
    readFileSync(new URL('../apps/web/plugins.ts', import.meta.url), 'utf8'),
    {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    },
  ).outputText;
  const module = { exports: {} as any };
  new Function('require', 'module', 'exports', source)(
    (id: string) => {
      if (id === 'vue') return Vue;
      if (id === '../../packages/plugin-ui/host') return host;
      if (id === './api') return { api };
      if (id === bundleURL) return { activate };
      throw Error('Unexpected plugin dependency: ' + id);
    },
    module,
    module.exports,
  );
  cleanup.push(() => module.exports.disposePluginUIs());
  return module.exports as typeof import('../apps/web/plugins');
}
afterEach(async () => {
  for (const release of releasePending.splice(0)) release();
  for (const dispose of cleanup.splice(0)) await dispose();
  host.pluginComponents.value = {};
  host.pluginPanel.value = undefined;
});

it('ignores an old registry response that completes after the session is disposed', async () => {
  const old = deferred(registry('old'));
  const started = deferred(undefined);
  const view = runtime(async () => {
    started.resolve(undefined);
    return old.promise;
  });
  const reading = view.refreshPlugins();
  await started.promise;
  const disposing = view.disposePluginUIs();
  old.resolve(registry('old'));
  await Promise.all([reading, disposing]);
  expect(view.pluginRegistry.value).toEqual({ catalog: [], installed: [], contributions: [] });
  expect(view.pluginUIErrors.value).toEqual({});
});

it('clears cached metadata and UI errors synchronously when a session exits', async () => {
  const view = runtime(async () => registry('old'));
  await view.refreshPlugins();
  view.pluginUIErrors.value = { example: 'Previous session error' };
  const disposing = view.disposePluginUIs();
  expect(view.pluginRegistry.value).toEqual({ catalog: [], installed: [], contributions: [] });
  expect(view.pluginUIErrors.value).toEqual({});
  await disposing;
});

it('finishes old UI cleanup before reading and activating the next session', async () => {
  const stopped = deferred(undefined),
    stopping = deferred(undefined);
  const events: string[] = [];
  const current = { setup: () => () => null },
    next = { setup: () => () => null };
  let reads = 0,
    activations = 0;
  const view = runtime(
    async () => {
      reads++;
      events.push('read-' + reads);
      return registry(reads === 1 ? 'old' : 'next', true);
    },
    async (api) => {
      const old = ++activations === 1;
      events.push(old ? 'activate-old' : 'activate-next');
      const remove = api.registerComponent('example.settings', old ? current : next);
      return async () => {
        if (old) {
          events.push('dispose-old-start');
          stopping.resolve(undefined);
          await stopped.promise;
          events.push('dispose-old-end');
        }
        remove();
      };
    },
  );
  await view.refreshPlugins();
  expect(host.pluginComponents.value['example.settings']).toBe(current);
  const disposing = view.disposePluginUIs();
  const fresh = view.refreshPlugins();
  await stopping.promise;
  await Promise.resolve();
  expect(events).not.toContain('read-2');
  stopped.resolve(undefined);
  await Promise.all([disposing, fresh]);
  expect(events.indexOf('dispose-old-end')).toBeLessThan(events.indexOf('read-2'));
  expect(host.pluginComponents.value['example.settings']).toBe(next);
  expect(view.pluginRegistry.value.installed[0].config.owner).toBe('next');
});

it('does not publish a late activation error or leave its components after logout', async () => {
  const finishing = deferred(undefined),
    started = deferred(undefined);
  const view = runtime(
    async () => registry('old', true),
    async (api) => {
      api.registerComponent('example.settings', { setup: () => () => null });
      started.resolve(undefined);
      await finishing.promise;
      throw Error('Late old-session activation failure');
    },
  );
  const reading = view.refreshPlugins();
  await started.promise;
  const disposing = view.disposePluginUIs();
  finishing.resolve(undefined);
  await Promise.all([reading, disposing]);
  expect(view.pluginRegistry.value).toEqual({ catalog: [], installed: [], contributions: [] });
  expect(view.pluginUIErrors.value).toEqual({});
  expect(host.pluginComponents.value['example.settings']).toBeUndefined();
});

it('rejects calls from an old UI binding before it can act with the next session cookies', async () => {
  let pluginApi: any,
    writes = 0;
  const view = runtime(
    async (url) => {
      if (url.endsWith('/call')) {
        writes++;
        return { written: true };
      }
      return registry('old', true);
    },
    (api) => {
      pluginApi = api;
    },
  );
  await view.refreshPlugins();
  const disposing = view.disposePluginUIs();
  await expect(pluginApi.call('command', 'example.write', {})).rejects.toThrow(/会话已结束/);
  expect(writes).toBe(0);
  await disposing;
});
