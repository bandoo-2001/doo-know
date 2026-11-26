import { gitAuthorIssue } from '../shared/git-author';
import { ApiError } from '../apps/web/api';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as Vue from 'vue';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const pending: (() => void)[] = [];
const call = vi.fn();
const a = 'a'.repeat(40);
function sourceModule() {
  const source = ts.transpileModule(
    readFileSync(new URL('../apps/web/git/commit-form.ts', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const output = { exports: {} as any };
  new Function('require', 'module', 'exports', source)(
    (id: string) => {
      if (id === 'vue') return Vue;
      if (id === 'naive-ui')
        return { NButton: 'button', NInput: 'input', NAlert: 'aside' };
      if (id.endsWith('GitAuthorForm.vue')) return { default: 'form', __esModule: true };
      if (id.endsWith('/git-author')) return { gitAuthorIssue };
      if (id === '../api') return { ApiError };
      if (id === '../features') return { features: Vue.ref({git: {config: {authorName: 'Fixture', authorEmail: 'fixture@example.invalid'}}}), featureAction: (_feature: string, ...args: unknown[]) => call(...args) };
      if (id === '../git-sync') return { gitError: (failure: Error) => failure.message };
      if (id === './status') return { refreshGitStatus: async () => {} };
      throw Error('Unexpected Git dependency: ' + id);
    },
    output,
    output.exports,
  );
  return output.exports;
}
async function mount() {
  const component = sourceModule().GitCommitForm;
  const setup = component.setup;
  let render!: () => Vue.VNode;
  component.setup = (props: any, context: any) => {
    render = setup(props, context);
    return () => null;
  };
  const renderer = Vue.createRenderer<any, any>({
    insert() {},
    remove() {},
    createElement: () => ({}),
    createText: () => ({}),
    createComment: () => ({}),
    setText() {},
    setElementText() {},
    parentNode: () => null,
    nextSibling: () => null,
    patchProp() {},
  });
  const app = renderer.createApp(component, {
    context: { noteId: 'note', expectedModifiedAt: 'v1' },
  });
  app.mount({});
  pending.push(() => app.unmount());
  await Vue.nextTick();
  const nodes = () => {
    const found: Vue.VNode[] = [];
    function visit(node: unknown) {
      if (!Vue.isVNode(node)) return;
      found.push(node);
      if (Array.isArray(node.children)) node.children.forEach(visit);
    }
    visit(render());
    return found;
  };
  const text = (node: Vue.VNode) =>
    typeof node.children === 'string'
      ? node.children
      : typeof (node.children as any)?.default === 'function'
        ? (node.children as any).default()
        : '';
  const buttons = (label: string) =>
    nodes().filter((node) => node.type === 'button' && text(node) === label);
  return {
    buttons,
    async click(label: string, index = 0) {
      const button = buttons(label)[index];
      expect(button, label + ' is available').toBeDefined();
      expect(button.props?.disabled, label + ' is enabled').not.toBe(true);
      await button.props!.onClick();
      await Vue.nextTick();
    },
    message(value: string) {
      const input = nodes().find((node) => node.type === 'input')!;
      expect(input.props?.disabled).not.toBe(true);
      input.props!['onUpdate:value'](value);
    },

  };
}
beforeEach(() => {
  vi.stubGlobal('window', new EventTarget());
  call.mockReset();
  call.mockImplementation(async (_kind: string, id: string, input: any) => {
    if (id === 'git.status')
      return { repository: 'ready', branch: 'main', changes: [], pending: [] };
    if (id === 'git.preview')
      return {
        token: 'preview-for-' + input.message,
        message: input.message.trim(),
        expiresAt: Date.now() + 300000,
        head: a,
        changes: [{ path: '00-Inbox/note.md', code: 'M' }],
        partialStaging: [],
      };
    if (id === 'git.commit') return { commit: a, needsReconciliation: false };
    if (id === 'git.diff') return { diff: 'Content at ' + input.commit };
    if (id === 'git.restore') return { noteId: 'note', modifiedAt: 'v2' };
    if (id === 'git.cancelPreview') return { cancelled: true };
    throw Error('Unexpected Git call: ' + id);
  });
});
afterEach(() => {
  for (const dispose of pending.splice(0)) dispose();
  vi.unstubAllGlobals();
});

it('requires a new preview after editing the commit message and commits the reviewed message', async () => {
  const view = await mount();
  view.message('First explanation');
  await view.click('预览全部变更');
  view.message('Corrected explanation');
  await Vue.nextTick();
  expect(view.buttons('确认提交').some((node) => !node.props?.disabled)).toBe(false);
  await view.click('预览全部变更');
  await view.click('确认提交');
  expect(call.mock.calls.find((entry) => entry[1] === 'git.commit')?.[2]).toMatchObject({
    token: 'preview-for-Corrected explanation',
  });
});
