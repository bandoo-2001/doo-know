import { readFileSync } from 'node:fs';
import { compileScript, parse } from '@vue/compiler-sfc';
import { describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import * as Vue from 'vue';
import * as workbench from '../apps/web/to-doo-workbench';
import * as controls from '../apps/web/to-doo-controls';

function editor(listId: string | null) {
  const { descriptor } = parse(
    readFileSync(
      new URL('../apps/web/components/to-doo/ToDooEntityEditor.vue', import.meta.url),
      'utf8',
    ),
  );
  const script = compileScript(descriptor, { id: 'entity-editor' });
  const compiled = ts.transpileModule(script.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const output = { exports: {} as any };
  new Function('require', 'module', 'exports', compiled)(
    (id: string) => {
      if (id === 'vue') return Vue;
      if (id === '../../to-doo-workbench') return workbench;
      if (id === '../../to-doo-controls') return controls;
      if (id === 'ant-design-vue' || id.endsWith('.vue')) return {};
      throw Error(`Unexpected entity dependency: ${id}`);
    },
    output,
    output.exports,
  );
  const component = output.exports.default;
  component.render = () => null;
  const renderer = Vue.createRenderer<any, any>({
    createComment: () => ({}),
    createElement: () => ({}),
    createText: () => ({}),
    insert() {},
    remove() {},
    setText() {},
    setElementText() {},
    patchProp() {},
    parentNode: () => null,
    nextSibling: () => null,
  });
  const saveEntity = vi.fn(async () => true);
  const model = {
    state: Vue.reactive({
      snapshot: {
        settings: { timeZone: 'UTC' },
        occurrences: [],
        lists: [{ id: 'list-1', name: 'Goal' }],
      },
      error: '',
    }),
    saveEntity,
  };
  const app = renderer.createApp(component, {
    kind: 'section',
    seed: { name: 'First chapter', listId },
    model,
    tree: [],
  });
  const mounted = app.mount({});
  const state = (mounted.$ as unknown as { setupState: { save: () => Promise<void> } }).setupState;
  return {
    model,
    save: state.save,
    unmount: () => app.unmount(),
  };
}

describe('section editor required list', () => {
  it('keeps an unassociated section unsaved after replacing the required select', async () => {
    const form = editor(null);
    try {
      await form.save();
      expect(form.model.saveEntity).not.toHaveBeenCalled();
      expect(form.model.state.error).toContain('目标或清单');
    } finally {
      form.unmount();
    }
  });

  it('saves an associated section with its typed list identifier', async () => {
    const form = editor('list-1');
    try {
      await form.save();
      expect(form.model.saveEntity).toHaveBeenCalledWith(
        'section',
        { name: 'First chapter', listId: 'list-1' },
        undefined,
      );
    } finally {
      form.unmount();
    }
  });
});
