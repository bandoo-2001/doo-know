import { afterEach, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { compileScript, parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as Vue from 'vue';
import * as NaiveUI from 'naive-ui';
import { renderToString } from 'vue/server-renderer';
import * as plugins from '../apps/web/plugins';
import * as host from '../packages/plugin-ui/host';
import * as api from '../apps/web/api';
import type { ContributionSlot } from '../packages/plugin-contracts';

// Compile the real slot, boundary and icon so the assertions cover rendered actions.
function component(name: string): Vue.Component {
  const descriptor = parse(
    readFileSync(new URL(`../apps/web/components/${name}.vue`, import.meta.url), 'utf8'),
  ).descriptor;
  const compiled = compileScript(descriptor, { id: name, inlineTemplate: true });
  const source = ts.transpileModule(compiled.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const output = { exports: {} as any };
  new Function('require', 'module', 'exports', source)(
    (id: string) => {
      if (id === 'vue') return Vue;
      if (id === 'naive-ui') return NaiveUI;
      if (id === '../plugins') return plugins;
      if (id === '../../../packages/plugin-ui/host') return host;
      if (id === '../api') return api;
      if (id === './PluginBoundary.vue') return { default: component('PluginBoundary') };
      if (id === './Icon.vue') return { default: component('Icon') };
      throw new Error('Unexpected slot dependency: ' + id);
    },
    output,
    output.exports,
  );
  return output.exports.default;
}
const PluginSlot = component('PluginSlot');
const initialRegistry = plugins.pluginRegistry.value;
const initialComponents = host.pluginComponents.value;
afterEach(() => {
  plugins.pluginRegistry.value = initialRegistry;
  host.pluginComponents.value = initialComponents;
});
function render(slotName: ContributionSlot, context = {}) {
  return renderToString(
    Vue.createSSRApp({ render: () => Vue.h(PluginSlot, { slotName, context }) }),
  );
}

it('suppresses only the legacy Git note action while retaining other plugins, IDs and visibility rules', async () => {
  plugins.pluginRegistry.value = {
    catalog: [],
    installed: [],
    contributions: [
      {
        pluginId: 'git',
        id: 'git.historyAction',
        slot: 'noteAction',
        title: 'Legacy duplicate',
        command: 'git.history',
      },
      {
        pluginId: 'git',
        id: 'git.otherAction',
        slot: 'noteAction',
        title: 'Git 版本',
        command: 'git.other',
      },
      {
        pluginId: 'other',
        id: 'git.historyAction',
        slot: 'noteAction',
        title: 'Git 版本',
        command: 'other.history',
      },
      {
        pluginId: 'other',
        id: 'other.hidden',
        slot: 'noteAction',
        title: 'Unavailable action',
        command: 'other.hidden',
        when: [{ key: 'note.editable', equals: true }],
      },
      {
        pluginId: 'git',
        id: 'git.historyAction',
        slot: 'navigation',
        title: 'Git navigation retained',
        command: 'git.history',
      },
    ],
  };
  const noteActions = await render('noteAction', { note: { editable: false } });
  expect(noteActions).not.toContain('Legacy duplicate');
  expect(noteActions.match(/Git 版本/g)).toHaveLength(2);
  expect(noteActions).not.toContain('Unavailable action');
  expect(noteActions).not.toContain('Git navigation retained');
  expect(await render('navigation')).toContain('Git navigation retained');
});

it('ships no duplicate note action while retaining the Git history panel', async () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../plugins/git/manifest.json', import.meta.url), 'utf8'),
  );
  plugins.pluginRegistry.value = {
    catalog: [],
    installed: [],
    contributions: manifest.contributions.map((item: any) => ({ ...item, pluginId: manifest.id })),
  };
  for (const item of manifest.contributions) {
    if (!item.component) continue;
    host.pluginComponents.value = {
      ...host.pluginComponents.value,
      [item.component]: Vue.defineComponent({ setup: () => () => Vue.h('span', item.title) }),
    };
  }
  expect(manifest.contributions.filter((item: any) => item.slot === 'noteAction')).toEqual([]);
  expect(await render('noteAction')).not.toContain('Git 版本');
  expect(await render('notePanel')).toContain('Git 历史与差异');
});
