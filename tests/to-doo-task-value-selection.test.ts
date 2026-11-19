import { readFileSync } from 'node:fs';
import { compileScript, parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as Vue from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import * as values from '../apps/web/to-doo-task-values';
import * as controls from '../apps/web/to-doo-controls';

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.unstubAllGlobals();
});
function mount(multiple: boolean, props: Record<string, unknown> = {}) {
  vi.stubGlobal('document', { getElementById: () => null });
  const name = multiple ? 'ToDooTaskValueMultiSelect' : 'ToDooTaskValueSelect';
  const { descriptor } = parse(
    readFileSync(
      new URL('../apps/web/components/to-doo/' + name + '.vue', import.meta.url),
      'utf8',
    ),
  );
  const compiled = compileScript(descriptor, { id: name });
  const source = ts.transpileModule(compiled.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const output = { exports: {} as any };
  const empty = Vue.defineComponent({ render: () => null });
  new Function('require', 'module', 'exports', source)(
    (id: string) => {
      if (id === 'vue') return Vue;
      if (id === 'ant-design-vue') return { Select: empty };
      if (id.endsWith('/to-doo-task-values')) return values;
      if (id === '../../to-doo-controls') return controls;
      if (id.endsWith('.vue')) return { default: empty };
      throw Error('Unexpected value selector import: ' + id);
    },
    output,
    output.exports,
  );
  const component = output.exports.default;
  component.render = () => null;
  const renderer = Vue.createRenderer<Record<string, never>, Record<string, never>>({
    createComment: () => ({}),
    createElement: () => ({}),
    createText: () => ({}),
    insert: () => {},
    remove: () => {},
    setText: () => {},
    setElementText: () => {},
    patchProp: () => {},
    parentNode: () => null,
    nextSibling: () => null,
  });
  const updated = vi.fn(),
    changed = vi.fn();
  const app = renderer.createApp(component, {
    kind: 'priority',
    ...props,
    'onUpdate:modelValue': updated,
    onChange: changed,
  });
  const mounted = app.mount({});
  cleanups.push(() => app.unmount());
  const state = (mounted.$ as any).setupState;
  return {
    updated,
    changed,
    choose: state.change as (value: unknown) => void,
    options: state.options as { value: string; label: string }[],
  };
}

it('only admits an empty single selection when a caller explicitly provides its all-values option', () => {
  const normal = mount(false);
  normal.choose('');
  normal.choose('unexpected');
  expect(normal.changed).not.toHaveBeenCalled();
  const filter = mount(false, { emptyLabel: '全部优先级' });
  expect(filter.options[0]).toMatchObject({ value: '', label: '全部优先级' });
  filter.choose('');
  filter.choose('high');
  expect(filter.changed.mock.calls).toEqual([[''], ['high']]);
});

it('keeps multi selections as distinct raw enums and rejects an entire invalid selection', () => {
  const selector = mount(true, { kind: 'status' });
  selector.choose(['doing', 'blocked', 'doing']);
  expect(selector.changed).toHaveBeenLastCalledWith(['doing', 'blocked']);
  expect(selector.updated).toHaveBeenLastCalledWith(['doing', 'blocked']);
  selector.choose(['doing', '进行中']);
  selector.choose('doing');
  selector.choose([null]);
  expect(selector.changed).toHaveBeenCalledTimes(1);
  selector.choose([]);
  expect(selector.changed).toHaveBeenLastCalledWith([]);
});

it('does not emit values from a disabled multi control', () => {
  const selector = mount(true, { disabled: true });
  selector.choose(['high']);
  expect(selector.updated).not.toHaveBeenCalled();
  expect(selector.changed).not.toHaveBeenCalled();
});
