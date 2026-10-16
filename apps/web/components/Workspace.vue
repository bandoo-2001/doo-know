<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue';
import { NButton, NInput, NModal, NAlert, NSelect } from 'naive-ui';
import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';
import type { NoteDocument, TreeEntry } from '../../../shared/contracts';
import { api, ApiError, resetCsrf } from '../api';
import Icon from './Icon.vue';
import TreeBranch from './TreeBranch.vue';
import MarkdownEditor from './MarkdownEditor.vue';
import LargeFileWorkspace from './LargeFileWorkspace.vue';
import IndexStatus from './IndexStatus.vue';
import SearchRuntimeSettings from './SearchRuntimeSettings.vue';
import PluginManager from './PluginManager.vue';
import PluginSlot from './PluginSlot.vue';
import PluginPanel from './PluginPanel.vue';
import { refreshPlugins, disposePluginUIs } from '../plugins';
import type {
  NoteInfo,
  FileReply,
  OutlinePage,
  FileOperation,
  SearchOutput,
} from '../../../shared/knowledge-contracts';
const noteInfo = ref<NoteInfo>(),
  largeRef = ref<InstanceType<typeof LargeFileWorkspace>>(),
  largeDirty = ref(false);
const initialNoteId = new URLSearchParams(window.location.search).get('note');
const parsedLine = Number(window.location.hash.match(/^#L([1-9]\d*)$/)?.[1]);
const initialLine =
  Number.isSafeInteger(parsedLine) && parsedLine <= 20 * 1024 * 1024 ? parsedLine : undefined;
const emit = defineEmits<{ logout: [] }>();
const tree = ref<TreeEntry[]>([]),
  note = ref<NoteDocument>(),
  folder = ref(''),
  selected = ref(''),
  draft = ref(''),
  savedContent = ref(''),
  mode = ref<'edit' | 'preview' | 'split'>('split'),
  drawer = ref(true),
  busy = ref(false),
  error = ref(''),
  notice = ref('');
const query = ref(''),
  searchCursor = ref<string>(),
  results = ref<any[]>([]),
  assets = ref<any[]>([]);
let viewEpoch = 0;
const currentView = (id: string, epoch: number) => note.value?.id === id && viewEpoch === epoch;
let searchTimer: ReturnType<typeof setTimeout>;
let noticeTimer: ReturnType<typeof setTimeout>;
const dirty = computed(
  () => !!note.value && (largeDirty.value || draft.value !== savedContent.value),
);
const pluginContext = computed(() => ({
  noteId: note.value?.id,
  relativePath: note.value?.relativePath,
  expectedModifiedAt: note.value?.modifiedAt,
  folderPath: folder.value,
  note: { selected: !!note.value, dirty: dirty.value },
  workspace: { ready: true },
}));
let pluginTimer: ReturnType<typeof setInterval> | undefined;
function pluginNotice(event: Event) {
  tell((event as CustomEvent).detail.message);
}
function workspaceChanged(event: Event) {
  const id = (event as CustomEvent).detail.noteId;
  void run(async () => {
    await refresh();
    if (id && note.value?.id === id) {
      if (dirty.value) tell('原文已更新，当前未保存草稿会保留，请重新核对版本');
      else await openNote(id);
    }
  });
}
const md = new MarkdownIt({ html: false, linkify: true });
const flatten = (items: TreeEntry[]): TreeEntry[] =>
  items.flatMap((x) => [x, ...(x.children ? flatten(x.children) : [])]);
const flat = computed(() => flatten(tree.value));
const folders = computed(() => [
  { label: '知识库根目录', value: '' },
  ...flat.value.filter((x) => x.type === 'folder').map((x) => ({ label: x.path, value: x.path })),
]);
const folderEntries = computed(() => {
  if (!folder.value) return tree.value;
  return flat.value.find((x) => x.path === folder.value)?.children || [];
});
function localPath(url: string) {
  try {
    const base = note.value?.relativePath || '';
    const target = new URL(url, `https://notes.invalid/${base}`).pathname;
    return decodeURIComponent(target.slice(1));
  } catch {
    return '';
  }
}
const preview = computed(() => {
  const tokens = md.parse(draft.value, {});
  const visit = (list: typeof tokens) => {
    for (const t of list) {
      if (t.type === 'image' || t.type === 'link_open') {
        const attr = t.type === 'image' ? 'src' : 'href',
          url = String(t.attrGet(attr) || '');
        const path = localPath(url),
          asset = assets.value.find((a) => a.relativePath === path),
          target = flat.value.find((x) => x.type === 'note' && x.path === path);
        if (asset) t.attrSet(attr, `/api/assets/${asset.id}`);
        else if (target && t.type === 'link_open') t.attrSet(attr, `#note-${target.id}`);
        else if (url.startsWith('#')) {
        } else if (t.type === 'link_open' && /^https?:\/\//i.test(url)) {
          t.attrSet('target', '_blank');
          t.attrSet('rel', 'noopener noreferrer');
        } else t.attrSet(attr, '');
      }
      if (t.children) visit(t.children);
    }
  };
  visit(tokens);
  return DOMPurify.sanitize(md.renderer.render(tokens, md.options, {}));
});
function tell(s: string) {
  notice.value = s;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (notice.value = ''), 4000);
}
async function run(fn: () => Promise<void>) {
  error.value = '';
  try {
    await fn();
  } catch (e) {
    error.value = (e as Error).message;
  }
}
async function refresh() {
  tree.value = await api('/api/tree');
}
async function openNote(id: string) {
  await guard(async () => {
    const epoch = ++viewEpoch;
    let meta = await api<NoteInfo>(`/api/notes/${id}/meta`);
    if (meta.readState === 'unknown' && meta.sizeBytes <= 1024 * 1024) {
      const prep = await api<FileReply<OutlinePage>>(`/api/notes/${id}/outline`);
      if (prep.kind === 'accepted') {
        let op = prep.operation;
        while (['queued', 'running'].includes(op.status)) {
          await new Promise((r) => setTimeout(r, 1000));
          if (epoch !== viewEpoch) return;
          op = await api<FileOperation>(`/api/operations/${op.operationId}`);
        }
      }
      meta = await api<NoteInfo>(`/api/notes/${id}/meta`);
    }
    const n: NoteDocument =
      meta.editorMode === 'full'
        ? await api<NoteDocument>(`/api/notes/${id}`)
        : {
            id: meta.id,
            title: meta.title,
            relativePath: meta.relativePath,
            content: '',
            modifiedAt: meta.modifiedAt,
            updatedAt: new Date().toISOString(),
            shared: meta.shared,
          };
    const attachments = await api<any[]>(`/api/notes/${id}/assets`).catch(() => []);
    if (epoch !== viewEpoch) return;
    note.value = n;
    noteInfo.value = meta;
    largeDirty.value = false;
    draft.value = n.content;
    savedContent.value = n.content;
    selected.value = n.relativePath;
    folder.value = n.relativePath.includes('/')
      ? n.relativePath.split('/').slice(0, -1).join('/')
      : '';
    assets.value = attachments;
    drawer.value = false;
    panel.value = 'note';
  });
}
async function select(entry: TreeEntry) {
  await run(async () => {
    if (entry.type === 'note') await openNote(entry.id!);
    else
      await guard(async () => {
        viewEpoch++;
        folder.value = entry.path;
        selected.value = entry.path;
        note.value = undefined;
        drawer.value = false;
        panel.value = 'folder';
      });
  });
}
async function all() {
  await run(() =>
    guard(async () => {
      const epoch = ++viewEpoch;
      await refresh();
      if (epoch !== viewEpoch) return;
      folder.value = '';
      selected.value = '';
      note.value = undefined;
      panel.value = 'folder';
      drawer.value = false;
    }),
  );
}
const leaveOpen = ref(false);
let pendingNavigation: (() => Promise<void>) | undefined;
async function guard(fn: () => Promise<void>) {
  if (dirty.value) {
    pendingNavigation = fn;
    leaveOpen.value = true;
  } else await fn();
}
async function leave(action: 'save' | 'discard' | 'cancel') {
  if (action === 'cancel') {
    leaveOpen.value = false;
    pendingNavigation = undefined;
    return;
  }
  if (action === 'save') {
    await save();
    if (dirty.value) return;
  } else {
    draft.value = savedContent.value;
    largeRef.value?.discard();
    largeDirty.value = false;
  }
  leaveOpen.value = false;
  const fn = pendingNavigation;
  pendingNavigation = undefined;
  if (fn) await run(fn);
}
const conflict = ref<{ version: string; opened: string; content: string; revisionId?: string }>(),
  latest = ref(''),
  latestOpen = ref(false);
const pendingSave = ref<{
  noteId: string;
  requestId: string;
  content: string;
  expected: string;
  revisionId?: string;
}>();
async function onLargeSaved(meta: NoteInfo) {
  const epoch = viewEpoch;
  if (!currentView(meta.id, epoch)) return;
  if (meta.editorMode === 'full') {
    try {
      const document = await api<NoteDocument>(`/api/notes/${meta.id}`);
      if (!currentView(meta.id, epoch)) return;
      note.value = document;
      draft.value = document.content;
      savedContent.value = document.content;
      largeDirty.value = false;
      noteInfo.value = meta;
    } catch {
      if (currentView(meta.id, epoch))
        error.value = '片段已保存；读取普通编辑器正文失败，请重新打开笔记';
    }
  } else {
    noteInfo.value = meta;
    note.value!.modifiedAt = meta.modifiedAt;
    note.value!.title = meta.title;
  }
}
async function checkSave() {
  const pending = pendingSave.value,
    epoch = viewEpoch;
  if (!pending) return;
  const op = await api<FileOperation & { result?: { modifiedAt: string } }>(
    `/api/operations?requestId=${encodeURIComponent(pending.requestId)}`,
  );
  if (op.status === 'succeeded') {
    if (note.value && currentView(pending.noteId, epoch)) {
      const meta = await api<NoteInfo>(`/api/notes/${pending.noteId}/meta`);
      if (!currentView(pending.noteId, epoch)) {
        pendingSave.value = undefined;
        return;
      }
      noteInfo.value = meta;
      if (meta.editorMode === 'full') {
        if (pending.revisionId) {
          const document = await api<NoteDocument>(`/api/notes/${pending.noteId}`);
          if (!currentView(pending.noteId, epoch)) {
            pendingSave.value = undefined;
            return;
          }
          note.value = document;
          draft.value = note.value.content;
          savedContent.value = note.value.content;
        } else {
          note.value.modifiedAt = op.result?.modifiedAt || note.value.modifiedAt;
          savedContent.value = pending.content;
        }
      } else {
        note.value.modifiedAt = meta.modifiedAt;
        draft.value = '';
        savedContent.value = '';
        await nextTick();
        await largeRef.value?.reload();
      }
    }
    pendingSave.value = undefined;
    tell('保存结果已确认');
    return;
  }
  if (['failed', 'cancelled'].includes(op.status)) {
    pendingSave.value = undefined;
    throw new Error('上次操作未完成，草稿已保留');
  }
  throw new Error('操作仍在处理，请稍后核对');
}
async function save(expected?: string, content?: string, revisionId?: string) {
  if (!note.value || busy.value) return;
  if (noteInfo.value?.editorMode !== 'full' && !revisionId) {
    await largeRef.value?.save();
    return;
  }
  busy.value = true;
  error.value = '';
  const target = note.value,
    epoch = viewEpoch;
  const text = content ?? draft.value;
  try {
    if (pendingSave.value) {
      await checkSave();
      if (pendingSave.value) return;
    }
    const requestId = crypto.randomUUID();
    pendingSave.value = {
      noteId: target.id,
      requestId,
      content: text,
      expected: expected || target.modifiedAt,
      revisionId,
    };
    let n: any = revisionId
      ? await api<NoteDocument>(`/api/notes/${target.id}/revisions/${revisionId}/restore`, 'POST', {
          expectedModifiedAt: expected || target.modifiedAt,
          requestId,
        })
      : await api<NoteDocument>(`/api/notes/${target.id}`, 'PUT', {
          content: text,
          expectedModifiedAt: expected || target.modifiedAt,
          requestId,
        });
    if (n?.kind === 'accepted') {
      let op = n.operation as FileOperation;
      while (['queued', 'running', 'committing'].includes(op.status)) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (!currentView(target.id, epoch)) return;
        op = await api<FileOperation>(`/api/operations/${op.operationId}`);
      }
      if (op.status !== 'succeeded')
        throw new Error(
          op.status === 'needs_reconciliation'
            ? '保存结果需要核对，请保留草稿'
            : '历史恢复未完成，请保留草稿',
        );
      const meta = await api<NoteInfo>(`/api/notes/${target.id}/meta`);
      if (!currentView(target.id, epoch)) return;
      noteInfo.value = meta;
      n =
        meta.editorMode === 'full'
          ? await api<NoteDocument>(`/api/notes/${target.id}`)
          : { ...target, title: meta.title, modifiedAt: meta.modifiedAt, content: '' };
      await nextTick();
      await largeRef.value?.reload();
    }
    if (n.editorMode && currentView(target.id, epoch)) {
      noteInfo.value = n;
      if (n.editorMode !== 'full') {
        n = { ...target, title: n.title, modifiedAt: n.modifiedAt, content: '' };
        draft.value = '';
        await nextTick();
        await largeRef.value?.reload();
      }
    }
    if (!currentView(target.id, epoch)) {
      await refresh();
      return;
    }
    pendingSave.value = undefined;
    note.value = n;
    savedContent.value = n.content;
    if (revisionId) draft.value = n.content;
    conflict.value = undefined;
    tell(revisionId ? '历史版本已恢复' : '笔记已保存');
    await refresh();
  } catch (e) {
    if (
      e instanceof ApiError &&
      e.status >= 400 &&
      e.status < 500 &&
      !e.data.retryable &&
      !['OPERATION_OUTCOME_UNKNOWN', 'OPERATION_IN_PROGRESS'].includes(String(e.data.code))
    )
      pendingSave.value = undefined;
    if (!currentView(target.id, epoch)) return;
    if (
      e instanceof ApiError &&
      e.data.code === 'VERSION_CONFLICT' &&
      typeof e.data.currentModifiedAt === 'string'
    )
      conflict.value = {
        version: String(e.data.currentModifiedAt),
        opened: target.modifiedAt,
        content: text,
        revisionId,
      };
    else error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
function time(v: string) {
  try {
    return new Date(Number(BigInt(v) / 1000000n)).toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
    });
  } catch {
    return v;
  }
}
async function confirmConflict() {
  const c = conflict.value;
  if (c) await save(c.version, c.content, c.revisionId);
}
async function viewLatest() {
  const id = note.value!.id,
    epoch = viewEpoch;
  await run(async () => {
    const n = await api<NoteDocument>(`/api/notes/${id}`);
    if (!currentView(id, epoch)) return;
    latest.value = n.content;
    latestOpen.value = true;
  });
}
const shareOpen = ref(false),
  share = ref<{ enabled: boolean; token?: string; url?: string }>({ enabled: false });
