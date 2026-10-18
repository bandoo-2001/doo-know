<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue';
import { NInput, NModal, NAlert, NSelect } from 'naive-ui';
import {
  Button as AButton,
  Input as AInput,
  Alert as AAlert,
  Select as ASelect,
  Popover as APopover,
} from 'ant-design-vue';
import MarkdownIt from 'markdown-it';
import { markdownStyles } from '../../../shared/markdown-styles';
import DOMPurify from 'dompurify';
import type { NoteDocument, TreeEntry } from '../../../shared/contracts';
import { api, ApiError, resetCsrf } from '../api';
import Icon from './Icon.vue';
import TreeBranch from './TreeBranch.vue';
import MarkdownEditor from './MarkdownEditor.vue';
import EditorToolbar from './EditorToolbar.vue';
import DocumentBreadcrumb from './DocumentBreadcrumb.vue';
import { emptyToolbarState, type MarkdownAction } from '../markdown-format';
import DocumentOutline from './DocumentOutline.vue';
import { outlineFromTokens } from '../document-outline';
import LargeFileWorkspace from './LargeFileWorkspace.vue';
import IndexStatus from './IndexStatus.vue';
import SearchRuntimeSettings from './SearchRuntimeSettings.vue';
import PluginManager from './PluginManager.vue';
import PluginSlot from './PluginSlot.vue';
import PluginPanel from './PluginPanel.vue';
import NoteActions from './NoteActions.vue';
import SidebarResizer from './SidebarResizer.vue';
import DraftRecovery from './DraftRecovery.vue';
import NoteMoveDialog from './NoteMoveDialog.vue';
import MaintenanceSettings from './MaintenanceSettings.vue';
import StorageSettings from './StorageSettings.vue';
import SetupImport from './SetupImport.vue';
import { useNoteDraft } from '../useNoteDraft';
import { filenameResults, mergeSearchResults } from '../search-results';
import { noteDraftBase } from '../drafts';
import {
  createWorkspaceNavigation,
  readWorkspaceRoute,
  type WorkspaceRoute,
  type WorkspaceNavigationState,
} from '../navigation';
import { MIN_PASSWORD_LENGTH, PASSWORD_POLICY_MESSAGE } from '../../../shared/password-policy';
import { refreshPlugins, disposePluginUIs, pluginRegistry } from '../plugins';
import type {
  NoteInfo,
  FileReply,
  OutlinePage,
  FileOperation,
  SearchOutput,
  MoveNoteResult,
} from '../../../shared/knowledge-contracts';
const noteInfo = ref<NoteInfo>(),
  largeRef = ref<InstanceType<typeof LargeFileWorkspace>>(),
  largeDirty = ref(false);
const initialNoteId = new URLSearchParams(window.location.search).get('note');
const noteLine = ref<number | undefined>();
const editorRef = ref<InstanceType<typeof MarkdownEditor>>();
const noteOpening = ref(false),
  editorTransfer = ref(false);
const moveOpen = ref(false),
  importOpen = ref(false),
  quickBusy = ref(false);
const parsedLine = Number(window.location.hash.match(/^#L([1-9]\d*)$/)?.[1]);
const initialLine =
  Number.isSafeInteger(parsedLine) && parsedLine <= 20 * 1024 * 1024 ? parsedLine : undefined;
const emit = defineEmits<{ logout: [] }>();
function storedSidebarWidth() {
  try {
    const width = Number(localStorage.getItem('dooknow.sidebarWidth'));
    if (Number.isFinite(width) && width >= 240 && width <= 400) return width;
  } catch {}
  return 280;
}
const sidebarCollapsed = ref(false);
const editorState = ref(emptyToolbarState());
const navigationState = ref<WorkspaceNavigationState>({ canBack: false, canForward: false });
const sidebarWidth = ref(storedSidebarWidth()),
  accountExpanded = ref(false),
  showLineNumbers = ref(false),
  releaseVersion = ref('');
function saveSidebarWidth() {
  try {
    localStorage.setItem('dooknow.sidebarWidth', String(sidebarWidth.value));
  } catch {}
}
const tree = ref<TreeEntry[]>([]),
  note = ref<NoteDocument>(),
  folder = ref(''),
  selected = ref(''),
  draft = ref(''),
  savedContent = ref(''),
  mode = ref<'edit' | 'preview' | 'split'>('edit'),
  drawer = ref(true),
  busy = ref(false),
  error = ref(''),
  notice = ref('');
const dialogError = ref('');
const searchMode = ref<'text' | 'semantic' | 'hybrid'>('hybrid'),
  searchDirectory = ref(''),
  searchDegraded = ref(false),
  vectorReady = ref(false);
const importFolder = ref('40-Resources'),
  importBusy = ref(false),
  downloading = ref(false),
  outlineOpen = ref(false);
const query = ref(''),
  searchBusy = ref(false),
  searchError = ref(''),
  searchWaiting = ref(false),
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
function currentDraftBase() {
  return noteDraftBase({ modifiedAt: note.value?.modifiedAt || '' });
}
const localDrafts = useNoteDraft(
  () => ({
    noteId: note.value?.id,
    baseRevision: currentDraftBase(),
    content: draft.value,
    dirty: dirty.value,
    enabled: noteInfo.value?.editorMode === 'full',
  }),
  (text) => {
    draft.value = text;
  },
);
const draftScope = localDrafts.scope,
  recoveryDraft = localDrafts.recovered,
  draftLoading = localDrafts.loading,
  draftBusy = localDrafts.busy,
  draftError = localDrafts.error,
  draftSavedAt = localDrafts.savedAt;
const formatDisabled = computed(
  () =>
    !note.value ||
    noteInfo.value?.editorMode !== 'full' ||
    mode.value === 'preview' ||
    noteOpening.value ||
    editorTransfer.value ||
    draftLoading.value ||
    draftBusy.value ||
    !!recoveryDraft.value,
);
function formatNote(action: MarkdownAction) {
  if (!formatDisabled.value) editorRef.value?.format(action);
}
function editHistory(action: 'undo' | 'redo') {
  if (!formatDisabled.value) editorRef.value?.editHistory(action);
}
async function browseRoot() {
  await run(() =>
    guard(async () => {
      await localDrafts.flush();
      viewEpoch++;
      note.value = undefined;
      panel.value = 'empty';
      folder.value = '';
      selected.value = '';
      drawer.value = false;
      navigation.commit({});
    }),
  );
}
const navigation = createWorkspaceNavigation({
  dirty: () => dirty.value,
  guard,
  apply: applyRoute,
  error: showError,
  onState: (state) => {
    navigationState.value = state;
  },
});
async function initializeDrafts() {
  try {
    const [session, status] = await Promise.all([
      api('/api/auth/get-session'),
      api('/api/platform/status'),
    ]);
    if (!session?.user?.id || !status.knowledgeRoot)
      throw new Error('未能确认本地草稿所属账户与知识库，请手动保存原文。');
    const identity = JSON.stringify([status.knowledgeRoot, status.bindingVersion]);
    const knowledgeId = crypto.subtle
      ? Array.from(
          new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity))),
          (x) => x.toString(16).padStart(2, '0'),
        ).join('')
      : identity;
    localDrafts.setup({ ownerId: session.user.id, knowledgeId });
  } catch (cause) {
    draftError.value =
      cause instanceof Error ? cause.message : '本地草稿保护暂不可用，请手动保存原文。';
  }
}
async function applyRoute(route: WorkspaceRoute) {
  if (route.note) return openNote(route.note, route.line, false);
  if (route.view === 'trash') return openTrash(false);
  if (route.view === 'settings') return settings(route.section, false);
  const entry = route.folder
    ? flat.value.find((item) => item.type === 'folder' && item.path === route.folder)
    : undefined;
  if (entry) return select(entry, false);
  await guard(async () => {
    await localDrafts.flush();
    viewEpoch++;
    note.value = undefined;
    panel.value = 'empty';
    folder.value = '';
    selected.value = '';
  });
}
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
const md = new MarkdownIt({ html: false, linkify: true }).use(markdownStyles);
const flatten = (items: TreeEntry[]): TreeEntry[] =>
  items.flatMap((x) => [x, ...(x.children ? flatten(x.children) : [])]);
