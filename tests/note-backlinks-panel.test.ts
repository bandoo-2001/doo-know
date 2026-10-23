import { readFileSync } from 'node:fs';
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as Vue from 'vue';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const descriptor = parse(readFileSync(new URL('../apps/web/components/NoteBacklinks.vue', import.meta.url), 'utf8')).descriptor;
const script = compileScript(descriptor, { id: 'backlinks-panel' });
const template = compileTemplate({ source: descriptor.template!.content, filename: 'NoteBacklinks.vue', id: 'backlinks-panel', compilerOptions: { bindingMetadata: script.bindings } });
const source = ts.transpileModule(script.content + '\n' + template.code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const fetchPage = vi.fn();
let unmount: (() => void) | undefined;
beforeEach(() => { fetchPage.mockReset(); vi.stubGlobal('fetch', fetchPage); vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { unmount?.(); unmount = undefined; vi.unstubAllGlobals(); });
const reply = (matches: any[], checked = 1, skipped = 0, nextCursor?: string) => new Response(JSON.stringify({ matches, checked, skipped, nextCursor, incomplete: !!nextCursor || skipped > 0 }));
const note = (id: string) => ({ id, title: id, relativePath: `00-Inbox/${id}.md` });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

function mount() {
  const output: { exports: any } = { exports: {} };
  const modal = { setup: (_props: any, ctx: any) => () => Vue.h('dialog-marker', ctx.slots.default?.()) };
  new Function('require', 'module', 'exports', source)((id: string) => {
    if (id === 'vue') return Vue;
    if (id === 'ant-design-vue') return { Modal: modal };
    throw Error('Unexpected backlinks dependency: ' + id);
  }, output, output.exports);
  const component = output.exports.default;
  component.render = output.exports.render;
  const renderer = Vue.createRenderer<any, any>({
    insert(node, parent, anchor) {
      if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
      const index = anchor ? parent.children.indexOf(anchor) : -1;
      parent.children.splice(index < 0 ? parent.children.length : index, 0, node); node.parent = parent;
    },
    remove(node) { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1); },
    createElement: type => ({ type, children: [], props: {} }), createText: text => ({ text, children: [] }), createComment: () => ({ children: [] }),
    setText: (node, text) => { node.text = text; }, setElementText: (node, text) => { node.text = text; node.children = []; },
    parentNode: node => node?.parent || null, nextSibling: node => node?.parent?.children[node.parent.children.indexOf(node) + 1] || null,
    patchProp(node, key, _old, value) { node.props[key] = value; },
  });
  const root: any = { children: [] }, target = Vue.ref('target-a'), opened: string[] = [];
  let closed = 0;
  const app = renderer.createApp({ setup: () => () => Vue.h(component, { noteId: target.value, onOpen: (id: string) => opened.push(id), onClose: () => closed++ }) });
  app.mount(root); unmount = () => app.unmount();
  const text = (node: any = root): string => (node.text || '') + (node.children || []).map((child: any) => text(child)).join('');
  const nodes = (node: any = root): any[] => [node, ...(node.children || []).flatMap((child: any) => nodes(child))];
  const click = (label: string) => {
    const button = nodes().find(node => node.type === 'button' && text(node).trim() === label);
    expect(button, `button ${label}`).toBeDefined(); button.props.onClick();
  };
  return { target, opened, get closed() { return closed; }, text, click };
}

it('waits for explicit continuation, appends results, reports skipped notes and emits note navigation', async () => {
  fetchPage.mockResolvedValueOnce(reply([note('first')], 49, 1, 'next-position'))
    .mockResolvedValueOnce(reply([note('second')], 3));
  const panel = mount();
  await vi.waitFor(() => expect(panel.text()).toContain('继续查找'));
  expect(fetchPage).toHaveBeenCalledTimes(1);
  expect(panel.text()).toContain('查找尚未完成');
  panel.click('继续查找');
  await vi.waitFor(() => expect(panel.text()).toContain('当前笔记清单已查完'));
  expect(panel.text()).toContain('跳过 1 篇');
  expect(panel.text()).toContain('first'); expect(panel.text()).toContain('second');
  expect(fetchPage.mock.calls[1][0]).toContain('cursor=next-position');
  panel.click('second00-Inbox/second.md');
  expect(panel.opened).toEqual(['second']);
  panel.click('关闭'); expect(panel.closed).toBe(1);
});

it('aborts an old note request and ignores a late response even when transport completes after cancellation', async () => {
  const old = deferred<Response>(), current = deferred<Response>();
  fetchPage.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  const panel = mount();
  const oldSignal = fetchPage.mock.calls[0][1].signal as AbortSignal;
  panel.target.value = 'target-b'; await Vue.nextTick();
  expect(oldSignal.aborted).toBe(true);
  current.resolve(reply([note('current')]));
  await vi.waitFor(() => expect(panel.text()).toContain('current'));
  old.resolve(reply([note('obsolete')])); await new Promise(resolve => setImmediate(resolve)); await Vue.nextTick();
  expect(panel.text()).not.toContain('obsolete');
  expect(panel.text()).toContain('current');
  panel.click('重新查找');
  const lastSignal = fetchPage.mock.calls.at(-1)![1].signal as AbortSignal;
  unmount?.(); unmount = undefined;
  expect(lastSignal.aborted).toBe(true);
});

it('retains found notes after a failed continuation and retries that same page', async () => {
  fetchPage.mockResolvedValueOnce(reply([note('retained')], 50, 0, 'retry-position'))
    .mockResolvedValueOnce(new Response(JSON.stringify({ error: '暂不可用' }), { status: 503 }))
    .mockResolvedValueOnce(reply([note('recovered')], 2));
  const panel = mount();
  await vi.waitFor(() => expect(panel.text()).toContain('继续查找'));
  panel.click('继续查找');
  await vi.waitFor(() => expect(panel.text()).toContain('暂不可用'));
  expect(panel.text()).toContain('retained');
  panel.click('重试本批');
  await vi.waitFor(() => expect(panel.text()).toContain('recovered'));
  expect(panel.text()).toContain('retained');
  expect(fetchPage.mock.calls[2][0]).toBe(fetchPage.mock.calls[1][0]);
});