const shareUrl = computed(() =>
  share.value.url ? new URL(share.value.url, location.origin).href : '',
);
async function manageShare() {
  const id = note.value!.id,
    epoch = viewEpoch;
  await run(async () => {
    const response = await api(`/api/notes/${id}/share`);
    if (!currentView(id, epoch)) return;
    share.value = response;
    shareOpen.value = true;
  });
}
async function shareAction(action: 'create' | 'reset' | 'revoke') {
  const id = note.value!.id,
    epoch = viewEpoch;
  await run(async () => {
    const base = `/api/notes/${id}/share`;
    const response = await api(
      base + (action === 'reset' ? '/reset' : ''),
      action === 'revoke' ? 'DELETE' : 'POST',
      action === 'revoke' ? undefined : {},
    );
    if (!currentView(id, epoch)) return;
    share.value = response;
    note.value!.shared = share.value.enabled;
    tell(
      action === 'revoke' ? '分享已取消' : action === 'reset' ? '旧链接已失效' : '分享链接已生成',
    );
  });
}
async function copyShare() {
  await run(async () => {
    await navigator.clipboard.writeText(shareUrl.value);
    tell('链接已复制');
  });
}
const createOpen = ref(false),
  createKind = ref<'note' | 'folder'>('note'),
  newName = ref(''),
  newFolder = ref('');
