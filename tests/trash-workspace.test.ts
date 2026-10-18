import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { beforeEach, expect, it, vi } from 'vitest';
import { parse, compileScript } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as Vue from 'vue';
import { ApiError } from '../apps/web/api';
const nodeRequire = createRequire(import.meta.url);
const memory = new Map<string, string>();
const mockApi = vi.fn();
const sample = (id = 'n1') => ({
  id,
  title: id,
  relativePath: `00-Inbox/${id}.md`,
  deletedAt: null,
  sizeBytes: null,
  available: true,
});
const page = (
  items = [sample()],
  snapshotId = 'snapshot-one',
  nextCursor: string | null = null,
) => ({ items, snapshotId, nextCursor });
async function mount() {
  const file = new URL('../apps/web/components/TrashWorkspace.vue', import.meta.url);
  const descriptor = parse(readFileSync(file, 'utf8')).descriptor;
  const compiled = compileScript(descriptor, { id: 'trash-workspace-test' });
  const source = ts.transpileModule(compiled.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const output: { exports: any } = { exports: {} };
  new Function('require', 'module', 'exports', source)(
    (id: string) =>
      id === 'vue'
        ? Vue
        : id === '../api'
          ? { api: mockApi, ApiError }
          : id === 'ant-design-vue'
            ? {}
            : nodeRequire(id),
    output,
    output.exports,
  );
  const component = output.exports.default,
    original = component.setup;
  let state: any;
  component.setup = (props: any, ctx: any) => {
    state = original(props, ctx);
    return state;
  };
  component.render = () => null;
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
  const events: { event: string; id?: string }[] = [];
  const app = renderer.createApp(component, {
    'onOpen-note': (id: string) => events.push({ event: 'open-note', id }),
    onChanged: () => events.push({ event: 'changed' }),
  });
  app.mount({});
  await vi.waitFor(() => expect(state.loading.value).toBe(false));
  return { state, events, close: () => app.unmount() };
}
beforeEach(() => {
  mockApi.mockReset();
  memory.clear();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
    removeItem: (key: string) => memory.delete(key),
  });
  mockApi.mockImplementation(async (url: string) =>
    url === '/api/auth/get-session' ? { user: { id: 'fixture-owner' } } : page(),
  );
});
it('reuses the original request after a lost restore response, including across remounts', async () => {
  const first = await mount();
  mockApi.mockRejectedValueOnce(new ApiError(0, { error: 'response lost' }));
  await first.state.restore(['n1'], 'n1');
  const submitted = mockApi.mock.calls.at(-1)![2];
  expect(first.state.pending.value.input.requestId).toBe(submitted.requestId);
  expect(first.events).toEqual([]);
  const beforeBlockedAttempt = mockApi.mock.calls.length;
  await first.state.restore(['n1']);
  expect(mockApi.mock.calls.length).toBe(beforeBlockedAttempt);
  first.close();
  const second = await mount();
  expect(second.state.pending.value.input).toEqual(submitted);
  mockApi.mockImplementation(async (url: string, _method: string, body: any) =>
    url === '/api/manage/trash/restore'
      ? { results: body.ids.map((id: string) => ({ id, ok: true })) }
      : page([]),
  );
  await second.state.retryPending();
  const retried = [...mockApi.mock.calls]
    .reverse()
    .find((call) => call[0] === '/api/manage/trash/restore')![2];
  expect(retried).toEqual(submitted);
  expect(second.events).toContainEqual({ event: 'open-note', id: 'n1' });
  expect(second.events).toContainEqual({ event: 'changed' });
  expect(second.state.pending.value).toBeUndefined();
  second.close();
});
it('retries only confirmed failed restore items, preserving rename decisions without duplicates', async () => {
  mockApi.mockImplementation(async (url: string) =>
    url === '/api/auth/get-session'
      ? { user: { id: 'fixture-owner' } }
      : page([sample('n1'), sample('n2')]),
  );
  const f = await mount();
  mockApi.mockImplementation(async (url: string) =>
    url === '/api/manage/trash/restore'
      ? {
          results: [
            { id: 'n1', ok: true },
            { id: 'n2', ok: false, code: 'NAME_CONFLICT' },
          ],
        }
      : page([sample('n2')]),
  );
  await f.state.restore(['n1', 'n2']);
  const original = [...mockApi.mock.calls]
    .reverse()
    .find((call) => call[0] === '/api/manage/trash/restore')![2];
  f.state.renames.value.n2 = 'another.md';
  mockApi.mockImplementation(async (url: string, _method: string, body: any) =>
    url === '/api/manage/trash/restore'
      ? { results: body.ids.map((id: string) => ({ id, ok: true })) }
      : page([]),
  );
  await f.state.retryFailures();
  const retry = [...mockApi.mock.calls]
    .reverse()
    .find((call) => call[0] === '/api/manage/trash/restore')![2];
  expect(retry.ids).toEqual(['n2']);
  expect(retry.fileNames).toEqual({ n2: 'another.md' });
  expect(retry.requestId).not.toBe(original.requestId);
  f.close();
});
it('pins permanent removal to the displayed page and requires typed confirmation', async () => {
  const f = await mount();
  f.state.openPurge(['n1']);
  await f.state.confirmPurge();
  expect(mockApi.mock.calls.some((call) => call[0] === '/api/manage/trash/purge')).toBe(false);
  f.state.purgeConfirmation.value = '永久移除';
  mockApi.mockImplementation(async (url: string, _method: string, body: any) =>
    url === '/api/manage/trash/purge'
      ? {
          results: body.ids.map((id: string) => ({ id, ok: true })),
          scope: 'selected-trash-source-files',
          retained: ['history', 'backups', 'metadata'],
        }
      : page([]),
  );
  await f.state.confirmPurge();
  const input = [...mockApi.mock.calls]
    .reverse()
    .find((call) => call[0] === '/api/manage/trash/purge')![2];
  expect(input).toMatchObject({
    ids: ['n1'],
    snapshotId: 'snapshot-one',
    confirm: 'PERMANENTLY_DELETE',
  });
  expect(f.events).toContainEqual({ event: 'changed' });
  f.close();
});
it('keeps unknown metadata unknown and resets selections when moving between snapshot pages', async () => {
  mockApi.mockImplementation(async (url: string) =>
    url === '/api/auth/get-session'
      ? { user: { id: 'fixture-owner' } }
      : page([sample()], 'snapshot-one', 'page-two'),
  );
  const f = await mount();
  expect(f.state.formatTime(null)).toBe('删除时间未知');
  expect(f.state.formatSize(null)).toBe('大小未知');
  expect(f.state.formatSize(0)).toBe('0 B');
  f.state.selected.value = ['n1'];
  mockApi.mockResolvedValueOnce(page([sample('n2')], 'snapshot-two'));
  await f.state.nextPage();
  expect(f.state.selected.value).toEqual([]);
  f.state.openPurge(['n2']);
  expect(f.state.purgeDraft.value.snapshotId).toBe('snapshot-two');
  f.close();
});
it('requires fresh confirmation after an unsent or rejected purge snapshot expires', async () => {
  const first = await mount();
  first.state.openPurge(['n1']);
  first.state.purgeConfirmation.value = '永久移除';
  mockApi.mockRejectedValueOnce(new ApiError(0, { error: 'response lost' }));
  await first.state.confirmPurge();
  const original = first.state.pending.value.input;
  first.close();
  mockApi.mockImplementation(async (url: string) =>
    url === '/api/auth/get-session'
      ? { user: { id: 'fixture-owner' } }
      : page([sample()], 'fresh-snapshot'),
  );
  const second = await mount();
  expect(second.state.pending.value.input.snapshotId).toBe(original.snapshotId);
  mockApi.mockRejectedValueOnce(new ApiError(409, { code: 'TRASH_SNAPSHOT_EXPIRED' }));
  await second.state.retryPending();
  expect(second.state.pending.value).toBeUndefined();
  second.state.openPurge(['n1']);
  expect(second.state.purgeDraft.value.snapshotId).toBe('fresh-snapshot');
  expect(second.state.purgeConfirmation.value).toBe('');
  second.close();
});
it('cancels a rename draft so a hidden field cannot silently change a later restore', async () => {
  const f = await mount();
  f.state.beginRename(sample());
  f.state.renames.value.n1 = 'hidden-name.md';
  f.state.closeRename('n1');
  expect(f.state.renames.value.n1).toBeUndefined();
  expect(f.state.renameOpen.value).not.toContain('n1');
  mockApi.mockImplementation(async (url: string, _method: string, body: any) =>
    url === '/api/manage/trash/restore'
      ? { results: body.ids.map((id: string) => ({ id, ok: true })) }
      : page([]),
  );
  await f.state.restore(['n1']);
  const request = [...mockApi.mock.calls]
    .reverse()
    .find((call) => call[0] === '/api/manage/trash/restore')![2];
  expect(request.fileNames).toBeUndefined();
  f.close();
});
it('keeps the exact purge scope and request when workspace maintenance is busy', async () => {
  const f = await mount();
  f.state.openPurge(['n1']);
  f.state.purgeConfirmation.value = '永久移除';
  mockApi.mockRejectedValueOnce(new ApiError(503, { code: 'WORKSPACE_BUSY' }));
  await f.state.confirmPurge();
  const original = [...mockApi.mock.calls]
    .reverse()
    .find((call) => call[0] === '/api/manage/trash/purge')![2];
  expect(f.state.mutationError.value).toBe(
    '知识库正在执行其他维护操作，请稍后按原请求重试。当前选择范围已保留。',
  );
  expect(f.state.pending.value.input).toEqual(original);
  expect(f.events).toEqual([]);
  mockApi.mockImplementation(async (url: string, _method: string, body: any) =>
    url === '/api/manage/trash/purge'
      ? {
          results: body.ids.map((id: string) => ({ id, ok: true })),
          scope: 'selected-trash-source-files',
          retained: ['history', 'backups', 'metadata'],
        }
      : page([]),
  );
  await f.state.retryPending();
  const retry = [...mockApi.mock.calls]
    .reverse()
    .find((call) => call[0] === '/api/manage/trash/purge')![2];
  expect(retry).toEqual(original);
  expect(f.state.pending.value).toBeUndefined();
  expect(f.events).toContainEqual({ event: 'changed' });
  f.close();
});
