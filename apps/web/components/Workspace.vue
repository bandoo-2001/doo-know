<script setup lang="ts">
import {markdownTasks} from '../../../shared/markdown-tasks';

import { defineAsyncComponent, ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue';
import { NInput, NModal, NAlert } from 'naive-ui';
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
import TreeContextMenu, { type TreeAction } from './TreeContextMenu.vue';
import NoteCollection from './NoteCollection.vue';
import NoteEditorHost from './NoteEditorHost.vue';
import {documentEditorEnabled} from '../editor/compatibility';
import type {EditorKind} from '../editor/contracts';
import {captureAssetTarget,resolveAssetTarget,type AssetTarget} from '../editor/asset-bookmark';
import EditorToolbar from './EditorToolbar.vue';
import DocumentBreadcrumb from './DocumentBreadcrumb.vue';
import { emptyToolbarState, type MarkdownAction } from '../editor/toolbar-state';
import DocumentOutline from './DocumentOutline.vue';
import { outlineFromTokens, type OutlineHeading } from '../document-outline';

import WorkspaceFooter from './WorkspaceFooter.vue';
import SettingsWorkspace from './settings/SettingsWorkspace.vue';
import TransferPanel from './settings/TransferPanel.vue';
import StatusDrawer from './StatusDrawer.vue';
import TrashWorkspace from './TrashWorkspace.vue';
import { settingsSections, normalizeSettingsSection } from '../settings';
import { editorPreferences, setEditorPreferences } from '../preferences';
import type { SettingsSection } from '../../../shared/settings-contracts';
import PluginSlot from './PluginSlot.vue';
import PluginPanel from './PluginPanel.vue';
import GitRemotePanel from './GitRemotePanel.vue';
import { gitUnsaved, type WorkspaceChangeDetail } from '../git-sync';
import NoteActions from './NoteActions.vue';
import SidebarResizer from './SidebarResizer.vue';
import DraftRecovery from './DraftRecovery.vue';
import NoteMoveDialog from './NoteMoveDialog.vue';
import DirectoryTreeSelect from './DirectoryTreeSelect.vue';
import SetupImport from './SetupImport.vue';
import { useNoteDraft } from '../useNoteDraft';
import { filenameResults, mergeSearchResults } from '../search-results';
import { noteDraftBase } from '../drafts';
import { clearPluginDrafts } from '../plugin-drafts';
import {
  createWorkspaceNavigation,
  readWorkspaceRoute,
  type WorkspaceRoute,
  type WorkspaceNavigationState,
} from '../navigation';
import { refreshPlugins, disposePluginUIs, pluginRegistry } from '../plugins';
import type {
  NoteInfo,
  FileReply,
  OutlinePage,
  FileOperation,
  SearchOutput,
  MoveNoteResult,
} from '../../../shared/knowledge-contracts';
const LargeFileWorkspace=defineAsyncComponent(()=>import('./LargeFileWorkspace.vue'));
const noteInfo = ref<NoteInfo>(),
  largeRef = ref<InstanceType<typeof LargeFileWorkspace>>(),
  largeDirty = ref(false);
const initialNoteId = new URLSearchParams(window.location.search).get('note');
const noteLine = ref<number | undefined>();
const editorRef = ref<InstanceType<typeof NoteEditorHost>>();
const documentEditingEnabled=documentEditorEnabled();
const editorKind=ref<EditorKind>(documentEditingEnabled?editorPreferences.editorKind:'source');
const editorComposing=ref(false),editorHint=ref('');
watch(()=>editorPreferences.editorKind,value=>{editorKind.value=documentEditingEnabled?value:'source'});
async function switchEditing(kind:EditorKind,sourceOffset?:number){if(editorKind.value===kind&&mode.value==='edit'&&sourceOffset===undefined)return;try{const saved=await editorRef.value?.flush();editorKind.value=kind;mode.value='edit';editorHint.value='';await nextTick();if(saved)editorRef.value?.focus(sourceOffset===undefined?saved.selection:{anchor:sourceOffset,head:sourceOffset,affinity:'after'});}catch(cause){showError(cause);}}
async function changeNoteView(view:'edit'|'preview'|'split'){try{await editorRef.value?.flush();mode.value=view;}catch(cause){showError(cause);}}
const mainRef = ref<HTMLElement>();
const noteOpening = ref(false),
  editorTransfer = ref(false);
const moveTarget = ref<NoteDocument>();
const moveOpen = ref(false),
  importOpen = ref(false),
  quickBusy = ref(false);
const parsedLine = Number(window.location.hash.match(/^#L([1-9]\d*)$/)?.[1]);
const initialLine =
  Number.isSafeInteger(parsedLine) && parsedLine <= 20 * 1024 * 1024 ? parsedLine : undefined;
const props = withDefaults(defineProps<{ username?: string; serviceUnavailable?: string }>(), {
  username: '当前账户',
  serviceUnavailable: '',
});
const emit = defineEmits<{ logout: []; 'retry-service': [] }>();
function returnGitSave() {
  gitSyncOpen.value = false;
  openNotes();
}
const gitSyncOpen = ref(false);
const gitAvailable = computed(() =>
  pluginRegistry.value.installed?.some((entry) => entry.id === 'git' && entry.state === 'enabled'),
);
const statusOpen = ref(false),
  createMenuOpen = ref(false);
let returnRoute: WorkspaceRoute = {};
function openImport() {
  createMenuOpen.value = false;
  importFolder.value =
    folder.value || note.value?.relativePath.split('/').slice(0, -1).join('/') || '00-Inbox';
  importOpen.value = true;
}
function storedSidebarWidth() {
  try {
    const width = Number(localStorage.getItem('dooknow.sidebarWidth'));
    if (Number.isFinite(width) && width >= 240 && width <= 400) return width;
  } catch {}
  return 260;
}
const sidebarCollapsed = ref(false);
const editorState = ref(emptyToolbarState());
const navigationState = ref<WorkspaceNavigationState>({ canBack: false, canForward: false });
const sidebarWidth = ref(storedSidebarWidth()),
  showLineNumbers = ref(editorPreferences.lineNumbers),
  releaseVersion = ref('');
function saveSidebarWidth() {
  try {
    localStorage.setItem('dooknow.sidebarWidth', String(sidebarWidth.value));
  } catch {}
}
const tree = ref<TreeEntry[]>([]),
  treeLoaded = ref(false),
  note = ref<NoteDocument>(),
  folder = ref(''),
  selected = ref(''),
  draft = ref(''),
  savedContent = ref(''),
  mode = ref<'edit' | 'preview' | 'split'>(editorPreferences.mode),
  drawer = ref(true),
  busy = ref(false),
  error = ref(''),
  notice = ref('');
const treeMenu = ref<InstanceType<typeof TreeContextMenu>>();
const treeMenuPath = ref('');
let treeRefreshEpoch = 0;
const collection = ref<'notes' | 'recent' | 'favorites'>('notes');
const favoriteBusy = ref(false);
const favoriteIds = computed(() =>
  flat.value.filter((entry) => entry.favorite && entry.id).map((entry) => entry.id!),
);
const currentFavorite = computed(() => !!note.value && favoriteIds.value.includes(note.value.id));
const collectionEntries = computed(() =>
  flat.value
    .filter(
      (entry) =>
        entry.type === 'note' && entry.id && (collection.value !== 'favorites' || entry.favorite),
    )
    .sort(
      (a, b) =>
        (Date.parse(b.updatedAt || '') || 0) - (Date.parse(a.updatedAt || '') || 0) ||
        a.path.localeCompare(b.path, 'zh-CN'),
    ),
);
async function toggleFavorite(id: string) {
  if (favoriteBusy.value) return;
  favoriteBusy.value = true;
  try {
    const result = await api<{ favorite: boolean }>(`/api/notes/${id}/favorite`, 'PUT', {
      favorite: !favoriteIds.value.includes(id),
    });
    // A tree read started before this mutation must not restore its old favorite state.
    treeRefreshEpoch++;
    const entry = flat.value.find((item) => item.id === id);
    if (entry) entry.favorite = result.favorite;
    tell(result.favorite ? '已收藏' : '已取消收藏');
  } finally {
    favoriteBusy.value = false;
  }
}
async function showCollection(view: 'recent' | 'favorites') {
  await openNotes();
  collection.value = view;
  query.value = '';
  sidebarCollapsed.value = false;
  drawer.value = true;
  await run(refresh);
}
function showTreeMenu(entry: TreeEntry, event: MouseEvent | KeyboardEvent) {
  treeMenu.value?.open(entry, event);
}
async function treeAction(entry: TreeEntry, action: TreeAction) {
  await run(async () => {
    if (action === 'favorite' && entry.id) {
      await toggleFavorite(entry.id);
    } else if (action === 'copy') {
      await navigator.clipboard.writeText(entry.path);
      tell('路径已复制');
    } else if (action === 'new-note' || action === 'new-folder') {
      create(action === 'new-note' ? 'note' : 'folder', entry.path);
    } else if (action === 'import') {
      importFolder.value = entry.path;
      importOpen.value = true;
    } else if (action === 'open') {
      if (entry.type !== 'note' || note.value?.id !== entry.id) await select(entry);
      else {
        await retainNoteContext();
        panel.value = 'note';
        selected.value = entry.path;
        drawer.value = false;
        navigation.commit({ note: entry.id, line: noteLine.value });
      }
    } else if (action === 'download' && entry.id) {
      await downloadNote({ id: entry.id, relativePath: entry.path });
    } else if ((action === 'move' || action === 'delete') && entry.id) {
      const apply = async () => {
        if (note.value?.id !== entry.id) await openNote(entry.id!);
        if (note.value?.id !== entry.id) return;
        if (action === 'move') await showMove();
        else confirmDelete();
      };
      if (note.value?.id !== entry.id) await guard(apply);
      else await apply();
    }
  });
}
const dialogError = ref('');
const searchMode = ref<'text' | 'semantic' | 'hybrid'>('hybrid'),
  searchDirectory = ref(''),
  searchDegraded = ref(false),
  vectorReady = ref(false);
const importFolder = ref('40-Resources'),
  importBusy = ref(false),
  downloading = ref(false),
  outlineOpen = ref(false);
watch(mode, () => {
  outlineOpen.value = false;
});
const collapsedOutline = ref<OutlineHeading[]>([]);
watch(
  () => note.value?.id,
  () => {
    collapsedOutline.value = [];
  },
);
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
  () => !!note.value && (editorComposing.value || largeDirty.value || draft.value !== savedContent.value),
);
watch(
  dirty,
  (value) => {
    gitUnsaved.value = value;
  },
  { immediate: true },
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
    enabled: noteInfo.value?.editorMode === 'full' && !editorComposing.value,
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
  canPreserveDraft: (route) =>
    !!route.view ||
    (['settings', 'trash'].includes(panel.value) && !!route.note && note.value?.id === route.note),
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
  if (route.note && ['settings', 'trash'].includes(panel.value) && note.value?.id === route.note) {
    panel.value = 'note';
    drawer.value = false;
    return;
  }
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
  const change = (event as CustomEvent<WorkspaceChangeDetail>).detail;
  const id = change?.scope === 'workspace' ? note.value?.id : change?.noteId;
  void run(async () => {
    await refresh();
    if (id && note.value?.id === id) {
      if (dirty.value) tell('原文已更新，当前未保存草稿会保留，请重新核对版本');
      else await openNote(id, noteLine.value, false, true);
    }
  });
}
const md = new MarkdownIt({ html: false, linkify: true }).use(markdownStyles).use(markdownTasks);
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
function resolveEditorImage(url:string){const path=localPath(url);const asset=assets.value.find(a=>a.relativePath===path);return asset?`/api/assets/${asset.id}`:undefined;}
function openEditorLink(url:string){const path=localPath(url),target=flat.value.find(x=>x.type==='note'&&x.path===path),asset=assets.value.find(a=>a.relativePath===path);if(target&&target.id){void run(()=>openNote(target.id!));return;}if(asset){window.open(`/api/assets/${asset.id}`,'_blank','noopener,noreferrer');return;}if(/^https?:\/\//i.test(url))window.open(url,'_blank','noopener,noreferrer');else tell('未找到此链接对应的笔记或附件，可在链接设置中核对地址');}
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
  const epoch = ++treeRefreshEpoch;
  const entries = await api<TreeEntry[]>('/api/tree');
  if (epoch !== treeRefreshEpoch) return;
  tree.value = entries;
  treeLoaded.value = true;
}
let collectionRefreshing = false;
async function refreshCollection() {
  if (
    collection.value === 'notes' ||
    document.hidden ||
    collectionRefreshing ||
    !treeLoaded.value ||
    ['settings', 'trash'].includes(panel.value)
  )
    return;
  collectionRefreshing = true;
  try {
    await refresh();
  } catch (cause) {
    showError(cause);
  } finally {
    collectionRefreshing = false;
  }
}
async function openNote(id: string, line?: number, syncUrl = true, preserveDraft = false) {
  await guard(async () => {
    const useDefaultMode = note.value?.id !== id;
    const originalDraft = draft.value,
      originalSaved = savedContent.value;
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
      if (
        preserveDraft &&
        (dirty.value || draft.value !== originalDraft || savedContent.value !== originalSaved)
      ) {
        tell('原文已更新，当前未保存草稿会保留，请重新核对版本');
        return;
      }
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
      if (!preserveDraft) {
        drawer.value = false;
        panel.value = 'note';
      }
      if (useDefaultMode) mode.value = editorPreferences.mode;
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
  if(noteInfo.value?.editorMode === 'full') {try {await editorRef.value?.flush();}catch(cause){showError(cause);if(!dirty.value)return;}}
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
async function checkSave(): Promise<'succeeded' | 'failed' | undefined> {
  const pending = pendingSave.value,
    epoch = viewEpoch;
  if (!pending || busy.value) return;
  busy.value = true;
  try {
    let op: FileOperation & { result?: { modifiedAt: string } };
    try {
      op = await api(`/api/operations?requestId=${encodeURIComponent(pending.requestId)}`);
    } catch (cause) {
      if (
        !(cause instanceof ApiError) ||
        cause.status !== 404 ||
        cause.data.code !== 'OPERATION_NOT_FOUND'
      )
        throw cause;
      if (!currentView(pending.noteId, epoch))
        throw new Error('请返回原笔记后重试保存，当前草稿已保留。');
      await save(pending.expected, pending.content, pending.revisionId, pending);
      return;
    }
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
      return 'succeeded';
    }
    if (['failed', 'cancelled'].includes(op.status)) {
      pendingSave.value = undefined;
      tell('上次操作未完成，草稿已保留');
      return 'failed';
    }
    throw new Error('操作仍在处理，请稍后核对');
  } finally {
    editorTransfer.value = false;
    busy.value = false;
  }
}
async function save(
  expected?: string,
  content?: string,
  revisionId?: string,
  retry?: NonNullable<typeof pendingSave.value>,
) {
  if (!note.value || (busy.value && !retry) || props.serviceUnavailable) return;
  if(!retry && content === undefined && noteInfo.value?.editorMode === 'full'){const targetId=note.value.id;try{await editorRef.value?.flush();}catch(cause){showError(cause);return;}if(note.value?.id!==targetId || (busy.value && !retry))return;}
  if (
    noteInfo.value?.editorMode === 'full' &&
    !revisionId &&
    !dirty.value &&
    pendingSave.value?.noteId !== note.value.id
  )
    return;
  if (noteInfo.value?.editorMode !== 'full' && !revisionId && !retry) {
    await largeRef.value?.save();
    return;
  }
  if (!retry && pendingSave.value) {
    const pendingNoteId = pendingSave.value.noteId,
      targetId = note.value.id,
      epoch = viewEpoch;
    let outcome: Awaited<ReturnType<typeof checkSave>>;
    await run(async () => {
      outcome = await checkSave();
    });
    if (
      !currentView(targetId, epoch) ||
      (outcome !== 'failed' && !(outcome === 'succeeded' && pendingNoteId !== targetId))
    )
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
    const requestId = retry?.requestId || crypto.randomUUID();
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
    if (revisionId || draft.value === text) await localDrafts.clearSaved(target.id, localVersion);
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
const createBusy = ref(false),
  inboxBusy = ref(false);
const createOpen = ref(false),
  createKind = ref<'note' | 'folder'>('note'),
  newName = ref(''),
  newFolder = ref('');
const rootFolderPurposes = [
  { value: '00-Inbox', label: '收集箱 · 临时想法和待整理资料' },
  { value: '10-Projects', label: '项目 · 正在推进的任务' },
  { value: '20-Areas', label: '领域 · 长期关注与日常事务' },
  { value: '30-Knowledge', label: '知识 · 主题笔记和学习整理' },
  { value: '40-Resources', label: '资料 · 阅读参考和导入文件' },
  { value: '50-Journal', label: '日记 · 日常记录和复盘' },
  { value: '90-Archive', label: '归档 · 已完成或暂存的旧资料' },
  { value: '99-System', label: '系统 · 知识库说明和维护资料' },
];
const inboxAvailable = computed(() =>
  flat.value.some((entry) => entry.type === 'folder' && entry.path === '00-Inbox'),
);
const rootNoteNeedsFolder = computed(
  () =>
    createKind.value === 'note' &&
    !newFolder.value &&
    (newName.value.endsWith('.md') ? newName.value : newName.value + '.md') !== 'README.md',
);
const rootFolderNeedsPurpose = computed(
  () =>
    createKind.value === 'folder' &&
    !newFolder.value &&
    !rootFolderPurposes.some((purpose) => purpose.value === newName.value),
);
let createRequestId = crypto.randomUUID();
function create(kind: 'note' | 'folder', parent?: string) {
  if (!treeLoaded.value) return;
  dialogError.value = '';
  createRequestId = crypto.randomUUID();
  createKind.value = kind;
  newFolder.value =
    parent ??
    (folder.value || (folders.value.some((x) => x.value === '00-Inbox') ? '00-Inbox' : ''));
  newName.value = kind === 'note' && !newFolder.value ? 'README.md' : '';
  createOpen.value = true;
}
async function prepareInbox() {
  if (inboxBusy.value || createBusy.value || quickBusy.value) return;
  inboxBusy.value = true;
  dialogError.value = '';
  try {
    let failure: unknown;
    if (!inboxAvailable.value) {
      try {
        await api('/api/folders', 'POST', { parent: '', name: '00-Inbox' });
      } catch (cause) {
        failure = cause;
      }
    }
    await refresh();
    if (!inboxAvailable.value) throw failure || new Error('Inbox is not available');
    newFolder.value = '00-Inbox';
    createRequestId = crypto.randomUUID();
  } catch {
    dialogError.value = '暂时无法准备收集箱，请重试。文件名已保留。';
  } finally {
    inboxBusy.value = false;
  }
}
async function submitCreate() {
  if (
    createBusy.value ||
    inboxBusy.value ||
    !newName.value.trim() ||
    rootNoteNeedsFolder.value ||
    rootFolderNeedsPurpose.value
  )
    return;
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
  deleteOpen = ref(false);
const deleteTarget = ref<NoteDocument>();
function confirmDelete() {
  if (!note.value) return;
  deleteTarget.value = { ...note.value };
  dialogError.value = '';
  deleteOpen.value = true;
}
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
async function openTrash(syncUrl = true) {
  await run(async () => {
    await retainNoteContext();
    panel.value = 'trash';
    drawer.value = false;
    if (syncUrl) navigation.commit({ view: 'trash' });
  });
}
async function retainNoteContext() {
  if(noteInfo.value?.editorMode === 'full') await editorRef.value?.flush();
  await localDrafts.flush();
  if (!['settings', 'trash'].includes(panel.value)) {
    const route = navigation.currentRoute();
    // A directly opened utility page must not become its own return destination.
    if (!route.view) returnRoute = route;
  }
  // Keep in-flight saves attached to the retained editor; only cancel a pending note open.
  if (noteOpening.value) viewEpoch++;
  noteOpening.value = false;
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
    const target = deleteTarget.value,
      epoch = viewEpoch;
    if (!target) return;
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
const activeSetting = ref<SettingsSection>('editor');
watch(
  [panel, activeSetting],
  () => {
    if (mainRef.value) mainRef.value.scrollTop = 0;
  },
  { flush: 'post' },
);
function rememberedSetting(): SettingsSection {
  try {
    return normalizeSettingsSection(sessionStorage.getItem('dooknow.lastSettings') || undefined);
  } catch {
    return 'editor';
  }
}
function scrollSetting(section: SettingsSection, syncUrl = true) {
  activeSetting.value = section;
  try {
    sessionStorage.setItem('dooknow.lastSettings', section);
  } catch {}
  if (syncUrl && panel.value === 'settings') navigation.commit({ view: 'settings', section });
  drawer.value = false;
}
async function settings(section?: string, syncUrl = true) {
  const target = section ? normalizeSettingsSection(section) : rememberedSetting();
  if (panel.value === 'settings') {
    scrollSetting(target, syncUrl);
    return;
  }
  await run(async () => {
    await retainNoteContext();
    panel.value = 'settings';
    drawer.value = false;
    scrollSetting(target, false);
    if (syncUrl) navigation.commit({ view: 'settings', section: target });
  });
}
async function backFromSettings() {
  if (returnRoute.note && note.value?.id === returnRoute.note) {
    panel.value = 'note';
    drawer.value = false;
    navigation.commit(returnRoute);
    return;
  }
  await applyRoute(returnRoute);
  navigation.commit(returnRoute);
}
async function openNotes() {
  collection.value = 'notes';
  sidebarCollapsed.value = false;
  if (panel.value === 'settings' || panel.value === 'trash') await run(backFromSettings);
}
watch(
  () => editorPreferences.lineNumbers,
  (value) => (showLineNumbers.value = value),
);
watch(showLineNumbers, (value) => {
  if (value !== editorPreferences.lineNumbers) setEditorPreferences({ lineNumbers: value });
});
watch(
  () => editorPreferences.mode,
  (value) => (mode.value = value),
);
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
async function showMove(expectedId = note.value?.id) {
  await guard(async () => {
    if (!note.value || note.value.id !== expectedId)
      throw new Error('笔记已切换，请重新打开菜单后再整理。');
    moveTarget.value = { ...note.value };
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
async function downloadNote(
  target: Pick<NoteDocument, 'id' | 'relativePath'> | undefined = note.value,
) {
  if (!target || downloading.value) return;
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
let uploadTarget:AssetTarget|undefined;
const pendingAsset=ref<{noteId:string;markdown:string;name:string}>();
async function prepareUpload(){try{const snapshot=await editorRef.value?.flush();uploadTarget=snapshot?captureAssetTarget(snapshot):undefined;uploadInput.value?.click();}catch(cause){showError(cause);}}
async function insertPendingAsset(){const asset=pendingAsset.value;if(!asset||asset.noteId!==note.value?.id)return;try{await editorRef.value?.flush();if(editorRef.value?.insertAsset(asset.markdown))pendingAsset.value=undefined;}catch(cause){showError(cause);}}

async function upload(event:Event){const input=event.target as HTMLInputElement,file=input.files?.[0];if(!file)return;const target=uploadTarget;uploadTarget=undefined;try{await uploadFile(file,target);}finally{input.value='';}}
async function uploadPastedFile(file:File){const id=note.value?.id,epoch=viewEpoch;try{const snapshot=await editorRef.value?.flush();if(!id||!currentView(id,epoch)){tell('笔记已切换，请在目标笔记重新粘贴附件');return;}await uploadFile(file,snapshot?captureAssetTarget(snapshot):undefined);}catch(cause){showError(cause);}}
async function uploadFile(file:File,target?:AssetTarget){if(!note.value)return;if(target&&(target.noteId!==note.value.id||target.generation!==viewEpoch)){tell('插入位置已变化，请重新选择附件');return;}
  const id = note.value.id,
    epoch = viewEpoch;
  await run(async () => {
    const data = new FormData();
    data.append('file', file);
    const a = await api(`/api/notes/${id}/assets`, 'POST', data);
    const attachments = await api(`/api/notes/${id}/assets`);
    if (!currentView(id, epoch)) {
      pendingAsset.value={noteId:id,markdown:`${a.mime === 'application/pdf' ? '[' : '!['}${file.name.replace(/[\\[\]]/g,'\\$&')}](${a.markdownPath})`,name:file.name};
      tell('附件已上传，可返回原笔记插入链接');
      return;
    }
    assets.value = attachments;
    const label=file.name.replace(/[\\[\]]/g,'\\$&');
    const markdown=`${a.mime === 'application/pdf' ? '[' : '!['}${label}](${a.markdownPath})`;
    if(editorRef.value){
      const current=await editorRef.value.flush();
      if(!currentView(id,epoch))return;
      const bookmark=documentEditingEnabled?(target?resolveAssetTarget(target,current):undefined):{anchor:current.markdown.length,head:current.markdown.length,affinity:'after' as const};
      if(!bookmark||!editorRef.value.insertAsset(documentEditingEnabled?markdown:`\n${markdown}\n`,bookmark)){pendingAsset.value={noteId:id,markdown,name:file.name};tell('附件已上传，请选择位置后插入');return;}
    }else{pendingAsset.value={noteId:id,markdown,name:file.name};tell('附件已上传，请打开编辑器后插入');return;}
    tell('附件已插入，请手动保存笔记');
  });
}
function clickPreview(event: MouseEvent) {
  const a = (event.target as HTMLElement).closest('a');
  if (a?.getAttribute('href')?.startsWith('#note-')) {
    event.preventDefault();
    void run(() => openNote(a.getAttribute('href')!.slice(6)));
  }
}
let searchEpoch = 0;
function describeSearchFailure(cause: unknown) {
  const code =
    cause instanceof ApiError
      ? String(cause.data.code || (cause.data.error as any)?.code || '')
      : '';
  if (code === 'TOKENIZER_UNAVAILABLE' || code === 'NOT_PREPARED')
    return '内容搜索组件还未准备好，文件名搜索仍可使用。';
  if (code === 'VECTOR_NOT_CONFIGURED') return '按意思搜索还未准备好，文件名搜索仍可使用。';
  if (code === 'INDEX_NOT_READY') return '搜索索引还在准备中，可以稍后重试。';
  return '暂时无法完成内容搜索，请检查连接或搜索设置后重试。文件名搜索仍可使用。';
}
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
  searchDegraded.value = false;
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
        if (!vectorReady.value) throw new ApiError(503, { code: 'VECTOR_NOT_CONFIGURED' });
      }
      const response = await searchPage(q, undefined, epoch);
      if (epoch !== searchEpoch) return;
      searchWaiting.value = !!(
        response &&
        ++attempts < 15 &&
        (response.index.pending || (!response.degraded && !results.value.length && attempts < 3))
      );
      if (searchWaiting.value) searchTimer = setTimeout(() => void search(), 1000);
    } catch (e) {
      if (epoch === searchEpoch) {
        searchError.value = describeSearchFailure(e);
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
    if (epoch === searchEpoch) searchError.value = describeSearchFailure(e);
  } finally {
    if (epoch === searchEpoch) searchBusy.value = false;
  }
}
watch([query, searchMode, searchDirectory], () => beginSearch(query.value));
function shortcut(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    if (panel.value === 'note') void save();
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
    void refreshCollection();
  }, 5000);
  window.addEventListener('focus', refreshCollection);
  document.addEventListener('visibilitychange', refreshCollection);
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
  window.addEventListener('dooknow-git-return-save', returnGitSave);
  window.addEventListener('keydown', shortcut);
  window.addEventListener('beforeunload', unload);
});
onBeforeUnmount(() => {
  gitUnsaved.value = false;
  clearPluginDrafts();
  navigation.dispose();
  clearInterval(pluginTimer);
  window.removeEventListener('focus', refreshCollection);
  document.removeEventListener('visibilitychange', refreshCollection);
  void disposePluginUIs();
  window.removeEventListener('dooknow-workspace-changed', workspaceChanged);
  window.removeEventListener('dooknow-notice', pluginNotice);
  clearTimeout(searchTimer);
  clearTimeout(noticeTimer);
  window.removeEventListener('dooknow-git-return-save', returnGitSave);
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
      <nav v-if="panel === 'settings'" class="settings-sidebar" aria-label="设置分类">
        <button class="settings-return" @click="backFromSettings">
          <Icon name="back" :size="18" /><span>返回笔记</span>
        </button>
        <button
          v-for="item in settingsSections"
          :key="item.key"
          :aria-current="activeSetting === item.key ? 'page' : undefined"
          @click="scrollSetting(item.key)"
        >
          <Icon :name="item.icon" :size="18" /><span>{{ item.label }}</span>
        </button>
      </nav>
      <div v-show="panel !== 'settings'" class="notebook-sidebar-content">
        <div class="sidebar-actions">
          <AInput
            v-model:value="query"
            allow-clear
            placeholder="搜索笔记与目录"
            aria-label="搜索笔记与目录"
            ><template #prefix><Icon name="search" :size="17" /></template
          ></AInput>
          <div class="sidebar-create">
            <AButton
              type="primary"
              :disabled="!treeLoaded"
              aria-label="新建笔记"
              title="新建笔记"
              @click="create('note')"
              ><template #icon><Icon name="plus" :size="16" /></template><span>新建</span></AButton
            ><APopover v-model:open="createMenuOpen" trigger="click" placement="bottomRight">
              <template #content
                ><div
                  class="create-menu"
                  role="dialog"
                  aria-label="创建与导入"
                  @keydown.esc.stop="createMenuOpen = false"
                >
                  <button
                    :disabled="!treeLoaded"
                    @click="
                      createMenuOpen = false;
                      create('note');
                    "
                  >
                    <Icon name="file" />新建笔记
                  </button>
                  <button
                    :disabled="!treeLoaded"
                    @click="
                      createMenuOpen = false;
                      create('folder');
                    "
                  >
                    <Icon name="folder" />新建文件夹
                  </button>
                  <button @click="openImport"><Icon name="file" />导入 Markdown</button>
                </div></template
              >
              <button
                class="create-more"
                type="button"
                aria-label="创建与导入"
                title="创建与导入"
                :aria-expanded="createMenuOpen"
              >
                <Icon name="chevron" :size="12" />
              </button>
            </APopover>
          </div>
        </div>
        <div class="tree-heading">
          <span>{{
            query
              ? '搜索结果'
              : collection === 'recent'
                ? '最近编辑'
                : collection === 'favorites'
                  ? '收藏'
                  : '笔记本'
          }}</span
          ><button
            class="icon-button"
            :disabled="!treeLoaded"
            aria-label="新建文件夹"
            @click="create('folder')"
          >
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
            <p v-if="searchDegraded && !searchError" class="search-feedback" role="status">
              部分内容搜索或索引尚未准备好，结果可能不完整。<button
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
              <AButton size="small" @click="settings('search')">检查搜索设置</AButton>
            </div>
            <AButton
              v-if="searchCursor && !searchError"
              :loading="searchBusy"
              :disabled="searchBusy"
              @click="moreSearch"
              >加载更多搜索结果</AButton
            >
            <p
              v-if="
                !results.length && !searchBusy && !searchWaiting && !searchError && !searchDegraded
              "
              class="muted empty-search"
            >
              没有匹配的笔记
            </p></template
          ><NoteCollection
            v-else-if="collection !== 'notes'"
            :entries="collectionEntries"
            :selected="selected"
            :kind="collection"
            :menu-path="treeMenuPath"
            @select="select"
            @menu="showTreeMenu"
          /><TreeBranch
            v-else
            :entries="tree"
            :selected="selected"
            :menu-path="treeMenuPath"
            @select="select"
            @menu="showTreeMenu"
          />
        </div>
        <div
          v-if="
            gitAvailable ||
            pluginRegistry.contributions.some(
              (c) => c.slot === 'navigation' || c.slot === 'libraryAction',
            )
          "
          class="sidebar-tools"
        >
          <span class="sidebar-section-title">扩展工具</span>
          <AButton v-if="gitAvailable" type="text" @click="gitSyncOpen = true">云端同步</AButton>
          <PluginSlot slot-name="navigation" :context="pluginContext" />
          <PluginSlot slot-name="libraryAction" :context="pluginContext" />
        </div>
      </div>
      <WorkspaceFooter
        :username="props.username"
        :active="panel"
        :collection="collection"
        @collection="showCollection"
        @settings="settings"
        @trash="openTrash()"
        @status="statusOpen = true"
        @logout="logout"
        @notes="openNotes"
      />
    </aside>
    <NModal
      v-model:show="gitSyncOpen"
      preset="card"
      class="dialog-card"
      title="云端同步"
      style="width: min(760px, calc(100vw - 24px)); max-height: 90vh; overflow-y: auto"
      ><GitRemotePanel v-if="gitSyncOpen" @return-save="gitSyncOpen = false"
    /></NModal>
    <SidebarResizer v-model="sidebarWidth" @commit="saveSidebarWidth" />
    <main
      ref="mainRef"
      :class="['main-content', { 'utility-scroll': panel === 'settings' || panel === 'trash' }]"
      :tabindex="panel === 'settings' || panel === 'trash' ? 0 : undefined"
    >
      <div class="mobile-bar">
        <button class="icon-button" aria-label="打开侧栏" @click="drawer = true">
          <Icon name="menu" /></button
        ><b>DooKnow</b><span>{{ dirty ? '未保存' : '私人笔记' }}</span>
      </div>
      <NAlert
        v-if="props.serviceUnavailable"
        type="warning"
        class="global-error service-unavailable"
        role="alert"
      >
        {{ props.serviceUnavailable }}
        <AButton size="small" @click="emit('retry-service')">重新检查服务</AButton>
      </NAlert>
      <NAlert v-if="error" type="error" closable @close="error = ''" class="global-error">{{
        error
      }}</NAlert>
      <section v-if="note" v-show="panel === 'note'" class="note-workspace">
        <header class="note-header">
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
                @click="
                  run(async () => {
                    await checkSave();
                  })
                "
                >核对保存结果</AButton
              >
              <AButton v-if="pendingDelete && !deleteOpen" @click="run(checkDelete)"
                >核对删除结果</AButton
              >
              <AButton
                class="favorite-button"
                :class="{ 'is-favorite': currentFavorite }"
                :title="currentFavorite ? '取消收藏' : '收藏'"
                :aria-label="currentFavorite ? '取消收藏' : '收藏'"
                :aria-pressed="currentFavorite"
                :disabled="favoriteBusy || noteOpening"
                @click="run(() => toggleFavorite(note!.id))"
                ><template #icon><Icon name="star" /></template
              ></AButton>
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
                :disabled="
                  busy || !!props.serviceUnavailable || (!dirty && pendingSave?.noteId !== note.id)
                "
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
                @upload="prepareUpload"
                @delete="confirmDelete"
                ><PluginSlot slot-name="noteAction" :context="pluginContext"
              /></NoteActions>
            </div>
          </div>
          <div v-if="note.shared" class="shared-status">
            <Icon name="share" :size="14" />已分享，保存后的修改将同步公开
          </div>
          <div v-if="noteInfo?.editorMode === 'full'" class="document-format-row">
            <EditorToolbar
              :label="documentEditingEnabled ? '正文格式' : 'Markdown 格式'"
              :state="editorState"
              :disabled="formatDisabled"
              @format="formatNote"
              @upload="prepareUpload"
            />
            <div class="mode-row">
              <div v-if="documentEditingEnabled" class="mode-tabs">
                <button type="button" :aria-pressed="mode !== 'preview' && editorKind === 'document'" :class="{active:mode !== 'preview' && editorKind === 'document'}" @click="switchEditing('document')">文档编辑</button>
                <button type="button" :aria-pressed="mode !== 'preview' && editorKind === 'source'" :class="{active:mode !== 'preview' && editorKind === 'source'}" @click="switchEditing('source')">Markdown 源码</button>
                <button type="button" :aria-pressed="mode === 'preview'" :class="{active:mode === 'preview'}" @click="changeNoteView('preview')">阅读</button>
              </div>
              <label v-if="documentEditingEnabled && editorKind === 'source' && mode !== 'preview'" class="source-preview-toggle"><input type="checkbox" :checked="mode === 'split'" @change="changeNoteView(($event.target as HTMLInputElement).checked?'split':'edit')"/>同时预览</label>
              <div v-if="!documentEditingEnabled" class="mode-tabs">
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
              <APopover
                v-if="mode === 'split'"
                v-model:open="outlineOpen"
                trigger="click"
                placement="bottomRight"
              >
                <template #content>
                  <DocumentOutline
                    v-model:collapsed="collapsedOutline"
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
          :service-unavailable="props.serviceUnavailable"
          :inert="noteOpening || editorTransfer ? '' : undefined"
          :initial-line="noteLine || (note.id === initialNoteId ? initialLine : undefined)"
          :key="note.id"
          @dirty="(v) => (largeDirty = v)"
          @saved="onLargeSaved"
        />
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
          <div v-if="pendingAsset?.noteId === note.id" class="editor-warning"><span>{{pendingAsset?.name}} 已上传，请选择插入位置。</span><AButton size="small" @click="insertPendingAsset">插入已上传附件</AButton></div>
          <p v-if="editorHint" class="editor-warning" role="status">{{editorHint}}</p>
          <div class="document-body">
            <div class="document-surface">
              <div :class="['editor-panels', mode]">
                <section v-show="mode !== 'preview'" class="editor-panel">
                  <div class="panel-label">{{documentEditingEnabled && editorKind === 'document'?'文档编辑':'Markdown'}} <span>手动保存 · Ctrl+S</span></div>
                  <NoteEditorHost
                    :note-id="note.id"
                    :resolve-image="resolveEditorImage"
                    @open-link="openEditorLink"
                    @upload-file="uploadPastedFile"
                    :generation="viewEpoch"
                    :kind="documentEditingEnabled ? editorKind : 'source'"
                    :visible="mode !== 'preview'"
                    @fallback="reason=>{editorKind='source';editorHint=reason}"
                    @source="switchEditing('source',$event)"
                    @composing="editorComposing=$event"
                    ref="editorRef"
                    v-model="draft"
                    :read-only="
                      noteOpening || editorTransfer || draftLoading || draftBusy || !!recoveryDraft
                    "
                    :key="`${note.id}:${viewEpoch}`"
                    :initial-line="
                      noteLine || (note.id === initialNoteId ? initialLine : undefined)
                    "
                    :show-line-numbers="showLineNumbers"
                    :wrap="editorPreferences.wrap"
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
            <aside v-if="mode !== 'split'" class="document-outline">
              <DocumentOutline
                v-model:collapsed="collapsedOutline"
                :headings="normalOutline"
                :active-line="activeHeading"
                @select="goToHeading"
              />
            </aside>
          </div>
          <p v-if="draftSavedAt && dirty && !editorComposing" class="local-draft-status" role="status">
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
        />
      </section>
      <section v-if="panel === 'empty'" class="utility-view workspace-empty">
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
          <div class="folder-title-row">
            <div class="folder-heading">
              <h1>{{ folder.split('/').at(-1) }}</h1>
              <p class="folder-info">
                {{ folderEntries.filter((x) => x.type === 'folder').length }} 个文件夹 ·
                {{ folderEntries.filter((x) => x.type === 'note').length }} 篇笔记
              </p>
            </div>
            <div class="folder-actions">
              <AButton type="primary" @click="create('note')"
                ><template #icon><Icon name="plus" :size="16" /></template>新建笔记</AButton
              >
              <AButton @click="create('folder')"
                ><template #icon><Icon name="plus" /></template>新建文件夹</AButton
              ><AButton @click="openImport">导入 Markdown</AButton>
            </div>
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
      <TrashWorkspace
        v-else-if="panel === 'trash'"
        @open-note="openNote"
        @changed="run(refresh)"
        @back="backFromSettings"
      />
      <SettingsWorkspace
        v-else-if="panel === 'settings'"
        :section="activeSetting"
        :username="props.username"
        @changed="run(refresh)"
        @back="backFromSettings"
        @logout="logout"
        @open-note="openNote"
      />
    </main>
    <StatusDrawer
      v-model:open="statusOpen"
      @settings="settings"
      @open-note="openNote"
      @changed="run(refresh)"
    />
    <TreeContextMenu
      ref="treeMenu"
      v-model:path="treeMenuPath"
      :favorite-ids="favoriteIds"
      :favorite-busy="favoriteBusy"
      @action="treeAction"
    />
    <NoteMoveDialog
      v-model:show="moveOpen"
      :note-id="moveTarget?.id"
      :relative-path="moveTarget?.relativePath"
      :modified-at="moveTarget?.modifiedAt"
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
      ><DirectoryTreeSelect
        v-model:value="importFolder"
        label="导入目录"
        :disabled="importBusy"
        :folders="[
          ...folders,
          ...(!folders.some((item) => item.value === '40-Resources')
            ? [{ label: '40-Resources（导入时创建）', value: '40-Resources' }]
            : []),
        ]"
      />
      <details class="batch-import-details">
        <summary>批量导入文件或目录</summary>
        <TransferPanel
          :folder-path="importFolder"
          :show-export="false"
          @changed="run(refresh)"
          @open-note="
            (id) => {
              importOpen = false;
              openNote(id);
            }
          "
        />
      </details>
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
      :mask-closable="!createBusy && !inboxBusy"
      :close-on-esc="!createBusy && !inboxBusy"
      :closable="!createBusy && !inboxBusy"
      ><form :aria-busy="createBusy || inboxBusy" @submit.prevent="submitCreate">
        <AButton
          v-if="createKind === 'note'"
          type="text"
          :loading="quickBusy"
          :disabled="quickBusy || createBusy || inboxBusy"
          @click="quickNote"
          >快速记录到收集箱</AButton
        >
        <AAlert v-if="dialogError" type="error" :message="dialogError" role="alert" />
        <label>所在目录</label
        ><DirectoryTreeSelect
          v-model:value="newFolder"
          :folders="folders"
          label="所在目录"
          :disabled="createBusy || inboxBusy"
        />
        <template v-if="createKind === 'folder' && !newFolder">
          <label for="root-folder-purpose">分类用途</label>
          <ASelect
            id="root-folder-purpose"
            aria-label="分类用途"
            style="width: 100%"
            :value="
              rootFolderPurposes.some((purpose) => purpose.value === newName) ? newName : undefined
            "
            :options="rootFolderPurposes"
            :dropdown-style="{ zIndex: 3000 }"
            :disabled="createBusy || inboxBusy"
            placeholder="选择文件夹用途"
            @change="(value) => (newName = String(value))"
          />
        </template>
        <label>{{ createKind === 'note' ? '文件名' : '文件夹名' }}</label
        ><AInput
          v-model:value="newName"
          :disabled="createBusy || inboxBusy"
          autofocus
          :aria-label="createKind === 'note' ? '文件名' : '文件夹名'"
          :placeholder="
            createKind === 'note'
              ? '例如：新的想法.md'
              : !newFolder
                ? '选择上方用途后自动填写'
                : '例如：读书笔记'
          "
        />
        <p class="muted">
          {{
            !newFolder
              ? createKind === 'note'
                ? '根目录仅支持 README.md；普通笔记可放入收集箱，填写的文件名会保留。'
                : '先按用途选择分类，文件夹名会自动填写。'
              : createKind === 'note'
                ? '创建后保存为真实 Markdown 文件，默认私有。'
                : '在所选目录中创建子文件夹。'
          }}
        </p>
        <AButton
          v-if="createKind === 'note' && !newFolder"
          :loading="inboxBusy"
          :disabled="inboxBusy || createBusy || quickBusy"
          @click="prepareInbox"
          >{{ inboxAvailable ? '使用收集箱并继续' : '创建收集箱并继续' }}</AButton
        >
        <div class="dialog-actions">
          <AButton :disabled="createBusy || inboxBusy" @click="createOpen = false">取消</AButton
          ><AButton
            html-type="submit"
            type="primary"
            aria-label="创建"
            :loading="createBusy"
            :disabled="
              createBusy ||
              inboxBusy ||
              !newName.trim() ||
              rootNoteNeedsFolder ||
              rootFolderNeedsPurpose
            "
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
      <p class="tree-delete-path">{{ deleteTarget?.relativePath }}</p>
      <p>
        已保存原文将移入回收站，分享立即失效。{{
          dirty && note?.id === deleteTarget?.id ? '当前未保存输入将被放弃。' : ''
        }}
      </p>
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
  </div>
</template>