let createRequestId = crypto.randomUUID();
function create(kind: 'note' | 'folder') {
  createRequestId = crypto.randomUUID();
  createKind.value = kind;
  newFolder.value =
    folder.value || (folders.value.some((x) => x.value === '00-Inbox') ? '00-Inbox' : '');
  newName.value = kind === 'note' && !newFolder.value ? 'README.md' : '';
  createOpen.value = true;
}
async function submitCreate() {
  await run(async () => {
    if (createKind.value === 'folder') {
      await api('/api/folders', 'POST', { parent: newFolder.value, name: newName.value });
      await refresh();
      createOpen.value = false;
      tell('文件夹已创建');
    } else {
      await guard(async () => {
        const name = newName.value.endsWith('.md') ? newName.value : newName.value + '.md';
        const epoch = viewEpoch;
        let n: NoteDocument;
        try {
          n = await api<NoteDocument>('/api/notes', 'POST', {
            folderPath: newFolder.value,
            fileName: name,
            content: `# ${newName.value.replace(/\.md$/, '')}\n\n`,
            requestId: createRequestId,
          });
        } catch (e) {
          if (e instanceof ApiError && e.status >= 400 && e.status < 500)
            createRequestId = crypto.randomUUID();
          throw e;
        }
        createOpen.value = false;
        await refresh();
        if (epoch !== viewEpoch) {
          tell('笔记已创建，可在目录中打开');
          return;
        }
        await openNote(n.id);
      });
    }
  });
}
const panel = ref<'folder' | 'note' | 'trash' | 'settings'>('folder'),
  revisionsOpen = ref(false),
  revisions = ref<any[]>([]),
  revisionCursor = ref<string>(),
  trash = ref<any[]>([]),
  deleteOpen = ref(false);
