import { readFileSync } from 'node:fs';
import { compileScript, parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as Vue from 'vue';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { toDooAntStubs, toDooBoundaryStub } from './support/to-doo-ant-stubs';

type Node = { tag: string; props: Record<string, any>; children: Node[]; parent?: Node };
const cleanup: (() => void)[] = [];
beforeEach(() => {
  vi.stubEnv('TZ', 'Europe/London');
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-30T12:00:00Z'));
});
afterEach(() => {
  cleanup.splice(0).forEach((fn) => fn());
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function component(): Vue.Component {
  const { descriptor } = parse(
    readFileSync(
      new URL('../apps/web/components/to-doo/ToDooReminders.vue', import.meta.url),
      'utf8',
    ),
  );
  const script = compileScript(descriptor, { id: 'reminder-editor', inlineTemplate: true });
  const compiled = ts.transpileModule(script.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const output = { exports: {} as any };
  new Function('require', 'module', 'exports', compiled)(
    (id: string) => {
      if (id === 'vue') return Vue;
      if (id === 'ant-design-vue') return toDooAntStubs;
      const boundary = toDooBoundaryStub(id);
      if (boundary) return { default: boundary };
      throw Error('Unexpected reminder editor dependency: ' + id);
    },
    output,
    output.exports,
  );
  return output.exports.default;
}

function editor(at: string) {
  const node = (tag: string): Node => ({ tag, props: {}, children: [] });
  const renderer = Vue.createRenderer<Node, Node>({
    createElement: node,
    createText: () => node('#text'),
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
    setText() {},
    setElementText() {},
    patchProp: (node, key, _previous, value) => {
      node.props[key] = value;
    },
    parentNode: (node) => node.parent || null,
    nextSibling: (node) => node.parent?.children[node.parent.children.indexOf(node) + 1] || null,
  });
  const rules = Vue.ref([
    { id: 'reminder', anchor: 'absolute', at, offsetMinutes: 0, allDayTime: '09:00' },
  ]);
  const subject = component();
  const root = node('root');
  const app = renderer.createApp({
    render: () =>
      Vue.h(subject, {
        modelValue: rules.value,
        'onUpdate:modelValue': (value: typeof rules.value) => {
          rules.value = value;
        },
      }),
  });
  app.mount(root);
  cleanup.push(() => app.unmount());
  const all = (parent = root): Node[] => [parent, ...parent.children.flatMap(all)];
  return {
    rules,
    input: () =>
      all().find((item) => item.tag === 'input' && item.props.type === 'datetime-local')!,
  };
}

test.each([
  ['2027-07-01T08:00:00Z', '2027-07-01T09:00'],
  ['2027-01-01T09:00:00Z', '2027-01-01T09:00'],
])('absolute reminder %s displays its own local offset', (instant, expected) => {
  const view = editor(instant);
  expect(view.input().props.value).toBe(expected);
});

test('editing a summer reminder keeps the displayed local hour on save', async () => {
  const view = editor('2027-07-01T08:00:00Z');
  expect(view.input().props.value).toBe('2027-07-01T09:00');
  view.input().props.onChange({ target: { value: '2027-07-01T09:15' } });
  await Vue.nextTick();
  expect(view.rules.value[0].at).toBe('2027-07-01T08:15:00.000Z');
  expect(view.input().props.value).toBe('2027-07-01T09:15');
});

test('a malformed absolute reminder can be opened and corrected', async () => {
  const view = editor('invalid-date');
  expect(view.input().props.value).toBe('');
  view.input().props.onChange({ target: { value: '2027-07-01T09:00' } });
  await Vue.nextTick();
  expect(view.rules.value[0].at).toBe('2027-07-01T08:00:00.000Z');
});