const flat = computed(() => flatten(tree.value));
const folders = computed(() => [
  { label: '知识库根目录', value: '' },
  ...flat.value.filter((x) => x.type === 'folder').map((x) => ({ label: x.path, value: x.path })),
]);
const folderEntries = computed(() => {
  if (!folder.value) return [];
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
      if (t.type === 'heading_open' && t.map) t.attrSet('data-source-line', String(t.map[0] + 1));
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
function showError(cause: unknown) {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (
    createOpen.value ||
    shareOpen.value ||
    restoreTarget.value ||
    deleteOpen.value ||
    revisionsOpen.value ||
    leaveOpen.value ||
    conflict.value
  )
    dialogError.value = message;
  else error.value = message;
}
async function run(fn: () => Promise<void>) {
  error.value = '';
  dialogError.value = '';
  try {
    await fn();
  } catch (cause) {
    showError(cause);
  }
}
async function refresh() {
  tree.value = await api('/api/tree');
}
async function openNote(id: string, line?: number, syncUrl = true) {
  await guard(async () => {
    await localDrafts.flush();
    const epoch = ++viewEpoch;
    noteOpening.value = true;
    try {
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
      if (meta.editorMode === 'full') localDrafts.prepare();
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
      noteLine.value = line;
      if (syncUrl) navigation.commit({ note: id, line });
      if (meta.editorMode === 'full') await localDrafts.load(id, currentDraftBase(), n.content);
      await nextTick();
      if (line) editorRef.value?.goToLine(line);
    } finally {
      if (epoch === viewEpoch) noteOpening.value = false;
    }
  });
}
async function select(entry: TreeEntry, syncUrl = true) {
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
        if (syncUrl) navigation.commit({ folder: entry.path });
      });
  });
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
    try {
      await localDrafts.discard();
      await largeRef.value?.discard();
    } catch (cause) {
      showError(cause);
      return;
    }
    draft.value = savedContent.value;
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
      localDrafts.prepare();
      note.value = document;
      draft.value = document.content;
      savedContent.value = document.content;
      largeDirty.value = false;
      noteInfo.value = meta;
      await localDrafts.load(meta.id, currentDraftBase(), document.content);
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
async function prepareLargeTransition(submitted: string) {
  editorTransfer.value = true;
  await nextTick();
  const version = await localDrafts.flush();
  if (draft.value !== submitted && !version)
    throw new Error('原文已保存，但后续输入未能暂存。请复制当前内容后再重新打开笔记。');
  if (draft.value === submitted && note.value) await localDrafts.clearSaved(note.value.id, version);
}
async function checkSave() {
  const pending = pendingSave.value,
    epoch = viewEpoch;
  if (!pending) return;
  try {
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
        const enteringLarge = meta.editorMode !== 'full' && noteInfo.value?.editorMode === 'full';
        if (enteringLarge) await prepareLargeTransition(pending.content);
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
          if (!enteringLarge) await largeRef.value?.reload();
        }
      }
      pendingSave.value = undefined;
      editorTransfer.value = false;
      tell('保存结果已确认');
      return;
    }
    if (['failed', 'cancelled'].includes(op.status)) {
      pendingSave.value = undefined;
      throw new Error('上次操作未完成，草稿已保留');
    }
    throw new Error('操作仍在处理，请稍后核对');
  } finally {
    editorTransfer.value = false;
  }
}
async function save(expected?: string, content?: string, revisionId?: string) {
  if (!note.value || busy.value) return;
  if (
    noteInfo.value?.editorMode === 'full' &&
    !revisionId &&
    !dirty.value &&
    pendingSave.value?.noteId !== note.value.id
  )
    return;
  if (noteInfo.value?.editorMode !== 'full' && !revisionId) {
    await largeRef.value?.save();
    return;
  }
  busy.value = true;
  error.value = '';
  dialogError.value = '';
  const target = note.value,
    epoch = viewEpoch;
  const text = content ?? draft.value;
  const localVersion = await localDrafts.flush();
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
      const enteringLarge = meta.editorMode !== 'full' && noteInfo.value?.editorMode === 'full';
      if (enteringLarge) await prepareLargeTransition(text);
      noteInfo.value = meta;
      n =
        meta.editorMode === 'full'
          ? await api<NoteDocument>(`/api/notes/${target.id}`)
          : { ...target, title: meta.title, modifiedAt: meta.modifiedAt, content: '' };
      await nextTick();
      if (!enteringLarge) await largeRef.value?.reload();
    }
    if (n.editorMode && currentView(target.id, epoch)) {
      const enteringLarge = n.editorMode !== 'full' && noteInfo.value?.editorMode === 'full';
      if (enteringLarge) await prepareLargeTransition(text);
      noteInfo.value = n;
      if (n.editorMode !== 'full') {
        n = { ...target, title: n.title, modifiedAt: n.modifiedAt, content: '' };
        draft.value = '';
        await nextTick();
        if (!enteringLarge) await largeRef.value?.reload();
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
    await localDrafts.clearSaved(target.id, localVersion);
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
    else showError(e);
  } finally {
    editorTransfer.value = false;
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
const shareBusy = ref(false);
const shareOpen = ref(false),
  share = ref<{ enabled: boolean; token?: string; url?: string }>({ enabled: false });
const shareUrl = computed(() =>
  share.value.url ? new URL(share.value.url, location.origin).href : '',
);
async function manageShare() {
  if (shareBusy.value) return;
  shareBusy.value = true;
  dialogError.value = '';
  try {
    const id = note.value!.id,
      epoch = viewEpoch;
    await run(async () => {
      const response = await api(`/api/notes/${id}/share`);
      if (!currentView(id, epoch)) return;
      share.value = response;
      shareOpen.value = true;
    });
  } finally {
    shareBusy.value = false;
  }
}
async function shareAction(action: 'create' | 'reset' | 'revoke') {
  if (shareBusy.value) return;
  shareBusy.value = true;
  try {
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
  } finally {
    shareBusy.value = false;
  }
}
async function copyShare() {
  await run(async () => {
    await navigator.clipboard.writeText(shareUrl.value);
    tell('链接已复制');
  });
}
const createBusy = ref(false);
const createOpen = ref(false),
  createKind = ref<'note' | 'folder'>('note'),
  newName = ref(''),
  newFolder = ref('');
let createRequestId = crypto.randomUUID();
function create(kind: 'note' | 'folder') {
  dialogError.value = '';
  createRequestId = crypto.randomUUID();
  createKind.value = kind;
  newFolder.value =
    folder.value || (folders.value.some((x) => x.value === '00-Inbox') ? '00-Inbox' : '');
  newName.value = kind === 'note' && !newFolder.value ? 'README.md' : '';
  createOpen.value = true;
}
async function submitCreate() {
  if (createBusy.value || !newName.value.trim()) return;
  createBusy.value = true;
  try {
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
  } finally {
    createBusy.value = false;
  }
}
const panel = ref<'empty' | 'folder' | 'note' | 'trash' | 'settings'>('empty'),
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
    if (!conflict.value && !dialogError.value && !error.value) revisionsOpen.value = false;
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
const trashLoading = ref(false),
  restoringId = ref<string>();
async function openTrash(syncUrl = true) {
  await run(() =>
    guard(async () => {
      const epoch = ++viewEpoch;
      panel.value = 'trash';
      if (syncUrl) navigation.commit({ view: 'trash' });
      note.value = undefined;
      drawer.value = false;
      trashLoading.value = true;
      try {
        const response = await api('/api/trash');
        if (epoch === viewEpoch) trash.value = response;
      } finally {
        if (epoch === viewEpoch) trashLoading.value = false;
      }
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
    panel.value = folder.value ? 'folder' : 'empty';
    navigation.commit(folder.value ? { folder: folder.value } : {});
  }
  await refresh();
  if (panel.value === 'trash') trash.value = await api('/api/trash');
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
  if (restoringId.value || (fileName !== undefined && !fileName.trim())) return;
  restoringId.value = item.id;
  try {
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
  } finally {
    restoringId.value = undefined;
  }
}
const activeSetting = ref<'account' | 'search' | 'plugins' | 'maintenance'>('account');
function scrollSetting(section: 'account' | 'search' | 'plugins' | 'maintenance', syncUrl = true) {
  activeSetting.value = section;
  if (syncUrl && panel.value === 'settings') navigation.commit({ view: 'settings', section }, true);
  document.getElementById(section + '-settings')?.scrollIntoView({ block: 'start' });
}
async function settings(
  section?: 'account' | 'search' | 'plugins' | 'maintenance',
  syncUrl = true,
) {
  await guard(async () => {
    viewEpoch++;
    panel.value = 'settings';
    note.value = undefined;
    drawer.value = false;
    await nextTick();
    scrollSetting(section || 'account', false);
    if (syncUrl) navigation.commit({ view: 'settings', section: section || 'account' });
  });
}
const currentPassword = ref(''),
  newPassword = ref(''),
  passwordBusy = ref(false),
  passwordNotice = ref('');
async function changePassword() {
  if (passwordBusy.value) return;
  if ([...newPassword.value].length < MIN_PASSWORD_LENGTH) {
    showError(new Error(PASSWORD_POLICY_MESSAGE));
    return;
  }
  await run(async () => {
    passwordBusy.value = true;
    passwordNotice.value = '';
    try {
      await api('/api/auth/change-password', 'POST', {
        currentPassword: currentPassword.value,
        newPassword: newPassword.value,
        revokeOtherSessions: true,
      });
      currentPassword.value = '';
      newPassword.value = '';
      passwordNotice.value = '密码已修改，其他会话已撤销';
      tell(passwordNotice.value);
    } finally {
      passwordBusy.value = false;
    }
  });
}
async function logout() {
  await run(() =>
    guard(async () => {
      try {
        await localDrafts.logout();
        await api('/api/auth/sign-out', 'POST', {});
      } catch (cause) {
        await initializeDrafts();
        throw cause;
      }
      viewEpoch++;
      resetCsrf();
      tree.value = [];
      note.value = undefined;
      draft.value = '';
      emit('logout');
    }),
  );
}
async function showMove() {
  await guard(async () => {
    moveOpen.value = true;
  });
}
async function moved(result: MoveNoteResult) {
  await run(async () => {
    await refresh();
    await openNote(result.id);
    tell('笔记已整理，历史和分享链接保持关联');
  });
}
async function resolved(value: { noteId: string; operationId: string }) {
  if (pendingSave.value?.noteId === value.noteId) pendingSave.value = undefined;
  if (pendingDelete.value?.noteId === value.noteId) pendingDelete.value = undefined;
  await run(refresh);
  tell('磁盘版本已核对，原操作材料已保留');
}
let quickPending:
  | { folderPath: string; fileName: string; content: string; requestId: string }
  | undefined;
async function quickNote() {
  if (quickBusy.value) return;
  await run(() =>
    guard(async () => {
      quickBusy.value = true;
      try {
        if (!flat.value.some((entry) => entry.type === 'folder' && entry.path === '00-Inbox')) {
          try {
            await api('/api/folders', 'POST', { parent: '', name: '00-Inbox' });
          } catch (cause) {
            await refresh();
            if (!flat.value.some((entry) => entry.path === '00-Inbox')) throw cause;
          }
        }
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        quickPending ||= {
          folderPath: '00-Inbox',
          fileName: `新的想法-${stamp}-${crypto.randomUUID().slice(0, 4)}.md`,
          content: '# 新的想法\n\n',
          requestId: crypto.randomUUID(),
        };
        const created = await api<NoteDocument>('/api/notes', 'POST', quickPending);
        quickPending = undefined;
        createOpen.value = false;
        await refresh();
        await openNote(created.id);
        await nextTick();
        editorRef.value?.goToLine(3);
      } finally {
        quickBusy.value = false;
      }
    }),
  );
}
async function imported(value: { id: string; relativePath: string }) {
  await run(refresh);
  tell('Markdown 已导入，可在目录中打开');
}
async function downloadNote() {
  if (!note.value || downloading.value) return;
  const target = note.value;
  downloading.value = true;
  await run(async () => {
    try {
      let response: Response | undefined;
      for (let attempt = 0; attempt < 60; attempt++) {
        response = await fetch(`/api/notes/${target.id}/download`, {
          cache: 'no-store',
          signal: AbortSignal.timeout(30000),
        });
        if (response.status !== 202) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (!response?.ok || response.status === 202)
        throw new Error('文件暂未准备好，请稍后重新下载。');
      const blob = await response.blob(),
        url = URL.createObjectURL(blob),
        link = document.createElement('a');
      link.href = url;
      link.download = target.relativePath.split('/').at(-1) || 'note.md';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      tell('已下载最新保存的 Markdown 原文');
    } finally {
      downloading.value = false;
    }
  });
}
const normalOutline = computed(() => {
  if (!note.value || noteInfo.value?.editorMode !== 'full') return [];
  return outlineFromTokens(md.parse(draft.value, {}));
});
const articleLine = ref(1);
const activeHeading = computed(() => {
  let line: number | undefined;
  for (const item of normalOutline.value) {
    if (item.line > articleLine.value) break;
    line = item.line;
  }
  return line ?? normalOutline.value[0]?.line;
});
watch(
  () => note.value?.id,
  () => {
    articleLine.value = noteLine.value || 1;
  },
);
function trackPreview(event: Event) {
  const container = event.currentTarget as HTMLElement;
  const headings = container.querySelectorAll<HTMLElement>('[data-source-line]');
  if (
    container.scrollTop > 0 &&
    container.scrollHeight - container.clientHeight - container.scrollTop <= 2
  ) {
    const last = Array.from(headings).at(-1);
    if (last) articleLine.value = Number(last.dataset.sourceLine);
    return;
  }
  const top = container.getBoundingClientRect().top + 40;
  let line = 1;
  for (const heading of headings) {
    if (heading.getBoundingClientRect().top > top) break;
    line = Number(heading.dataset.sourceLine);
  }
  articleLine.value = line;
}
async function goToHeading(line: number) {
  outlineOpen.value = false;
  noteLine.value = line;
  articleLine.value = line;
  if (note.value) navigation.commit({ note: note.value.id, line }, true);
  await nextTick();
  if (mode.value !== 'preview') editorRef.value?.goToLine(line, 'start');
  if (mode.value !== 'edit')
    document
      .querySelector(`.preview-panel [data-source-line="${line}"]`)
      ?.scrollIntoView({ block: 'start' });
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
let searchEpoch = 0;
async function searchPage(
  q: string,
  cursor?: string,
  epoch = searchEpoch,
): Promise<SearchOutput | undefined> {
  let response: SearchOutput;
  try {
    response = await api<SearchOutput>('/api/search/advanced', 'POST', {
      query: q,
      mode: searchMode.value,
      ...(searchDirectory.value ? { filters: { directory: searchDirectory.value } } : {}),
      ...(cursor ? { cursor } : {}),
    });
  } catch (e) {
    if (
      cursor &&
      e instanceof ApiError &&
      (e.data.code === 'CURSOR_EXPIRED' || (e.data.error as any)?.code === 'CURSOR_EXPIRED')
    ) {
      tell('索引已更新，搜索结果已重新加载');
      return searchPage(q, undefined, epoch);
    }
    throw e;
  }
  if (query.value !== q || epoch !== searchEpoch) return;
  const items = response.results.map((r) => ({
    id: r.noteId,
    title: r.title,
    relativePath: r.relativePath,
    snippet: r.matches[0]?.snippet || '',
    line: r.matches[0]?.startLine || 1,
    headingPath: r.matches[0]?.headingPath || [],
    matches: r.matches,
  }));
  searchDegraded.value = !!response.degraded;
  const local = filenameResults(flat.value, q, searchDirectory.value);
  results.value = cursor
    ? mergeSearchResults(results.value, items, local)
    : mergeSearchResults(items, local);
  searchCursor.value = response.nextCursor;
  return response;
}
function beginSearch(q: string) {
  clearTimeout(searchTimer);
  const epoch = ++searchEpoch;
  searchCursor.value = undefined;
  results.value = filenameResults(flat.value, q, searchDirectory.value);
  searchError.value = '';
  searchBusy.value = !!q.trim();
  searchWaiting.value = false;
  if (!q.trim()) return;
  let attempts = 0;
  const search = async () => {
    if (epoch !== searchEpoch) return;
    searchBusy.value = true;
    try {
      if (searchMode.value === 'semantic') {
        const runtime = await api('/api/platform/search-runtime');
        if (epoch !== searchEpoch) return;
        vectorReady.value = !!runtime.components?.vectorReady;
        if (!vectorReady.value)
          throw new Error('语义检索尚未准备。请准备本地检索，或使用文本/混合检索。');
      }
      const response = await searchPage(q, undefined, epoch);
      if (epoch !== searchEpoch) return;
      searchWaiting.value = !!(
        response &&
        ++attempts < 15 &&
        (response.index.pending || (!results.value.length && attempts < 3))
      );
      if (searchWaiting.value) searchTimer = setTimeout(() => void search(), 1000);
    } catch (e) {
      if (epoch === searchEpoch) {
        searchError.value = (e as Error).message;
        searchWaiting.value = false;
      }
    } finally {
      if (epoch === searchEpoch) searchBusy.value = false;
    }
  };
  searchTimer = setTimeout(() => void search(), 220);
}
async function moreSearch() {
  if (searchBusy.value || !searchCursor.value) return;
  clearTimeout(searchTimer);
  searchWaiting.value = false;
  const epoch = searchEpoch;
  searchBusy.value = true;
  searchError.value = '';
  try {
    await searchPage(query.value, searchCursor.value, epoch);
  } catch (e) {
    if (epoch === searchEpoch) searchError.value = (e as Error).message;
  } finally {
    if (epoch === searchEpoch) searchBusy.value = false;
  }
}
watch([query, searchMode, searchDirectory], () => beginSearch(query.value));
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
  void api('/healthz')
    .then((status) => {
      releaseVersion.value = status.version || '';
    })
    .catch(() => {});
  void api('/api/platform/search-runtime')
    .then((state) => {
      vectorReady.value = !!state.components?.vectorReady;
    })
    .catch(() => {});
  void refreshPlugins().catch(() => {});
  pluginTimer = setInterval(() => {
    void refreshPlugins().catch(() => {});
  }, 5000);
  window.addEventListener('dooknow-workspace-changed', workspaceChanged);
  window.addEventListener('dooknow-notice', pluginNotice);
  void run(async () => {
    await initializeDrafts();
    await refresh();
    await applyRoute(readWorkspaceRoute());
    if (sessionStorage.getItem('dooknow-welcome-action') === 'create-note') {
      sessionStorage.removeItem('dooknow-welcome-action');
      create('note');
    }
  });
  window.addEventListener('keydown', shortcut);
  window.addEventListener('beforeunload', unload);
});
onBeforeUnmount(() => {
  navigation.dispose();
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
  <div
    :class="['workspace', { 'sidebar-collapsed': sidebarCollapsed && panel === 'note' }]"
    :style="{ '--sidebar-width': sidebarWidth + 'px' }"
  >
    <div v-if="drawer" class="drawer-scrim" @click="drawer = false"></div>
    <aside id="notebook-navigation" :class="['sidebar', { open: drawer }]" aria-label="笔记导航">
      <div class="brand">
        <Icon name="book" :size="31" /><strong>DooKnow</strong
        ><button class="mobile-only icon-button" aria-label="关闭侧栏" @click="drawer = false">
          <Icon name="close" />
        </button>
      </div>
      <div class="sidebar-actions">
        <AInput
          v-model:value="query"
          allow-clear
          placeholder="搜索笔记与目录"
          aria-label="搜索笔记与目录"
          ><template #prefix><Icon name="search" :size="17" /></template></AInput
        ><AButton type="primary" aria-label="新建笔记" title="新建笔记" @click="create('note')"
          ><template #icon><Icon name="plus" /></template
        ></AButton>
      </div>
      <div class="tree-heading">
        <span>{{ query ? '搜索结果' : '笔记本' }}</span
        ><button class="icon-button" aria-label="新建文件夹" @click="create('folder')">
          <Icon name="plus" /></button
        ><button class="icon-button" aria-label="刷新目录" @click="run(refresh)">
          <Icon name="refresh" :size="17" />
        </button>
      </div>
      <div v-if="query" class="search-options">
        <label class="sr-only" for="workspace-search-mode">搜索模式</label>
        <ASelect
          id="workspace-search-mode"
          v-model:value="searchMode"
          :options="[
            { label: '混合检索', value: 'hybrid' },
            { label: '文本检索', value: 'text' },
            { label: vectorReady ? '语义检索' : '语义检索（需准备）', value: 'semantic' },
          ]"
        />
        <label class="sr-only" for="workspace-search-directory">搜索目录</label>
        <ASelect
          id="workspace-search-directory"
          v-model:value="searchDirectory"
          :options="[{ label: '所有目录', value: '' }, ...folders.filter((item) => item.value)]"
        />
      </div>
      <div class="tree-scroll">
        <template v-if="query"
          ><button
            v-for="r in results"
            :key="r.id"
            class="search-result"
            @click="
              run(() =>
                r.type === 'folder'
                  ? select({ type: 'folder', name: r.title, path: r.relativePath })
                  : openNote(r.id, r.line),
              )
            "
          >
            <b>{{ r.title }}</b
            ><small>{{ r.relativePath }}</small
            ><span>{{ r.snippet }}</span>
          </button>
          <p v-if="searchDegraded && results.length" class="search-feedback">
            当前显示可用的检索结果，部分检索能力或索引仍在准备。<button
              class="text-link"
              @click="settings('search')"
            >
              检查搜索设置
            </button>
          </p>
          <p v-if="results.length" class="muted">
            已显示 {{ results.length }}
            {{ results.some((item) => item.type === 'folder') ? '项' : '篇' }}
          </p>
          <p
            v-if="searchBusy || searchWaiting"
            class="search-feedback"
            role="status"
            aria-live="polite"
          >
            {{ searchBusy ? '正在搜索…' : '搜索索引正在更新，请稍候…' }}
          </p>
          <div v-if="searchError" class="search-feedback">
            <AAlert type="error" :message="searchError" role="alert" />
            <AButton size="small" @click="searchCursor ? moreSearch() : beginSearch(query)"
              >重试搜索</AButton
            >
          </div>
          <AButton
            v-if="searchCursor && !searchError"
            :loading="searchBusy"
            :disabled="searchBusy"
            @click="moreSearch"
            >加载更多搜索结果</AButton
          >
          <p
            v-if="!results.length && !searchBusy && !searchWaiting && !searchError"
            class="muted empty-search"
          >
            没有匹配的笔记
          </p></template
        ><TreeBranch v-else :entries="tree" :selected="selected" @select="select" />
      </div>
      <div
        v-if="
          pluginRegistry.contributions.some(
            (c) => c.slot === 'navigation' || c.slot === 'libraryAction',
          )
        "
        class="sidebar-tools"
      >
        <span class="sidebar-section-title">扩展工具</span>
        <PluginSlot slot-name="navigation" :context="pluginContext" />
        <PluginSlot slot-name="libraryAction" :context="pluginContext" />
      </div>
      <div class="sidebar-footer">
        <button
          class="nav-action account-row"
          aria-label="个人账户"
          :aria-expanded="accountExpanded"
          aria-controls="account-navigation"
          @click="accountExpanded = !accountExpanded"
        >
          <span class="avatar" aria-hidden="true">个人</span><span>个人账户</span>
          <Icon name="chevron" :size="16" :class="{ 'account-expanded': accountExpanded }" />
        </button>
        <div v-show="accountExpanded" id="account-navigation" class="account-navigation">
          <button class="nav-action" @click="importOpen = true">
            <Icon name="file" />导入 Markdown
          </button>
          <button class="nav-action" @click="settings('account')">
            <Icon name="lock" />账户设置
          </button>
          <button
            class="nav-action"
            :class="{ active: panel === 'trash' }"
            :aria-current="panel === 'trash' ? 'page' : undefined"
            @click="openTrash()"
          >
            <Icon name="trash" />回收站</button
          ><button
            class="nav-action"
            :class="{ active: panel === 'settings' }"
            :aria-current="panel === 'settings' ? 'page' : undefined"
            @click="settings()"
          >
            <Icon name="settings" />设置
          </button>
        </div>
      </div>
    </aside>
    <SidebarResizer v-model="sidebarWidth" @commit="saveSidebarWidth" />
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
            <div class="document-navigation">
              <button
                class="icon-button desktop-sidebar-toggle"
                type="button"
                :aria-label="sidebarCollapsed ? '展开侧栏' : '收起侧栏'"
                :title="sidebarCollapsed ? '展开侧栏' : '收起侧栏'"
                :aria-expanded="!sidebarCollapsed"
                aria-controls="notebook-navigation"
                @click="sidebarCollapsed = !sidebarCollapsed"
              >
                <Icon name="sidebar" :size="18" />
              </button>
              <button
                class="icon-button"
                type="button"
                aria-label="后退"
                title="后退"
                :disabled="!navigationState.canBack"
                @click="navigation.back()"
              >
                <Icon name="back" :size="18" />
              </button>
              <button
                class="icon-button"
                type="button"
                aria-label="前进"
                title="前进"
                :disabled="!navigationState.canForward"
                @click="navigation.forward()"
              >
                <Icon name="forward" :size="18" />
              </button>
            </div>
            <DocumentBreadcrumb
              :relative-path="note.relativePath"
              :title="note.title"
              @root="browseRoot"
              @folder="select"
            />
            <div class="toolbar">
              <span
                v-if="noteInfo?.editorMode === 'full'"
                role="status"
                aria-live="polite"
                :title="busy ? '保存中' : dirty ? '未保存' : '已保存'"
                :class="['save-state', { dirty }]"
                >● {{ busy ? '保存中' : dirty ? '未保存' : '已保存' }}</span
              >
              <div v-if="noteInfo?.editorMode === 'full'" class="history-controls">
                <button
                  class="icon-button"
                  type="button"
                  aria-label="撤销"
                  title="撤销 · Ctrl/Cmd+Z"
                  :disabled="formatDisabled || !editorState.canUndo"
                  @mousedown.prevent
                  @click="editHistory('undo')"
                >
                  <Icon name="undo" :size="18" />
                </button>
                <button
                  class="icon-button"
                  type="button"
                  aria-label="重做"
                  title="重做 · Ctrl/Cmd+Shift+Z"
                  :disabled="formatDisabled || !editorState.canRedo"
                  @mousedown.prevent
                  @click="editHistory('redo')"
                >
                  <Icon name="redo" :size="18" />
                </button>
              </div>
              <AButton
                v-if="pendingSave?.noteId === note.id"
                :disabled="busy"
                @click="run(checkSave)"
                >核对保存结果</AButton
              >
              <AButton v-if="pendingDelete && !deleteOpen" @click="run(checkDelete)"
                >核对删除结果</AButton
              >
              <AButton
                class="share-button"
                title="分享"
                aria-label="分享"
                :loading="shareBusy"
                :disabled="shareBusy"
                @click="manageShare"
                ><template #icon><Icon name="share" /></template>分享</AButton
              ><AButton
                v-if="noteInfo?.editorMode === 'full'"
                class="save-button"
                title="保存"
                aria-label="保存"
                type="primary"
                :loading="busy"
                :disabled="busy || (!dirty && pendingSave?.noteId !== note.id)"
                @click="save()"
                ><template #icon><Icon name="save" /></template>保存
                <span class="shortcut">Ctrl+S</span></AButton
              >
              <NoteActions
                :key="note.id"
                v-model:line-numbers="showLineNumbers"
                :full-editor="noteInfo?.editorMode === 'full'"
                @move="showMove"
                @download="downloadNote"
                @history="history()"
                @upload="uploadInput?.click()"
                @delete="deleteOpen = true"
                ><PluginSlot slot-name="noteAction" :context="pluginContext"
              /></NoteActions>
            </div>
          </div>
          <div v-if="note.shared" class="shared-status">
            <Icon name="share" :size="14" />已分享，保存后的修改将同步公开
          </div>
          <div v-if="noteInfo?.editorMode === 'full'" class="document-format-row">
            <EditorToolbar
              :state="editorState"
              :disabled="formatDisabled"
              @format="formatNote"
              @upload="uploadInput?.click()"
            />
            <div class="mode-row">
              <div class="mode-tabs">
                <button
                  :aria-pressed="mode === 'edit'"
                  :class="{ active: mode === 'edit' }"
                  @click="mode = 'edit'"
                >
                  编辑</button
                ><button
                  :aria-pressed="mode === 'preview'"
                  :class="{ active: mode === 'preview' }"
                  @click="mode = 'preview'"
                >
                  预览</button
                ><button
                  :aria-pressed="mode === 'split'"
                  :class="{ active: mode === 'split' }"
                  @click="mode = 'split'"
                >
                  分屏
                </button>
              </div>
              <APopover v-model:open="outlineOpen" trigger="click" placement="bottomRight">
                <template #content>
                  <DocumentOutline
                    class="outline-popup"
                    :headings="normalOutline"
                    :active-line="activeHeading"
                    @select="goToHeading"
                  />
                </template>
                <AButton
                  class="outline-toggle"
                  type="text"
                  size="small"
                  aria-label="章节目录"
                  title="章节目录"
                  :aria-expanded="outlineOpen"
                  ><Icon name="list" :size="17" /><span class="outline-toggle-label"
                    >章节目录</span
                  ></AButton
                >
              </APopover>
            </div>
          </div>
        </header>
        <LargeFileWorkspace
          v-if="noteInfo && noteInfo.editorMode !== 'full'"
          ref="largeRef"
          :note="noteInfo"
          :assets="assets"
          :draft-scope="draftScope"
          :inert="noteOpening || editorTransfer ? '' : undefined"
          :initial-line="noteLine || (note.id === initialNoteId ? initialLine : undefined)"
          :key="note.id"
          @dirty="(v) => (largeDirty = v)"
          @saved="onLargeSaved" />
        <template v-else>
          <AAlert
            v-if="draftError"
            type="warning"
            :message="draftError"
            role="alert"
            class="local-draft-alert"
          />
          <DraftRecovery
            v-if="recoveryDraft"
            :draft="recoveryDraft"
            :base-changed="recoveryDraft.baseRevision !== currentDraftBase()"
            :busy="draftBusy"
            @restore="localDrafts.restore"
            @discard="run(localDrafts.discard)"
          />
          <div class="document-body">
            <div class="document-surface">
              <div :class="['editor-panels', mode]">
                <section v-show="mode !== 'preview'" class="editor-panel">
                  <div class="panel-label">Markdown <span>手动保存 · Ctrl+S</span></div>
                  <MarkdownEditor
                    ref="editorRef"
                    v-model="draft"
                    :read-only="
                      noteOpening || editorTransfer || draftLoading || draftBusy || !!recoveryDraft
                    "
                    :key="note.id"
                    :initial-line="
                      noteLine || (note.id === initialNoteId ? initialLine : undefined)
                    "
                    :show-line-numbers="showLineNumbers"
                    @line-change="articleLine = $event"
                    @state-change="editorState = $event"
                  />
                </section>
                <section v-if="mode !== 'edit'" class="preview-panel">
                  <div class="panel-label">预览 <Icon name="eye" :size="16" /></div>
                  <div
                    class="markdown"
                    v-html="preview"
                    @click="clickPreview"
                    @scroll.passive="trackPreview"
                  ></div>
                </section>
              </div>
            </div>
            <aside class="document-outline">
              <DocumentOutline
                :headings="normalOutline"
                :active-line="activeHeading"
                @select="goToHeading"
              />
            </aside>
          </div>
          <p v-if="draftSavedAt && dirty" class="local-draft-status" role="status">
            本地草稿已暂存 · {{ new Date(draftSavedAt).toLocaleTimeString('zh-CN') }} ·
            原文仍需手动保存
          </p>
        </template>
        <input
          ref="uploadInput"
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp,application/pdf"
          hidden
          @change="upload"
      /></template>
      <section v-else-if="panel === 'empty'" class="utility-view workspace-empty">
        <div class="utility-empty">
          <Icon name="book" :size="36" />
          <h1>选择一篇笔记</h1>
          <p>从左侧目录打开笔记，或新建笔记开始记录。</p>
          <div class="workspace-empty-actions">
            <AButton
              type="primary"
              :loading="quickBusy"
              :disabled="quickBusy"
              aria-label="快速记录"
              @click="quickNote"
              >快速记录</AButton
            >
            <AButton type="text" @click="importOpen = true">导入 Markdown</AButton>
          </div>
        </div>
      </section>
      <section v-else-if="panel === 'folder' && folder" class="folder-view">
        <header class="folder-header">
          <span class="breadcrumb">{{ folder.split('/').join('　/　') }}</span>
          <h1>{{ folder.split('/').at(-1) }}</h1>
          <div class="folder-info">
            <span
              >{{ folderEntries.filter((x) => x.type === 'folder').length }} 个文件夹 ·
              {{ folderEntries.filter((x) => x.type === 'note').length }} 篇笔记</span
            ><AButton @click="create('folder')"
              ><template #icon><Icon name="plus" /></template>新建文件夹</AButton
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
          <AButton v-if="!folderEntries.length" type="primary" @click="create('note')"
            >新建笔记</AButton
          >
        </div>
      </section>
      <section v-else-if="panel === 'trash'" class="utility-view">
        <h1>回收站</h1>
        <p class="muted">恢复后笔记保持私有；原位置被占用时，不会覆盖已有文件。</p>
        <p v-if="trashLoading" class="panel-loading" role="status">正在读取回收站…</p>
        <div v-for="item in trashLoading ? [] : trash" :key="item.id" class="utility-row">
          <Icon name="file" /><span>{{ item.relativePath }}</span
          ><AButton
            :loading="restoringId === item.id"
            :disabled="!!restoringId"
            @click="restoreTrash(item)"
            >恢复</AButton
          >
        </div>
        <div v-if="!trashLoading && !trash.length" class="utility-empty">
          <Icon name="trash" :size="36" />
          <h2>回收站为空</h2>
          <p>删除的笔记会出现在这里，需要时可以恢复。</p>
        </div>
      </section>
      <section v-else class="utility-view settings-view">
        <header class="settings-intro">
          <p class="eyebrow">偏好与扩展</p>
          <h1>个人设置</h1>
          <p class="muted">管理你的账户、内容搜索和扩展功能。</p>
        </header>
        <nav class="settings-nav" aria-label="设置分类">
          <AButton
            type="text"
            :aria-current="activeSetting === 'account' ? 'location' : undefined"
            @click="scrollSetting('account')"
            >账户安全</AButton
          >
          <AButton
            type="text"
            :aria-current="activeSetting === 'search' ? 'location' : undefined"
            @click="scrollSetting('search')"
            >内容搜索</AButton
          >
          <AButton
            type="text"
            :aria-current="activeSetting === 'maintenance' ? 'location' : undefined"
            @click="scrollSetting('maintenance')"
            >数据与恢复</AButton
          >
          <AButton
            type="text"
            :aria-current="activeSetting === 'plugins' ? 'location' : undefined"
            @click="scrollSetting('plugins')"
            >扩展插件</AButton
          >
        </nav>
        <section id="account-settings" class="account-settings" aria-label="账户安全">
          <h2>修改密码</h2>
          <p class="muted">修改后撤销其他会话。新密码至少需要 8 个字符。</p>
          <form @submit.prevent="changePassword">
            <div class="form-field">
              <label for="current-password">当前密码</label
              ><NInput
                v-model:value="currentPassword"
                type="password"
                autocomplete="current-password"
                placeholder="请输入当前密码"
                :input-props="{ id: 'current-password', 'aria-label': '当前密码' }"
              />
            </div>
            <div class="form-field">
              <label for="new-password">新密码</label
              ><NInput
                v-model:value="newPassword"
                type="password"
                autocomplete="new-password"
                placeholder="请输入新密码"
                :input-props="{ id: 'new-password', 'aria-label': '新密码' }"
              />
            </div>
            <AButton
              type="primary"
              html-type="submit"
              :loading="passwordBusy"
              :disabled="
                passwordBusy || !currentPassword || [...newPassword].length < MIN_PASSWORD_LENGTH
              "
              >修改密码</AButton
            >
          </form>
          <p v-if="passwordNotice" role="status" class="form-success">{{ passwordNotice }}</p>
          <div class="settings-signout">
            <AButton danger type="text" @click="logout">退出登录</AButton
            ><span>结束当前设备的登录会话。</span>
          </div>
        </section>
        <MaintenanceSettings id="maintenance-settings" @resolved="resolved" /><StorageSettings />
        <SearchRuntimeSettings id="search-settings" /><PluginManager id="plugins-settings" />
        <p v-if="releaseVersion" class="app-version">DooKnow · 服务版本 {{ releaseVersion }}</p>
      </section>
    </main>
    <IndexStatus :note-id="note?.id" @settings="settings('search')" />
    <NoteMoveDialog
      v-model:show="moveOpen"
      :note-id="note?.id"
      :relative-path="note?.relativePath"
      :modified-at="note?.modifiedAt"
      :folders="folders"
      @moved="moved"
    />
    <NModal
      v-model:show="importOpen"
      preset="card"
      class="dialog-card"
      title="导入 Markdown"
      :mask-closable="!importBusy"
      :close-on-esc="!importBusy"
      :closable="!importBusy"
    >
      <label>导入到</label
      ><NSelect
        v-model:value="importFolder"
        aria-label="导入目录"
        :disabled="importBusy"
        :options="[
          ...folders,
          ...(!folders.some((item) => item.value === '40-Resources')
            ? [{ label: '40-Resources（导入时创建）', value: '40-Resources' }]
            : []),
        ]"
        filterable
      />
      <SetupImport
        :destination="importFolder"
        @busy="(value) => (importBusy = value)"
        @imported="imported"
      />
      <div class="dialog-actions">
        <AButton :disabled="importBusy" @click="importOpen = false">完成</AButton>
      </div>
    </NModal>
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
      ><AAlert v-if="dialogError" type="error" :message="dialogError" role="alert" /><template
        v-if="conflict"
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
          <AButton @click="conflict = undefined">取消</AButton
          ><AButton @click="viewLatest">查看最新版本</AButton
          ><AButton danger :loading="busy" @click="confirmConflict">确定覆盖</AButton>
        </div></template
      ></NModal
    >
    <NModal v-model:show="latestOpen" preset="card" class="dialog-card" title="最新已保存原文">
      <pre class="latest-source">{{ latest }}</pre>
    </NModal>
    <NModal v-model:show="shareOpen" preset="card" class="dialog-card share-dialog" title="分享笔记"
      ><AAlert v-if="dialogError" type="error" :message="dialogError" role="alert" />
      <h3>
        {{ note?.title }}
        <span class="share-badge">{{ share.enabled ? '分享已开启' : '私人笔记' }}</span>
      </h3>
      <template v-if="share.enabled"
        ><label>公开链接</label>
        <div class="share-link">
          <AInput :value="shareUrl" readonly aria-label="公开链接" /><AButton
            type="primary"
            @click="copyShare"
            >复制链接</AButton
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
          ><AButton :loading="shareBusy" :disabled="shareBusy" @click="shareAction('reset')"
            >重置链接</AButton
          ><AButton danger type="text" :disabled="shareBusy" @click="shareAction('revoke')"
            >取消分享</AButton
          ></template
        ><AButton
          v-else
          type="primary"
          :loading="shareBusy"
          :disabled="shareBusy"
          aria-label="生成分享链接"
          @click="shareAction('create')"
          >生成分享链接</AButton
        ><AButton @click="shareOpen = false">完成</AButton>
      </div></NModal
    >
    <NModal
      v-model:show="createOpen"
      preset="card"
      class="dialog-card"
      :title="createKind === 'note' ? '新建笔记' : '新建文件夹'"
      ><form @submit.prevent="submitCreate">
        <AButton
          v-if="createKind === 'note'"
          type="text"
          :loading="quickBusy"
          :disabled="quickBusy || createBusy"
          @click="quickNote"
          >快速记录到收集箱</AButton
        >
        <AAlert v-if="dialogError" type="error" :message="dialogError" role="alert" />
        <label>所在目录</label
        ><NSelect
          v-model:value="newFolder"
          :options="folders"
          filterable
          aria-label="所在目录"
          :disabled="createBusy"
        /><label>{{ createKind === 'note' ? '文件名' : '文件夹名' }}</label
        ><AInput
          v-model:value="newName"
          :disabled="createBusy"
          autofocus
          :aria-label="createKind === 'note' ? '文件名' : '文件夹名'"
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
          <AButton :disabled="createBusy" @click="createOpen = false">取消</AButton
          ><AButton
            html-type="submit"
            type="primary"
            aria-label="创建"
            :loading="createBusy"
            :disabled="createBusy || !newName.trim()"
            >创建</AButton
          >
        </div>
      </form></NModal
    >
    <NModal
      v-model:show="leaveOpen"
      preset="card"
      class="dialog-card"
      title="当前笔记尚未保存"
      :mask-closable="false"
      ><AAlert v-if="dialogError" type="error" :message="dialogError" role="alert" />
      <p>离开前，请选择如何处理当前编辑内容。</p>
      <div class="dialog-actions">
        <AButton @click="leave('cancel')">取消</AButton
        ><AButton @click="leave('discard')">放弃修改</AButton
        ><AButton type="primary" :loading="busy" :disabled="busy" @click="leave('save')"
          >保存并继续</AButton
        >
      </div></NModal
    >
    <NModal v-model:show="deleteOpen" preset="card" class="dialog-card" title="移入回收站？"
      ><AAlert v-if="dialogError" type="error" :message="dialogError" role="alert" />
      <p>已保存原文将移入回收站，分享立即失效。{{ dirty ? '当前未保存输入将被放弃。' : '' }}</p>
      <div class="dialog-actions">
        <AButton @click="deleteOpen = false">取消</AButton
        ><AButton v-if="pendingDelete" @click="run(checkDelete)">核对删除结果</AButton
        ><AButton v-else danger type="primary" @click="removeNote">移入回收站</AButton>
      </div></NModal
    >
    <NModal v-model:show="revisionsOpen" preset="card" class="dialog-card" title="历史版本"
      ><AAlert v-if="dialogError" type="error" :message="dialogError" role="alert" />
      <p class="muted">恢复前会保留当前原文，并检查版本是否变化。</p>
      <div v-for="r in revisions" :key="r.id" class="revision-item">
        <div class="utility-row">
          <span>{{
            new Date(r.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
          }}</span
          ><AButton @click="restoreRevision(r)">恢复此版本</AButton>
        </div>
        <details>
          <summary>查看原文</summary>
          <AButton @click="run(() => readRevision(r))">{{
            r.cursor ? '下一片段' : '加载片段'
          }}</AButton>
          <pre>{{ r.content }}</pre>
        </details>
      </div>
      <AButton v-if="revisionCursor" :loading="busy" @click="history(true)">加载更早版本</AButton>
      <p v-if="revisions.length" class="muted">已显示 {{ revisions.length }} 个版本</p>
      <p v-if="!revisions.length">尚无历史版本</p></NModal
    >
    <NModal
      :show="!!restoreTarget"
      preset="card"
      class="dialog-card"
      title="原位置已被占用"
      :on-close="() => (restoreTarget = undefined)"
      ><AAlert v-if="dialogError" type="error" :message="dialogError" role="alert" />
      <p>请输入新文件名恢复，现有文件不会被覆盖。</p>
      <AInput
        v-model:value="restoreName"
        aria-label="恢复文件名"
        placeholder="新文件名.md"
        :disabled="!!restoringId"
      />
      <div class="dialog-actions">
        <AButton :disabled="!!restoringId" @click="restoreTarget = undefined">取消</AButton>
        <AButton
          type="primary"
          :loading="!!restoringId"
          :disabled="!!restoringId || !restoreName.trim()"
          @click="restoreTrash(restoreTarget, restoreName)"
          >使用新名称恢复</AButton
        >
      </div></NModal
    >
  </div>
</template>
