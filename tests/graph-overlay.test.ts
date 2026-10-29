import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { compileScript, parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as Vue from 'vue';
import { toDooAntStubs } from './support/to-doo-ant-stubs';

type Node = {
  tag: string;
  props: Record<string, any>;
  children: Node[];
  text: string;
  parent?: Node;
};
const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
  vi.unstubAllGlobals();
});

function mount(dirty = true, busy = false) {
  vi.stubGlobal('HTMLElement', class {});
  vi.stubGlobal('document', {
    activeElement: null,
    addEventListener() {},
    removeEventListener() {},
  });
  const descriptor = parse(
    readFileSync(new URL('../apps/web/components/graph/GraphOverlay.vue', import.meta.url), 'utf8'),
  ).descriptor;
  const source = ts.transpileModule(
    compileScript(descriptor, { id: 'graph-overlay-test', inlineTemplate: true }).content,
    {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    },
  ).outputText;
  const passthrough = Vue.defineComponent({
    setup:
      (_, { slots }) =>
      () =>
        Vue.h('div', slots.default?.()),
  });
  const modal = Vue.defineComponent({
    props: ['open'],
    setup:
      (props, { slots }) =>
      () =>
        props.open ? Vue.h('div', [slots.title?.(), slots.default?.()]) : null,
  });
  const output = { exports: {} as any };
  new Function('require', 'module', 'exports', source)(
    (id: string) => {
      if (id === 'vue') return Vue;
      if (id === 'ant-design-vue')
        return {
          ...toDooAntStubs,
          Modal: modal,
          Drawer: modal,
          ConfigProvider: passthrough,
          theme: { useToken: () => ({ token: Vue.ref({ zIndexPopupBase: 1000 }) }) },
        };
      if (id.endsWith('Icon.vue')) return { default: Vue.defineComponent({ render: () => null }) };
      throw Error('Unexpected dependency ' + id);
    },
    output,
    output.exports,
  );
  const node = (tag: string, text = ''): Node => ({ tag, text, props: {}, children: [] });
  const renderer = Vue.createRenderer<Node, Node>({
    createElement: (tag) => node(tag),
    createText: (text) => node('#text', text),
    createComment: () => node('#comment'),
    insert(child, parent, anchor) {
      if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
      child.parent = parent;
      const index = anchor ? parent.children.indexOf(anchor) : -1;
      if (index < 0) parent.children.push(child);
      else parent.children.splice(index, 0, child);
    },
    remove(child) {
      if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
    },
    setText: (node, text) => {
      node.text = text;
    },
    setElementText: (node, text) => {
      node.text = text;
      node.children = [];
    },
    parentNode: (node) => node.parent || null,
    nextSibling: (node) => node.parent?.children[node.parent.children.indexOf(node) + 1] || null,
    patchProp: (node, key, _before, value) => {
      node.props[key] = value;
    },
  });
  const props = Vue.reactive({ show: true, title: '模型设置', dirty, busy });
  const exposed = Vue.ref<any>();
  const app = renderer.createApp({
    render: () =>
      Vue.h(output.exports.default, {
        ...props,
        ref: exposed,
        'onUpdate:show': (show: boolean) => {
          props.show = show;
        },
      }),
  });
  const root = node('root');
  app.mount(root);
  cleanups.push(() => app.unmount());
  const all = (parent = root): Node[] => [parent, ...parent.children.flatMap(all)];
  const text = (parent: Node): string => parent.text + parent.children.map(text).join('');
  const button = (label: string) => all().find((n) => n.tag === 'button' && text(n) === label)!;
  const request = () => {
    expect(exposed.value.requestClose).toEqual(expect.any(Function));
    return exposed.value.requestClose() as Promise<boolean>;
  };
  return {
    props,
    request,
    button,
    exposed,
    unmount: () => {
      cleanups.pop();
      app.unmount();
    },
  };
}

it('cancelling an external close request preserves the model form and denies navigation', async () => {
  const view = mount();
  const pending = view.request();
  await Vue.nextTick();
  view.button('继续编辑').props.onClick();
  expect(await pending).toBe(false);
  expect(view.props.show).toBe(true);
  expect(view.props.dirty).toBe(true);
});

it('only the first pending navigation can receive permission to discard the form', async () => {
  const view = mount();
  const first = view.request();
  expect(await view.request()).toBe(false);
  await Vue.nextTick();
  view.button('放弃更改').props.onClick();
  expect(await first).toBe(true);
  expect(view.props.show).toBe(false);
});

it('busy work denies navigation, including while a discard confirmation is pending', async () => {
  const view = mount(true, true);
  expect(await view.request()).toBe(false);
  view.props.busy = false;
  await Vue.nextTick();
  const pending = view.request();
  await Vue.nextTick();
  view.props.busy = true;
  await Vue.nextTick();
  view.button('放弃更改').props.onClick();
  expect(view.props.show).toBe(true);
  view.props.busy = false;
  await Vue.nextTick();
  view.button('继续编辑').props.onClick();
  expect(await pending).toBe(false);
});

it('unmounting settles a pending close as cancelled instead of leaving navigation unresolved', async () => {
  const view = mount();
  const pending = view.request();
  view.unmount();
  expect(await pending).toBe(false);
});

it('a saved clean form can close without prompting', async () => {
  const view = mount(false);
  expect(await view.request()).toBe(true);
  expect(view.props.show).toBe(false);
});