async function history(more = false) {
  const id = note.value!.id,
    epoch = viewEpoch;
  await run(async () => {
    const response = await api(
      `/api/notes/${id}/revisions` +
        (more && revisionCursor.value ? `?cursor=${encodeURIComponent(revisionCursor.value)}` : ''),
    );
    if (!currentView(id, epoch)) return;
    revisions.value = more ? [...revisions.value, ...response.items] : response.items;
    revisionCursor.value = response.nextCursor;
    revisionsOpen.value = true;
  });
}
async function restoreRevision(r: any) {
  await guard(async () => {
    await save(note.value!.modifiedAt, r.content, r.id);
    if (!conflict.value) revisionsOpen.value = false;
  });
}
async function readRevision(r: any) {
  let reply = await api<FileReply<import('../../../shared/knowledge-contracts').ReadPage>>(
    `/api/notes/${note.value!.id}/revisions/${r.id}/read`,
    'POST',
    r.cursor ? { cursor: r.cursor } : {},
  );
  if (reply.kind === 'accepted') {
    let op = reply.operation;
    while (['queued', 'running'].includes(op.status)) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      op = await api(`/api/operations/${op.operationId}`);
    }
    reply = await api(`/api/notes/${note.value!.id}/revisions/${r.id}/read`, 'POST', {});
  }
  if (reply.kind === 'ready') {
    r.content = reply.data.content;
    r.cursor = reply.data.nextCursor;
  }
}
async function openTrash() {
  await run(() =>
    guard(async () => {
      const epoch = ++viewEpoch;
      const response = await api('/api/trash');
      if (epoch !== viewEpoch) return;
      trash.value = response;
      panel.value = 'trash';
      note.value = undefined;
      drawer.value = false;
    }),
  );
}
const pendingDelete = ref<{ noteId: string; expectedModifiedAt: string; requestId: string }>();
async function finishDelete(id: string, epoch: number) {
  pendingDelete.value = undefined;
  deleteOpen.value = false;
  if (currentView(id, epoch)) {
    viewEpoch++;
    note.value = undefined;
    draft.value = '';
    savedContent.value = '';
    panel.value = 'folder';
  }
  await refresh();
  tell('已移入回收站');
}
async function checkDelete() {
  const pending = pendingDelete.value;
  if (!pending) return;
  const epoch = viewEpoch;
  let op: { status: string };
  try {
    op = await api(`/api/operations?requestId=${encodeURIComponent(pending.requestId)}`);
  } catch (e) {
    if (!(e instanceof ApiError) || e.data.code !== 'OPERATION_NOT_FOUND') throw e;
    // The original request may not have reached the server: retry its immutable payload.
    await api(`/api/notes/${pending.noteId}`, 'DELETE', pending);
    await finishDelete(pending.noteId, epoch);
    return;
  }
  if (op.status === 'succeeded') return finishDelete(pending.noteId, epoch);
  if (['failed', 'cancelled'].includes(op.status)) {
    pendingDelete.value = undefined;
    throw new Error('删除未完成，原笔记保留；请重新读取后再确认');
  }
  throw new Error('删除结果待核对，请保留原请求标识');
}
async function removeNote() {
  await run(async () => {
    if (pendingDelete.value) return checkDelete();
    const target = note.value!,
      epoch = viewEpoch;
    const pending = {
      noteId: target.id,
      expectedModifiedAt: target.modifiedAt,
      requestId: crypto.randomUUID(),
    };
    pendingDelete.value = pending;
    try {
      await api(`/api/notes/${target.id}`, 'DELETE', pending);
      await finishDelete(target.id, epoch);
    } catch (e) {
      if (e instanceof ApiError && e.status >= 400 && e.status < 500 && !e.data.retryable) {
        pendingDelete.value = undefined;
        deleteOpen.value = false;
      }
      if (e instanceof ApiError && e.data.code === 'VERSION_CONFLICT')
        throw new Error('笔记已更新，删除被拒绝。请重新打开笔记后再确认');
      throw e;
    }
  });
}
const restoreTarget = ref<any>(),
  restoreName = ref('');
