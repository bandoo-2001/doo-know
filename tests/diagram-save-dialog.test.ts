import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse, compileScript } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as Vue from 'vue';
import type { DiagramSaveNeed } from '../shared/diagram-portability';

type Element = { tag: string; props: Record<string, any>; children: Element[]; text: string; parent?: Element };
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function mount(initial: { busy?: boolean; error?: string } = {}) {
  const descriptor = parse(readFileSync(new URL('../apps/web/components/DiagramSaveDialog.vue', import.meta.url), 'utf8')).descriptor;
  const compiled = compileScript(descriptor, { id: 'diagram-save-dialog', inlineTemplate: true });
  const source = ts.transpileModule(compiled.content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const output = { exports: {} as any };
  const Modal = Vue.defineComponent({ props: ['title'], setup: (props, { slots }) => () => Vue.h('section', { role: 'dialog', 'aria-label': props.title }, slots.default?.()) });
  new Function('require', 'module', 'exports', source)((id: string) => {
    if (id === 'vue') return Vue;
    if (id === 'ant-design-vue') return { Modal };
    throw Error('Unexpected dialog dependency: ' + id);
  }, output, output.exports);
  const root: Element = { tag: 'root', props: {}, children: [], text: '' };
  const renderer = Vue.createRenderer<Element, Element>({
    createElement: tag => ({ tag, props: {}, children: [], text: '' }),
    createText: text => ({ tag: '#text', props: {}, children: [], text }),
    createComment: () => ({ tag: '#comment', props: {}, children: [], text: '' }),
    insert(child, parent, anchor) {
      if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
      child.parent = parent;
      const index = anchor ? parent.children.indexOf(anchor) : -1;
      if (index < 0) parent.children.push(child); else parent.children.splice(index, 0, child);
    },
    remove(child) { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); },
    setText: (node, text) => { node.text = text; },
    setElementText: (node, text) => { node.text = text; node.children = []; },
    parentNode: node => node.parent || null,
    nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] || null,
    patchProp: (node, key, _previous, value) => { node.props[key] = value; },
  });
  const needs: DiagramSaveNeed[] = [{ kind: 'svg', code: '<svg/>', from: 0, to: 10, line: 2, codeHash: 'a'.repeat(64), reason: 'stale' }];
  const props = Vue.reactive({ needs, busy: false, error: '', ...initial });
  const events: string[] = [];
  const app = renderer.createApp({ render: () => Vue.h(output.exports.default, { ...props,
    onGenerate: () => events.push('generate'), onSourceOnly: () => events.push('source-only'), onClose: () => events.push('close') }) });
  app.mount(root);
  cleanups.push(() => app.unmount());
  const all = (node = root): Element[] => [node, ...node.children.flatMap(child => all(child))];
  const text = (node: Element): string => node.text + node.children.map(text).join('');
  const button = (label: string) => all().find(node => node.tag === 'button' && text(node).trim() === label)!;
  return { root, props, events, all, text, button };
}

describe('explicit diagram save dialog', () => {
  it('presents all three choices and emits only the choice selected by the user', () => {
    const dialog = mount();
    expect(dialog.all().find(node => node.props.role === 'dialog')?.props['aria-label']).toBe('保存图形预览');
    expect(dialog.text(dialog.root)).toContain('预览已过期');
    for (const [label, event] of [['生成预览并保存', 'generate'], ['仅保存源码', 'source-only'], ['取消', 'close']]) {
      dialog.button(label).props.onClick();
      expect(dialog.events.at(-1)).toBe(event);
    }
    expect(dialog.props.needs[0].code).toBe('<svg/>');
  });

  it('blocks duplicate choices while busy and keeps source-only available after generation fails', async () => {
    const dialog = mount({ busy: true });
    for (const label of ['生成预览并保存', '仅保存源码', '取消']) {
      expect(dialog.button(label).props.disabled).toBe(true);
      dialog.button(label).props.onClick();
    }
    expect(dialog.events).toEqual([]);
    dialog.props.busy = false;
    dialog.props.error = '无法生成预览';
    await Vue.nextTick();
    expect(dialog.all().find(node => node.props.role === 'alert') && dialog.text(dialog.root)).toContain('无法生成预览');
    expect(dialog.text(dialog.root)).toContain('源码和草稿已保留');
    expect(dialog.button('仅保存源码').props.disabled).toBe(false);
    dialog.button('仅保存源码').props.onClick();
    expect(dialog.events).toEqual(['source-only']);
  });
});
