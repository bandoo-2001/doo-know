import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as Vue from 'vue';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { gitDecoration } from '../plugins/git/web/decoration';
import { ApiError } from '../apps/web/api';

const pending: (() => void)[] = [];
const call = vi.fn();
const a = 'a'.repeat(40),
  b = 'b'.repeat(40);
const history = [
  { commit: a, author: 'Fixture', at: '2026-10-19T10:00:00Z', message: 'First version' },
  { commit: b, author: 'Fixture', at: '2026-10-19T11:00:00Z', message: 'Second version' },
];
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function sourceModule() {
  const source = ts.transpileModule(
    readFileSync(new URL('../plugins/git/web/index.ts', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const output = { exports: {} as any };
  new Function('require', 'module', 'exports', source)(
    (id: string) => {
      if (id === 'vue') return Vue;
      if (id === '@dooknow/plugin-ui')
        return { NButton: 'button', NInput: 'input', NAlert: 'aside' };
      if (id === './decoration') return { gitDecoration };
      throw Error('Unexpected plugin dependency: ' + id);
    },
    output,
    output.exports,
  );
  return output.exports;
}
async function mount(id: string) {
  const components = new Map<string, any>();
  const dispose = sourceModule().activate({
    registerComponent(name: string, component: any) {
      components.set(name, component);
      return () => components.delete(name);
    },
    call,
    notify: vi.fn(),
    notifyChanged: vi.fn(),
  });
  const component = components.get(id),
    setup = component.setup;
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
  pending.push(() => {
    app.unmount();
    dispose();
  });
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
    canRestore: () => buttons('恢复此版本').some((node) => !node.props?.disabled),
    difference: () =>
      nodes().find((node) => node.type === 'pre')?.children ??
      nodes().find((node) => node.props && 'diff' in node.props)?.props?.diff,
    notices: () =>
      nodes()
        .filter((node) => node.type === 'aside')
        .map(text),
  };
}
beforeEach(() => {
  vi.stubGlobal('window', new EventTarget());
  call.mockReset();
  call.mockImplementation(async (_kind: string, id: string, input: any) => {
    if (id === 'git.status')
      return { repository: 'ready', branch: 'main', changes: [], pending: [] };
    if (id === 'git.history') return { items: history };
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
    throw Error('Unexpected plugin call: ' + id);
  });
});
afterEach(() => {
  for (const dispose of pending.splice(0)) dispose();
  vi.unstubAllGlobals();
});

it('requires a new preview after editing the commit message and commits the reviewed message', async () => {
  const view = await mount('git.commitPanel');
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

it('withholds restoration until the newly selected difference has loaded', async () => {
  const view = await mount('git.history');
  await view.click('查看差异', 0);
  expect(view.difference()).toBe('Content at ' + a);
  const slow = deferred<{ diff: string }>();
  call.mockImplementationOnce(() => slow.promise);
  const switching = view.click('查看差异', 1);
  await Vue.nextTick();
  expect(view.canRestore()).toBe(false);
  slow.resolve({ diff: 'Second version contents' });
  await switching;
  expect(view.difference()).toBe('Second version contents');
  await view.click('恢复此版本');
  await view.click('确认恢复笔记');
  expect(call.mock.calls.find((entry) => entry[1] === 'git.restore')?.[2]).toMatchObject({
    commit: b,
  });
});

it('cancels an unsubmitted restoration without losing the selected difference or changing the note', async () => {
  const view = await mount('git.history');
  await view.click('查看差异', 0);
  await view.click('恢复此版本');
  const oldConfirmation = view.buttons('确认恢复笔记')[0].props!.onClick;

  await view.click('取消恢复');
  expect(view.buttons('确认恢复笔记')).toHaveLength(0);
  expect(view.difference()).toBe('Content at ' + a);
  expect(view.canRestore()).toBe(true);
  await oldConfirmation();
  expect(call.mock.calls.filter((entry) => entry[1] === 'git.restore')).toHaveLength(0);

  await view.click('恢复此版本');
  await view.click('确认恢复笔记');
  expect(call.mock.calls.filter((entry) => entry[1] === 'git.restore')).toHaveLength(1);
  expect(call.mock.calls.find((entry) => entry[1] === 'git.restore')?.[2]).toMatchObject({
    commit: a,
    expectedModifiedAt: 'v1',
  });
});

it('cannot dismiss an in-flight or uncertain restoration and reconciles its original request', async () => {
  const view = await mount('git.history');
  await view.click('查看差异', 0);
  await view.click('恢复此版本');
  const oldCancel = view.buttons('取消恢复')[0]?.props!.onClick;
  expect(oldCancel).toBeDefined();
  const response = deferred<unknown>();
  call.mockImplementationOnce(() => response.promise);
  const restoring = view.click('确认恢复笔记');
  await Vue.nextTick();
  const original = { ...call.mock.calls.find((entry) => entry[1] === 'git.restore')![2] };

  expect(view.buttons('取消恢复')[0]?.props?.disabled).toBe(true);
  await oldCancel();
  expect(view.buttons('核对恢复结果')).toHaveLength(1);
  response.reject(Error('connection interrupted before the restoration result was received'));
  await restoring;
  expect(view.buttons('取消恢复')[0]?.props?.disabled).toBe(true);
  await oldCancel();
  expect(view.buttons('核对恢复结果')).toHaveLength(1);
  expect(view.difference()).toBe('Content at ' + a);

  await view.click('核对恢复结果');
  const retried = call.mock.calls.filter((entry) => entry[1] === 'git.restore').at(-1)![2];
  expect(retried).toEqual(original);
  expect(view.buttons('取消恢复')).toHaveLength(0);
});

it('ignores an older difference response that arrives after the selected version', async () => {
  const view = await mount('git.history');
  const first = deferred<{ diff: string }>(),
    second = deferred<{ diff: string }>();
  call.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
  const choosingFirst = view.click('查看差异', 0);
  const choosingSecond = view.click('查看差异', 1);
  second.resolve({ diff: 'Second version contents' });
  await choosingSecond;
  first.resolve({ diff: 'First version contents' });
  await choosingFirst;
  expect(view.difference()).toBe('Second version contents');
  await view.click('恢复此版本');
  await view.click('确认恢复笔记');
  expect(call.mock.calls.find((entry) => entry[1] === 'git.restore')?.[2]).toMatchObject({
    commit: b,
  });
});

it('does not offer restoration when the chosen difference request fails', async () => {
  const view = await mount('git.history');
  await view.click('查看差异', 0);
  call.mockRejectedValueOnce(Error('difference unavailable'));
  await view.click('查看差异', 1);
  expect(view.canRestore()).toBe(false);
  await view.click('查看差异', 1);
  expect(view.difference()).toBe('Content at ' + b);
  expect(view.canRestore()).toBe(true);
});

it.each([
  ['GIT_RESTORE_UNSUPPORTED', '当前笔记'],
  ['GIT_RESTORE_VERSION_TOO_LARGE', '历史版本'],
  ['GIT_VERSION_NOT_FOUND', '文件'],
])(
  'explains %s before restoration while preserving historical differences',
  async (code, reason) => {
    const view = await mount('git.history');
    call.mockResolvedValueOnce({
      diff: 'Readable historical change',
      restore: { supported: false, code },
    });
    await view.click('查看差异', 0);
    expect(view.difference()).toBe('Readable historical change');
    expect(view.canRestore()).toBe(false);
    expect(view.notices().join(' ')).toContain(reason);
    expect(view.notices().join(' ')).not.toMatch(/重新读取笔记/);
    await view.click('查看差异', 1);
    expect(view.canRestore()).toBe(true);
  },
);

it('keeps a truncated difference viewable and honors the separate restoration limit', async () => {
  const view = await mount('git.history');
  call.mockResolvedValueOnce({
    diff: '',
    truncated: true,
    restore: { supported: false, code: 'GIT_RESTORE_VERSION_TOO_LARGE' },
  });
  await view.click('查看差异');
  expect(view.difference()).toMatch(/差异超过/);
  expect(view.canRestore()).toBe(false);
  expect(view.notices().join(' ')).toMatch(/历史版本.*1 MiB/);
});

it.each([
  'GIT_RESTORE_UNSUPPORTED',
  'GIT_RESTORE_VERSION_TOO_LARGE',
  'GIT_VERSION_NOT_FOUND',
  'GIT_OUTPUT_TOO_LARGE',
  'LARGE_FILE_MODE_REQUIRED',
])('does not suggest reloading can repair the deterministic restore rejection %s', async (code) => {
  const view = await mount('git.history');
  await view.click('查看差异');
  await view.click('恢复此版本');
  call.mockRejectedValueOnce(new ApiError(409, { code, error: code, retryable: false }));
  await view.click('确认恢复笔记');
  expect(view.canRestore()).toBe(false);
  expect(view.notices().join(' ')).toMatch(/无法|没有可恢复|不支持/);
  expect(view.notices().join(' ')).not.toMatch(/重新读取笔记/);
  expect(view.notices().join(' ')).not.toContain(code);
  expect(view.buttons('核对恢复结果')).toHaveLength(0);
  await view.click('查看差异', 1);
  expect(view.canRestore()).toBe(true);
});

it('allows choosing another version after a confirmed rejection without reusing stale note metadata', async () => {
  const view = await mount('git.history');
  await view.click('查看差异', 0);
  await view.click('恢复此版本');
  const oldConfirmation = view.buttons('确认恢复笔记')[0].props!.onClick;
  call.mockRejectedValueOnce(
    new ApiError(409, {
      code: 'VERSION_CONFLICT',
      error: 'VERSION_CONFLICT',
      retryable: false,
    }),
  );
  await view.click('确认恢复笔记');
  expect(view.buttons('核对恢复结果')).toHaveLength(0);
  await view.click('查看差异', 1);
  expect(view.difference()).toBe('Content at ' + b);
  expect(view.canRestore()).toBe(false);
  expect(view.notices().some((text) => /重新读取笔记/.test(text) && /草稿/.test(text))).toBe(true);
  await oldConfirmation();
  expect(call.mock.calls.filter((entry) => entry[1] === 'git.restore')).toHaveLength(1);
});

it('retries an interrupted restoration with its original request and prevents changing the commit', async () => {
  const view = await mount('git.history');
  await view.click('查看差异', 0);
  await view.click('恢复此版本');
  call.mockRejectedValueOnce(Error('connection interrupted before a complete response'));
  await view.click('确认恢复笔记');
  const original = { ...call.mock.calls.find((entry) => entry[1] === 'git.restore')![2] };
  await view.click('查看差异', 1);
  expect(view.difference()).toBe('Content at ' + a);
  expect(call.mock.calls.filter((entry) => entry[1] === 'git.restore')).toHaveLength(1);
  await view.click('核对恢复结果');
  const retried = call.mock.calls.filter((entry) => entry[1] === 'git.restore').at(-1)![2];
  expect(retried).toEqual(original);
  expect(retried).toMatchObject({
    commit: a,
    expectedModifiedAt: 'v1',
    requestId: expect.any(String),
  });
  await view.click('查看差异', 1);
  expect(view.difference()).toBe('Content at ' + b);
});