const pendingRestore = new Map<string, { requestId: string; fileName?: string }>();
async function restoreTrash(item: any, fileName?: string) {
  await run(async () => {
    try {
      let input = pendingRestore.get(item.id);
      if (!input || input.fileName !== fileName) {
        input = { requestId: crypto.randomUUID(), ...(fileName ? { fileName } : {}) };
        pendingRestore.set(item.id, input);
      }
      await api(`/api/notes/${item.id}/restore`, 'POST', input);
      pendingRestore.delete(item.id);
      restoreTarget.value = undefined;
      trash.value = await api('/api/trash');
      await refresh();
      tell('已恢复，笔记保持私有');
    } catch (e) {
      if (e instanceof ApiError && e.data.code === 'NAME_CONFLICT') {
        pendingRestore.delete(item.id);
        restoreTarget.value = item;
        restoreName.value = '';
      } else throw e;
    }
  });
}
async function settings() {
  await guard(async () => {
    viewEpoch++;
    panel.value = 'settings';
    note.value = undefined;
    drawer.value = false;
  });
}
const currentPassword = ref(''),
  newPassword = ref('');
async function changePassword() {
  await run(async () => {
    await api('/api/auth/change-password', 'POST', {
      currentPassword: currentPassword.value,
      newPassword: newPassword.value,
      revokeOtherSessions: true,
    });
    currentPassword.value = '';
    newPassword.value = '';
    tell('密码已修改，其他会话已撤销');
  });
}
async function logout() {
  await guard(async () => {
    await api('/api/auth/sign-out', 'POST', {});
    viewEpoch++;
    resetCsrf();
    tree.value = [];
    note.value = undefined;
    draft.value = '';
    emit('logout');
  });
}
const uploadInput = ref<HTMLInputElement>();
async function upload(event: Event) {
  const input = event.target as HTMLInputElement,
    file = input.files?.[0];
  if (!file || !note.value) return;
  const id = note.value.id,
    epoch = viewEpoch;
  await run(async () => {
    const data = new FormData();
    data.append('file', file);
    const a = await api(`/api/notes/${id}/assets`, 'POST', data);
    const attachments = await api(`/api/notes/${id}/assets`);
    if (!currentView(id, epoch)) {
      tell('附件已上传，可返回原笔记插入链接');
      return;
    }
    assets.value = attachments;
    draft.value += `\n${a.mime === 'application/pdf' ? '[' : '!['}${file.name}](${a.markdownPath})\n`;
    tell('附件已插入，请手动保存笔记');
  });
  input.value = '';
}
function clickPreview(event: MouseEvent) {
  const a = (event.target as HTMLElement).closest('a');
  if (a?.getAttribute('href')?.startsWith('#note-')) {
    event.preventDefault();
    void run(() => openNote(a.getAttribute('href')!.slice(6)));
  }
}
async function searchPage(q: string, cursor?: string): Promise<SearchOutput | undefined> {
  let response: SearchOutput;
  try {
    response = await api<SearchOutput>('/api/search/advanced', 'POST', {
      query: '"' + q + '"',
      mode: 'text',
      ...(cursor ? { cursor } : {}),
    });
  } catch (e) {
    if (
      cursor &&
      e instanceof ApiError &&
      (e.data.code === 'CURSOR_EXPIRED' || (e.data.error as any)?.code === 'CURSOR_EXPIRED')
    ) {
      tell('索引已更新，搜索结果已重新加载');
      return searchPage(q);
    }
    throw e;
  }
  if (query.value !== q) return;
  const items = response.results.map((r) => ({
    id: r.noteId,
    title: r.title,
    relativePath: r.relativePath,
    snippet: r.matches[0]?.snippet || '',
  }));
  results.value = cursor ? [...results.value, ...items] : items;
  searchCursor.value = response.nextCursor;
  return response;
}
watch(query, (q) => {
  clearTimeout(searchTimer);
  searchCursor.value = undefined;
  results.value = [];
  if (!q.trim()) {
    results.value = [];
    return;
  }
  let attempts = 0;
  const search = () =>
    void run(async () => {
      const response = await searchPage(q);
      if (
        response &&
        !results.value.length &&
        ++attempts < 15 &&
        (response.index.pending || attempts < 3)
      )
        searchTimer = setTimeout(search, 1000);
    });
  searchTimer = setTimeout(search, 220);
});
function shortcut(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    void save();
  }
}
function unload(e: BeforeUnloadEvent) {
  if (dirty.value) {
    e.preventDefault();
    e.returnValue = '';
  }
}
onMounted(() => {
  void refreshPlugins().catch(() => {});
  pluginTimer = setInterval(() => {
    void refreshPlugins().catch(() => {});
  }, 5000);
  window.addEventListener('dooknow-workspace-changed', workspaceChanged);
  window.addEventListener('dooknow-notice', pluginNotice);
  void run(async () => {
    await refresh();
    const id = new URLSearchParams(window.location.search).get('note');
    if (id) await openNote(id);
  });
  window.addEventListener('keydown', shortcut);
  window.addEventListener('beforeunload', unload);
});
onBeforeUnmount(() => {
  clearInterval(pluginTimer);
  void disposePluginUIs();
  window.removeEventListener('dooknow-workspace-changed', workspaceChanged);
  window.removeEventListener('dooknow-notice', pluginNotice);
  clearTimeout(searchTimer);
  clearTimeout(noticeTimer);
  window.removeEventListener('keydown', shortcut);
  window.removeEventListener('beforeunload', unload);
});
</script>
<template>
  <div class="workspace">
    <div v-if="drawer" class="drawer-scrim" @click="drawer = false"></div>
    <aside :class="['sidebar', { open: drawer }]" aria-label="笔记导航">
      <div class="brand">
        <Icon name="book" :size="31" /><strong>DooKnow</strong
        ><button class="mobile-only icon-button" aria-label="关闭侧栏" @click="drawer = false">
          <Icon name="close" />
        </button>
      </div>
      <div class="sidebar-actions">
        <NInput
          v-model:value="query"
          clearable
          placeholder="搜索笔记与目录"
          aria-label="搜索笔记与目录"
          ><template #prefix><Icon name="search" :size="17" /></template></NInput
        ><NButton type="primary" block @click="create('note')"
          ><template #icon><Icon name="plus" /></template>新建笔记</NButton
        >
      </div>
      <button class="nav-action" @click="all"><Icon name="file" />全部笔记</button>
      <PluginSlot slot-name="navigation" :context="pluginContext" />
      <PluginSlot slot-name="libraryAction" :context="pluginContext" />
      <IndexStatus :note-id="note?.id" />
      <div class="tree-heading">
        <span>{{ query ? '搜索结果' : '笔记本' }}</span
        ><button class="icon-button" aria-label="新建文件夹" @click="create('folder')">
          <Icon name="plus" /></button
        ><button class="icon-button" aria-label="刷新目录" @click="run(refresh)">
          <Icon name="refresh" :size="17" />
        </button>
      </div>
      <div class="tree-scroll">
        <template v-if="query"
          ><button
            v-for="r in results"
            :key="r.id"
            class="search-result"
            @click="run(() => openNote(r.id))"
          >
            <b>{{ r.title }}</b
            ><small>{{ r.relativePath }}</small
            ><span>{{ r.snippet }}</span>
          </button>
          <p v-if="results.length" class="muted">已显示 {{ results.length }} 篇</p>
          <NButton
            v-if="searchCursor"
            :loading="busy"
            @click="
              run(async () => {
                await searchPage(query, searchCursor);
              })
            "
            >加载更多搜索结果</NButton
          >
          <p v-if="!results.length" class="muted empty-search">没有匹配的笔记</p></template
        ><TreeBranch v-else :entries="tree" :selected="selected" @select="select" />
      </div>
      <div class="sidebar-footer">
        <button class="nav-action" @click="openTrash"><Icon name="trash" />回收站</button
        ><button class="nav-action" @click="settings"><Icon name="settings" />设置</button
        ><button class="nav-action account-row" @click="logout">
          <span class="avatar">个人</span><span>个人账户</span><Icon name="logout" :size="18" />
        </button>
      </div>
    </aside>
    <main class="main-content">
      <div class="mobile-bar">
        <button class="icon-button" aria-label="打开侧栏" @click="drawer = true">
          <Icon name="menu" /></button
        ><b>DooKnow</b><span>{{ dirty ? '未保存' : '私人笔记' }}</span>
      </div>
      <NAlert v-if="error" type="error" closable @close="error = ''" class="global-error">{{
        error
      }}</NAlert>
      <template v-if="note && panel === 'note'"
        ><header class="note-header">
          <div class="note-topline">
            <span class="breadcrumb" :title="note.relativePath">{{
              note.relativePath.split('/').join('　/　')
            }}</span>
            <div class="toolbar">
              <PluginSlot slot-name="noteAction" :context="pluginContext" />
              <NButton v-if="pendingSave?.noteId === note.id" @click="run(checkSave)"
                >核对保存结果</NButton
              >
              <NButton v-if="pendingDelete && !deleteOpen" @click="run(checkDelete)"
                >核对删除结果</NButton
              >
              <NButton title="历史版本" aria-label="历史版本" @click="history()"
                ><Icon name="clock" /></NButton
              ><NButton
                title="插入图片或 PDF"
                aria-label="插入图片或 PDF"
                @click="uploadInput?.click()"
                ><Icon name="image" /></NButton
              ><NButton title="删除笔记" aria-label="删除笔记" @click="deleteOpen = true"
                ><Icon name="trash" /></NButton
              ><NButton @click="manageShare"
                ><template #icon><Icon name="share" /></template>分享</NButton
              ><NButton
                v-if="noteInfo?.editorMode === 'full'"
                type="primary"
                :loading="busy"
                @click="save()"
                ><template #icon><Icon name="save" /></template>保存
                <span class="shortcut">Ctrl+S</span></NButton
              >
            </div>
          </div>
          <h1>{{ note.title }}</h1>
          <div v-if="note.shared" class="shared-status">
            <Icon name="share" :size="14" />已分享，保存后的修改将同步公开
          </div>
          <div v-if="noteInfo?.editorMode === 'full'" class="mode-row">
            <div class="mode-tabs">
              <button :class="{ active: mode === 'edit' }" @click="mode = 'edit'">编辑</button
              ><button :class="{ active: mode === 'preview' }" @click="mode = 'preview'">
                预览</button
              ><button :class="{ active: mode === 'split' }" @click="mode = 'split'">分屏</button>
            </div>
            <span :class="['save-state', { dirty }]"
              >● {{ busy ? '保存中' : dirty ? '未保存' : '已保存' }}</span
            >
          </div>
        </header>
        <LargeFileWorkspace
          v-if="noteInfo && noteInfo.editorMode !== 'full'"
          ref="largeRef"
          :note="noteInfo"
          :assets="assets"
          :initial-line="note.id === initialNoteId ? initialLine : undefined"
          :key="note.id"
          @dirty="(v) => (largeDirty = v)"
          @saved="onLargeSaved" />
        <div v-else :class="['editor-panels', mode]">
          <section v-if="mode !== 'preview'" class="editor-panel">
            <div class="panel-label">Markdown <span>UTF-8</span></div>
            <MarkdownEditor
              v-model="draft"
              :key="note.id"
              :initial-line="note.id === initialNoteId ? initialLine : undefined"
            />
          </section>
          <section v-if="mode !== 'edit'" class="preview-panel">
            <div class="panel-label">预览 <Icon name="eye" :size="16" /></div>
            <div class="markdown" v-html="preview" @click="clickPreview"></div>
          </section>
        </div>
        <input
          ref="uploadInput"
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp,application/pdf"
          hidden
          @change="upload"
      /></template>
      <section v-else-if="panel === 'folder'" class="folder-view">
        <header class="folder-header">
          <span class="breadcrumb">{{
            folder ? folder.split('/').join('　/　') : '知识空间'
          }}</span>
          <h1>{{ folder ? folder.split('/').at(-1) : '全部笔记' }}</h1>
          <div class="folder-info">
            <span
              >{{ folderEntries.filter((x) => x.type === 'folder').length }} 个文件夹 ·
              {{ folderEntries.filter((x) => x.type === 'note').length }} 篇笔记</span
            ><NButton @click="create('folder')"
              ><template #icon><Icon name="plus" /></template>新建文件夹</NButton
            >
          </div>
        </header>
        <table class="folder-table">
          <thead>
            <tr>
              <th>名称</th>
              <th>类型</th>
              <th>修改时间</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="entry in folderEntries" :key="entry.path">
              <td>
                <button @click="select(entry)">
                  <Icon :name="entry.type === 'folder' ? 'folder' : 'file'" :size="23" /><span>{{
                    entry.name
                  }}</span>
                </button>
              </td>
              <td>{{ entry.type === 'folder' ? '文件夹' : 'Markdown' }}</td>
              <td :title="entry.path">
                {{
                  entry.updatedAt
                    ? new Date(entry.updatedAt).toLocaleString('zh-CN', {
                        timeZone: 'Asia/Shanghai',
                      })
                    : '—'
                }}
              </td>
            </tr>
          </tbody>
        </table>
        <div class="folder-empty">
          <Icon name="file" :size="44" />
          <p>
            {{ folderEntries.length ? '选择文件即可打开编辑' : '这里还没有笔记，记录第一个想法吧' }}
          </p>
          <NButton v-if="!folderEntries.length" type="primary" @click="create('note')"
            >新建笔记</NButton
          >
        </div>
      </section>
      <section v-else-if="panel === 'trash'" class="utility-view">
        <h1>回收站</h1>
        <p class="muted">恢复后笔记保持私有；原位置被占用时，不会覆盖已有文件。</p>
        <div v-for="item in trash" :key="item.id" class="utility-row">
          <Icon name="file" /><span>{{ item.relativePath }}</span
          ><NButton @click="restoreTrash(item)">恢复</NButton>
        </div>
        <p v-if="!trash.length" class="muted">回收站为空</p>
      </section>
      <section v-else class="utility-view settings-view">
        <h1>个人设置</h1>
        <h2>修改密码</h2>
        <p class="muted">修改后撤销其他会话。密码至少 12 位。</p>
        <form @submit.prevent="changePassword">
          <label>当前密码</label
          ><NInput
            v-model:value="currentPassword"
            type="password"
            autocomplete="current-password"
            :input-props="{ 'aria-label': '当前密码' }"
          /><label>新密码</label
          ><NInput
            v-model:value="newPassword"
            type="password"
            autocomplete="new-password"
            :input-props="{ 'aria-label': '新密码' }"
          /><NButton type="primary" attr-type="submit">修改密码</NButton>
        </form>
        <SearchRuntimeSettings /><PluginManager />
        <NButton @click="logout">退出登录</NButton>
      </section>
    </main>
    <PluginPanel />
    <div v-if="notice" class="toast" role="status">
      <Icon name="check" :size="18" />{{ notice }}
    </div>
    <NModal
      :show="!!conflict"
      preset="card"
      class="dialog-card"
      title="原文件已更新"
      :mask-closable="false"
      :on-close="() => (conflict = undefined)"
      ><template v-if="conflict"
        ><p>这篇笔记在其他地方被修改，是否覆盖最新版本？</p>
        <div class="version-box">
          <div>
            <span>打开时的版本</span><time>{{ time(conflict.opened) }}</time>
          </div>
          <div>
            <span>当前文件版本</span><time>{{ time(conflict.version) }}</time>
          </div>
        </div>
        <p class="muted">取消后会保留当前编辑内容。</p>
        <div class="dialog-actions">
          <NButton @click="conflict = undefined">取消</NButton
          ><NButton @click="viewLatest">查看最新版本</NButton
          ><NButton type="warning" :loading="busy" @click="confirmConflict">确定覆盖</NButton>
        </div></template
      ></NModal
    >
    <NModal v-model:show="latestOpen" preset="card" class="dialog-card" title="最新已保存原文">
      <pre class="latest-source">{{ latest }}</pre>
    </NModal>
    <NModal v-model:show="shareOpen" preset="card" class="dialog-card share-dialog" title="分享笔记"
      ><h3>
        {{ note?.title }}
        <span class="share-badge">{{ share.enabled ? '分享已开启' : '私人笔记' }}</span>
      </h3>
      <template v-if="share.enabled"
        ><label>公开链接</label>
        <div class="share-link">
          <NInput :value="shareUrl" readonly :input-props="{ 'aria-label': '公开链接' }" /><NButton
            type="primary"
            @click="copyShare"
            >复制链接</NButton
          >
        </div>
        <p class="muted">任何获得链接的人都可以查看这篇笔记。</p></template
      >
      <p v-else>笔记默认私有。生成链接后，持有链接的访客可只读查看。</p>
      <div class="share-info">
        <Icon name="refresh" :size="27" />
        <div>
          <b>实时更新</b>
          <p>展示最新保存内容，未保存的修改不会公开。</p>
        </div>
      </div>
      <div class="dialog-actions">
        <template v-if="share.enabled"
          ><NButton @click="shareAction('reset')">重置链接</NButton
          ><NButton type="error" quaternary @click="shareAction('revoke')"
            >取消分享</NButton
          ></template
        ><NButton v-else type="primary" @click="shareAction('create')">生成分享链接</NButton
        ><NButton @click="shareOpen = false">完成</NButton>
      </div></NModal
    >
    <NModal
      v-model:show="createOpen"
      preset="card"
      class="dialog-card"
      :title="createKind === 'note' ? '新建笔记' : '新建文件夹'"
      ><form @submit.prevent="submitCreate">
        <label>所在目录</label
        ><NSelect v-model:value="newFolder" :options="folders" filterable /><label>{{
          createKind === 'note' ? '文件名' : '文件夹名'
        }}</label
        ><NInput
          v-model:value="newName"
          :input-props="{ 'aria-label': createKind === 'note' ? '文件名' : '文件夹名' }"
          :placeholder="createKind === 'note' ? '例如：新的想法.md' : '例如：读书笔记'"
        />
        <p class="muted">
          {{
            !newFolder
              ? createKind === 'note'
                ? '根目录仅支持 README.md；其他笔记请先创建分类目录。'
                : '根目录请使用 00-Inbox、10-Projects 等标准分类名称。'
              : createKind === 'note'
                ? '创建后保存为真实 Markdown 文件，默认私有。'
                : '在所选目录中创建子文件夹。'
          }}
        </p>
        <div class="dialog-actions">
          <NButton @click="createOpen = false">取消</NButton
          ><NButton attr-type="submit" type="primary" :disabled="!newName.trim()">创建</NButton>
        </div>
      </form></NModal
    >
    <NModal
      v-model:show="leaveOpen"
      preset="card"
      class="dialog-card"
      title="当前笔记尚未保存"
      :mask-closable="false"
      ><p>离开前，请选择如何处理当前编辑内容。</p>
      <div class="dialog-actions">
        <NButton @click="leave('cancel')">取消</NButton
        ><NButton @click="leave('discard')">放弃修改</NButton
        ><NButton type="primary" @click="leave('save')">保存并继续</NButton>
      </div></NModal
    >
    <NModal v-model:show="deleteOpen" preset="card" class="dialog-card" title="移入回收站？"
      ><p>已保存原文将移入回收站，分享立即失效。{{ dirty ? '当前未保存输入将被放弃。' : '' }}</p>
      <div class="dialog-actions">
        <NButton @click="deleteOpen = false">取消</NButton
        ><NButton v-if="pendingDelete" @click="run(checkDelete)">核对删除结果</NButton
        ><NButton v-else type="error" @click="removeNote">移入回收站</NButton>
      </div></NModal
    >
    <NModal v-model:show="revisionsOpen" preset="card" class="dialog-card" title="历史版本"
      ><p class="muted">恢复前会保留当前原文，并检查版本是否变化。</p>
      <div v-for="r in revisions" :key="r.id" class="revision-item">
        <div class="utility-row">
          <span>{{
            new Date(r.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
          }}</span
          ><NButton @click="restoreRevision(r)">恢复此版本</NButton>
        </div>
        <details>
          <summary>查看原文</summary>
          <NButton @click="run(() => readRevision(r))">{{
            r.cursor ? '下一片段' : '加载片段'
          }}</NButton>
          <pre>{{ r.content }}</pre>
        </details>
      </div>
      <NButton v-if="revisionCursor" :loading="busy" @click="history(true)">加载更早版本</NButton>
      <p v-if="revisions.length" class="muted">已显示 {{ revisions.length }} 个版本</p>
      <p v-if="!revisions.length">尚无历史版本</p></NModal
    >
    <NModal
      :show="!!restoreTarget"
      preset="card"
      class="dialog-card"
      title="原位置已被占用"
      :on-close="() => (restoreTarget = undefined)"
      ><p>请输入新文件名恢复，现有文件不会被覆盖。</p>
      <NInput v-model:value="restoreName" placeholder="新文件名.md" />
      <div class="dialog-actions">
        <NButton type="primary" @click="restoreTrash(restoreTarget, restoreName)"
          >使用新名称恢复</NButton
        >
      </div></NModal
    >
  </div>
</template>
