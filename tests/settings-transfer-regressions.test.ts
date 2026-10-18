import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as Vue from 'vue';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as pagedRecords from '../apps/web/components/settings/paged-records';
import * as transferFiles from '../apps/web/components/settings/transfer-files';
const nodeRequire = createRequire(import.meta.url),
  mockApi = vi.fn();
const cleanups: (() => void)[] = [];
const childEmits = new Map<string, (event: string) => void>();
const states = new Map<string, any>();
function component(name: string, realChildren: string[] = []): any {
  const descriptor = parse(
    readFileSync(
      new URL('../apps/web/components/settings/' + name + '.vue', import.meta.url),
      'utf8',
    ),
  ).descriptor;
  const script = compileScript(descriptor, { id: name });
  const template = compileTemplate({
    source: descriptor.template!.content,
    filename: name + '.vue',
    id: name,
    compilerOptions: { bindingMetadata: script.bindings },
  });
  const source = ts.transpileModule(script.content + '\n' + template.code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const output: { exports: any } = { exports: {} };
  const stub = (id: string) => ({
    setup(_props: any, ctx: any) {
      childEmits.set(id, ctx.emit);
      return () => null;
    },
  });
  new Function('require', 'module', 'exports', source)(
    (id: string) => {
      if (id === 'vue') return Vue;
      if (id === '../../api') return { api: mockApi };
      if (id === 'ant-design-vue')
        return new Proxy(
          {},
          { get: () => Object.assign(stub('ant'), { Password: stub('password') }) },
        );
      if (id === './transfer-files') return transferFiles;
      if (id === './paged-records') return pagedRecords;
      if (id === './download') return { downloadRecoveryKey: vi.fn() };
      if (id.endsWith('.vue')) {
        const child = id.replace(/^\.\//, '').replace(/\.vue$/, '');
        return {
          default: realChildren.includes(child) ? component(child, realChildren) : stub(child),
        };
      }
      return nodeRequire(id);
    },
    output,
    output.exports,
  );
  const compiled = output.exports.default,
    setup = compiled.setup;
  compiled.setup = (props: any, ctx: any) => {
    const state = setup(props, ctx);
    states.set(name, state);
    return state;
  };
  compiled.render = output.exports.render;
  return compiled;
}
async function mount(
  name: string,
  props: Record<string, unknown> = {},
  realChildren: string[] = [],
) {
  const liveProps = Vue.reactive(props),
    events: string[] = [];
  const renderer = Vue.createRenderer<any, any>({
    insert(node, parent, anchor) {
      if (node.parent) {
        const old = node.parent.children.indexOf(node);
        if (old >= 0) node.parent.children.splice(old, 1);
      }
      parent.children ||= [];
      const index = anchor ? parent.children.indexOf(anchor) : -1;
      parent.children.splice(index < 0 ? parent.children.length : index, 0, node);
      node.parent = parent;
    },
    remove(node) {
      if (node?.parent) {
        const index = node.parent.children.indexOf(node);
        if (index >= 0) node.parent.children.splice(index, 1);
        node.parent = null;
      }
    },
    createElement: () => ({ children: [] }),
    createText: () => ({}),
    createComment: () => ({}),
    setText() {},
    setElementText() {},
    parentNode: (node) => node?.parent || null,
    nextSibling: (node) => node?.parent?.children[node.parent.children.indexOf(node) + 1] || null,
    patchProp() {},
  });
  const root = component(name, realChildren);
  const app = renderer.createApp({
    setup: () => () => Vue.h(root, { ...liveProps, onChanged: () => events.push('changed') }),
  });
  app.mount({});
  cleanups.push(() => app.unmount());
  await Vue.nextTick();
  await vi.waitFor(() => expect(states.get(name)?.loading?.value || false).toBe(false));
  return {
    get state() {
      return states.get(name);
    },
    props: liveProps,
    events,
  };
}
const task = (id: string, state = 'queued') => ({
  id,
  kind: 'import',
  state,
  createdAt: '2026-10-19',
  updatedAt: '2026-10-19',
  cancellable: true,
  progress: { completed: 0, total: 1, phase: state },
  downloadAvailable: false,
});
const backup = (id: string) => ({ id, createdAt: '2026-10-19', bytes: 1, encrypted: true });
beforeEach(() => {
  mockApi.mockReset();
  childEmits.clear();
  states.clear();
  mockApi.mockResolvedValue({ items: [] });
});
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});
it('uses a rerendered folder prop for preview and submission and invalidates the old preview', async () => {
  mockApi.mockImplementation(async (url: string) =>
    url.endsWith('/preview') ? { items: [], warnings: [], totalBytes: 1 } : task('import1'),
  );
  const f = await mount('TransferPanel', { folderPath: '30-Knowledge/a' });
  f.state.entries.value = [{ path: 'x.md', content: '# x', encoding: 'utf8' }];
  await f.state.inspect();
  mockApi.mockRejectedValueOnce(Error('response lost'));
  await f.state.execute();
  const original = mockApi.mock.calls
    .filter((call) => call[0] === '/api/manage/import')
    .at(-1)?.[2].requestId;
  f.props.folderPath = '40-Resources/b';
  await Vue.nextTick();
  expect(f.state.folder.value).toBe('40-Resources/b');
  expect(f.state.preview.value).toBeUndefined();
  await f.state.inspect();
  await f.state.execute();
  const submitted = mockApi.mock.calls
    .filter((call) => call[0] === '/api/manage/import')
    .at(-1)?.[2];
  expect(submitted.folderPath).toBe('40-Resources/b');
  expect(submitted.requestId).not.toBe(original);
});
it('discards a stale preview response when its target changes while a request is busy', async () => {
  let resolve!: (value: any) => void;
  mockApi.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const f = await mount('TransferPanel', { folderPath: '30-Knowledge/a' });
  f.state.entries.value = [{ path: 'x.md', content: '# x', encoding: 'utf8' }];
  const pending = f.state.inspect();
  f.props.folderPath = '40-Resources/b';
  await Vue.nextTick();
  resolve({ items: [], warnings: [], totalBytes: 1 });
  await pending;
  expect(f.state.folder.value).toBe('40-Resources/b');
  expect(f.state.preview.value).toBeUndefined();
  expect(f.state.notice.value).toContain('重新预览');
});
it('forwards actual task completion through TransferPanel, LibrarySettings and SettingsWorkspace', async () => {
  mockApi.mockResolvedValue({ library: { ready: true, timeZone: 'UTC' } });
  const f = await mount('SettingsWorkspace', { section: 'library', username: 'owner' }, [
    'LibrarySettings',
    'TransferPanel',
  ]);
  childEmits.get('TransferTasks')!('changed');
  await Vue.nextTick();
  expect(f.events).toEqual(['changed']);
});
it('keeps loaded task pages and the final cursor when polling and reports a completion once', async () => {
  mockApi.mockImplementation(async (url: string) =>
    url.includes('cursor=first')
      ? { items: [task('old')], nextCursor: 'tail' }
      : { items: [task('new')], nextCursor: 'first' },
  );
  const f = await mount('TransferTasks');
  await f.state.refresh(true);
  mockApi.mockImplementation(async (url: string) =>
    url.includes('cursor=first')
      ? { items: [task('old', 'succeeded')], nextCursor: 'tail' }
      : { items: [task('new')], nextCursor: 'first' },
  );
  await f.state.refresh(false);
  await f.state.refresh(false);
  expect(f.state.tasks.value.map((item: any) => item.id)).toEqual(['new', 'old']);
  expect(f.state.tasks.value[1].state).toBe('succeeded');
  expect(f.state.cursor.value).toBe('tail');
  expect(f.events).toEqual(['changed']);
});
it('deduplicates overlapping task page boundaries', async () => {
  mockApi
    .mockResolvedValueOnce({ items: [task('new')], nextCursor: 'first' })
    .mockResolvedValueOnce({ items: [task('new'), task('old')], nextCursor: 'tail' });
  const f = await mount('TransferTasks');
  await f.state.refresh(true);
  expect(f.state.tasks.value.map((item: any) => item.id)).toEqual(['new', 'old']);
});
it('retains loaded backup records and cursor during task-triggered refreshes', async () => {
  mockApi.mockImplementation(async (url: string) =>
    url.includes('cursor=first')
      ? { items: [backup('old')], nextCursor: 'tail' }
      : { items: [backup('new')], nextCursor: 'first' },
  );
  const f = await mount('BackupSettings');
  await f.state.load(true);
  await f.state.load(false);
  expect(f.state.items.value.map((item: any) => item.id)).toEqual(['new', 'old']);
  expect(f.state.cursor.value).toBe('tail');
});
it('reports the original destination if it changes during an already submitted import', async () => {
  let finish!: (value: any) => void;
  mockApi.mockImplementation(async (url: string) =>
    url.endsWith('/preview')
      ? { items: [], warnings: [], totalBytes: 1 }
      : new Promise((done) => {
          finish = done;
        }),
  );
  const f = await mount('TransferPanel', { folderPath: '30-Knowledge/a' });
  f.state.entries.value = [{ path: 'x.md', content: '# x', encoding: 'utf8' }];
  await f.state.inspect();
  const pending = f.state.execute();
  f.props.folderPath = '40-Resources/b';
  await Vue.nextTick();
  finish(task('submitted'));
  await pending;
  expect(
    mockApi.mock.calls.filter((call) => call[0] === '/api/manage/import').at(-1)?.[2].folderPath,
  ).toBe('30-Knowledge/a');
  expect(f.state.folder.value).toBe('40-Resources/b');
  expect(f.state.preview.value).toBeUndefined();
  expect(f.state.notice.value).toContain('原位置「30-Knowledge/a」');
  expect(f.state.notice.value).toContain('重新预览');
});
it('retains previously opened tasks when new head records arrive and a later-page refresh fails', async () => {
  mockApi.mockImplementation(async (url: string) =>
    url.includes('cursor=first')
      ? { items: [task('old')], nextCursor: 'tail' }
      : { items: [task('new')], nextCursor: 'first' },
  );
  const f = await mount('TransferTasks');
  await f.state.refresh(true);
  mockApi.mockImplementation(async (url: string) => {
    if (url.includes('cursor=first')) throw Error('temporarily unavailable');
    return { items: [task('newest')], nextCursor: 'new' };
  });
  await f.state.refresh();
  expect(f.state.tasks.value.map((item: any) => item.id)).toEqual(['new', 'old']);
  expect(f.state.cursor.value).toBe('tail');
  mockApi.mockImplementation(async (url: string) =>
    url.includes('cursor=first')
      ? { items: [task('old')], nextCursor: 'tail' }
      : url.includes('cursor=new')
        ? { items: [task('new')], nextCursor: 'first' }
        : { items: [task('newest')], nextCursor: 'new' },
  );
  await f.state.refresh();
  expect(f.state.tasks.value.map((item: any) => item.id)).toEqual(['newest', 'new', 'old']);
  expect(f.state.cursor.value).toBe('tail');
  await f.state.refresh(false, true);
  expect(f.state.tasks.value.map((item: any) => item.id)).toEqual(['newest']);
  expect(f.state.cursor.value).toBe('new');
});
it('reports a partially successful import once and does not report a wholly failed import as a content change', async () => {
  mockApi.mockResolvedValue({ items: [task('partial'), task('failed')] });
  const f = await mount('TransferTasks');
  mockApi.mockResolvedValue({
    items: [
      { ...task('partial', 'failed'), items: [{ state: 'succeeded' }] },
      task('failed', 'failed'),
    ],
  });
  await f.state.refresh();
  await f.state.refresh();
  expect(f.events).toEqual(['changed']);
});
it('does not attach an old destination preview error to the newly selected destination', async () => {
  let fail!: (error: Error) => void;
  mockApi.mockImplementation(
    () =>
      new Promise((_done, reject) => {
        fail = reject;
      }),
  );
  const f = await mount('TransferPanel', { folderPath: '30-Knowledge/a' });
  const pending = f.state.inspect();
  f.props.folderPath = '40-Resources/b';
  await Vue.nextTick();
  fail(Error('old destination unavailable'));
  await pending;
  expect(f.state.error.value).toBe('');
  expect(f.state.notice.value).toContain('重新预览');
});
it('refreshes backup records on the final task update even when updates arrive within five seconds', async () => {
  mockApi.mockResolvedValue({ items: [backup('first')] });
  const f = await mount('BackupSettings');
  mockApi.mockResolvedValue({ items: [backup('second'), backup('first')] });
  f.state.taskUpdated();
  await vi.waitFor(() => expect(f.state.loading.value).toBe(false));
  mockApi.mockResolvedValue({ items: [backup('completed'), backup('second'), backup('first')] });
  f.state.taskUpdated();
  await vi.waitFor(() => expect(f.state.loading.value).toBe(false));
  expect(f.state.items.value.map((item: any) => item.id)).toContain('completed');
});
it('refreshes a previous page boundary record after a new head shifts the cursor chain', async () => {
  const records = [task('4'), task('3'), task('2'), task('1')];
  mockApi.mockImplementation(async (url: string) => {
    const cursor = new URL(url, 'http://fixture').searchParams.get('cursor');
    const start = cursor ? records.findIndex((item) => item.id === cursor) + 1 : 0;
    const items = records.slice(start, start + 2).map((item) => ({ ...item }));
    return { items, ...(start + 2 < records.length ? { nextCursor: items.at(-1)!.id } : {}) };
  });
  const f = await mount('TransferTasks');
  await f.state.refresh(true);
  records.unshift(task('5'));
  records.find((item) => item.id === '3')!.state = 'succeeded';
  await f.state.refresh();
  expect(f.state.tasks.value.map((item: any) => item.id)).toEqual(['5', '4', '3', '2', '1']);
  expect(f.state.tasks.value.find((item: any) => item.id === '3').state).toBe('succeeded');
  expect(f.state.cursor.value).toBeUndefined();
  expect(f.events).toEqual(['changed']);
});
