<script setup lang="ts">
import '../whiteboards/whiteboards.css';
import {diagramFences} from '../../../shared/diagram-fences';
import {createEditorSnippet, type EditorSnippet} from '../../../shared/editor-snippets';
import {findDiagramRange,withDiagramPreview} from '../editor/diagram-edits';
import {hashDiagramCode,stripDiagramPreviews,type DiagramSaveNeed} from '../../../shared/diagram-portability';
import {renderPortableFigure} from '../../../shared/portable-figure';
import {frontmatterRange} from '../../../shared/frontmatter-range';
import {collectCurrentDiagramSaveNeeds} from '../diagrams/save-policy';
import {createUploadQueue, type UploadItem} from '../editor/upload-queue';
import type {EditorSnapshot} from '../editor/contracts';
import {isWhiteboard,emptyWhiteboard,whiteboardFence,whiteboardId} from '../../../shared/whiteboard';
import {syncDiagrams,clearDiagrams} from '../whiteboards/diagrams';
import { deferImageSource } from '../image-requests';
import {markdownTasks} from '../../../shared/markdown-tasks';
import {knowledgeMarkdown} from '../../../shared/knowledge-markdown';

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
import LoadingState from './LoadingState.vue';
import TreeBranch from './TreeBranch.vue';
import TreeContextMenu, { type TreeAction } from './TreeContextMenu.vue';
import NoteCollection from './NoteCollection.vue';
import CollectionWorkspace from './CollectionWorkspace.vue';
import { createCollectionFeed } from '../collection-feed';
import type { CollectionNote } from '../../../shared/collection-contracts';
import NoteEditorHost from './NoteEditorHost.vue';
import ShareDialog from './ShareDialog.vue';
import type { ShareOptions, ShareStatus } from '../../../shared/share-contracts';
import {documentEditorEnabled} from '../editor/compatibility';
import type {EditorKind, ImageReplacementTarget, SelectionBookmark} from '../editor/contracts';
import { handleSaveShortcut } from '../editor/keyboard-shortcuts';
import {captureAssetTarget,resolveAssetTarget,type AssetTarget} from '../editor/asset-bookmark';
import EditorToolbar from './EditorToolbar.vue';
import DocumentBreadcrumb from './DocumentBreadcrumb.vue';
import { emptyToolbarState, type MarkdownAction } from '../editor/toolbar-state';
import DocumentOutline from './DocumentOutline.vue';
import { outlineFromTokens, type OutlineHeading } from '../document-outline';
import WorkspaceFooter from './WorkspaceFooter.vue';
import SettingsWorkspace from './settings/SettingsWorkspace.vue';
import SettingsOverlay from './settings/SettingsOverlay.vue';
import TransferPanel from './settings/TransferPanel.vue';
import TrashWorkspace from './TrashWorkspace.vue';
import AppsWorkspace from './AppsWorkspace.vue';
import { createBlogWorkbench, type BlogSection } from '../blog-workbench';
import { prepareBlogDiagrams } from '../blog-diagrams';
import { toDooCaptureFromNote } from '../to-doo-capture';
import type { ToDooCommand, ToDooSnapshot } from '../../../shared/to-doo-contracts';
import { settingsSections, normalizeSettingsSection } from '../settings';
import { editorPreferences, setEditorPreferences } from '../preferences';
import { createEditorViewTransitions } from '../editor/view-transitions';
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
import { searchNeedle } from '../../../shared/search-matching';
import { previewSource } from '../preview-source';
import { markdownDestination, markdownAnchorLines } from '../markdown-links';
import { noteDraftBase } from '../drafts';
import { clearPluginDrafts } from '../plugin-drafts';
import {
  createWorkspaceNavigation,
  readWorkspaceRoute,
  type WorkspaceRoute,
  type WorkspaceNavigationState,
  type ToDooAppSection,
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
const DocumentProperties=defineAsyncComponent(()=>import('./DocumentProperties.vue'));
const EditorInsertMenu=defineAsyncComponent(()=>import('./EditorInsertMenu.vue'));
const MarkdownPaste=defineAsyncComponent(()=>import('./MarkdownPaste.vue'));
const NoteBacklinks=defineAsyncComponent(()=>import('./NoteBacklinks.vue'));
const DiagramSaveDialog=defineAsyncComponent(()=>import('./DiagramSaveDialog.vue'));
const diagramSaveContext=ref<{id:string;epoch:number;markdown:string;needs:DiagramSaveNeed[]}>();
const diagramSaveBusy=ref(false),diagramSaveError=ref('');
const backlinksOpen=ref(false);
async function openBacklink(id:string){backlinksOpen.value=false;await run(()=>openNote(id));}
async function finishDiagramSave(generate:boolean){
  const target=diagramSaveContext.value;
  if(!target||diagramSaveBusy.value)return;
  const isCurrent=()=>currentView(target.id,target.epoch)&&draft.value===target.markdown;
  if(!isCurrent()){diagramSaveContext.value=undefined;tell('正文已变化，请重新保存');return;}
  diagramSaveBusy.value=true;diagramSaveError.value='';
  try{
    let markdown=target.markdown;
    if(generate){
      const {prepareDiagramSource}=await import('../diagrams/prepare-source');
      const {persistDiagramPreview}=await import('../diagrams/persist-preview');
      if(target.needs.length>32)throw Error('本次图形较多，请分批生成通用预览，也可以仅保存源码');
      for(const need of [...target.needs].sort((a,b)=>b.from-a.from)){
        const prepared=await prepareDiagramSource({kind:need.kind,code:need.code,noteId:target.id});
        if(!isCurrent())throw Error('正文已变化，已准备的附件保留，请重新确认保存');
        const result=await persistDiagramPreview({noteId:target.id,notePath:note.value?.relativePath,kind:need.kind,source:prepared.source,png:prepared.png});
        if(!isCurrent())throw Error('笔记已变化，请重新确认保存');
        markdown=withDiagramPreview(markdown,need,result.preview.markdownPath,result.source?.markdownPath,{kind:need.kind,codeHash:need.codeHash,sourceHash:result.sourceHash});
      }
      if((await collectCurrentDiagramSaveNeeds(markdown,markdown,target.id)).length)throw Error('白板设计在生成预览时已变化，请重新生成');
      if(!isCurrent())throw Error('正文已变化，请重新确认保存');
      const attachments=await api(`/api/notes/${target.id}/assets`);
      if(!isCurrent())throw Error('正文已变化，请重新确认保存');
      assets.value=attachments;
    }else markdown=stripDiagramPreviews(markdown,target.needs);
    if(!isCurrent()||!editorRef.value?.replaceMarkdown(markdown,target.markdown))throw Error('正文已变化，请重新确认保存');
    diagramSaveContext.value=undefined;
    await save(undefined,markdown);
    if(!dirty.value&&leaveOpen.value&&pendingNavigation)await leave('save');
  }catch(cause){
    if(currentView(target.id,target.epoch))diagramSaveError.value=cause instanceof Error?cause.message:String(cause);
  }finally{diagramSaveBusy.value=false;}
}
const WhiteboardWorkspace=defineAsyncComponent(()=>import('./WhiteboardWorkspace.vue'));
const embeddedBoardRef=ref<InstanceType<typeof WhiteboardWorkspace>>();
const boardRef=ref<InstanceType<typeof WhiteboardWorkspace>>(), boardDirty=ref(false), embeddedBoardId=ref<string>(),
  boardPickerOpen=ref(false),boardCreating=ref(false);
let boardInsertTarget:{id:string;epoch:number;content:string;selection:SelectionBookmark}|undefined;
const propertiesOpen=ref(false),insertMenuOpen=ref(false),markdownPasteOpen=ref(false),readingExportBusy=ref(false);
let editorDialogSnapshot:{id:string;epoch:number;snapshot:EditorSnapshot}|undefined;
const propertiesSource=ref('');
async function captureEditorDialog() {
  if(!note.value||formatDisabled.value)return false;
  const id=note.value.id,epoch=viewEpoch,snapshot=await editorRef.value?.flush();
  if(!snapshot||!currentView(id,epoch))return false;
  editorDialogSnapshot={id,epoch,snapshot};propertiesSource.value=snapshot.markdown;return true;
}
async function openProperties(){try{if(await captureEditorDialog())propertiesOpen.value=true;}catch(cause){showError(cause);}}
async function openInsertMenu(){try{if(await captureEditorDialog())insertMenuOpen.value=true;}catch(cause){showError(cause);}}
async function openMarkdownPaste(){try{if(await captureEditorDialog())markdownPasteOpen.value=true;}catch(cause){showError(cause);}}
function pasteMarkdown(markdown:string){
  const target=editorDialogSnapshot;
  if(!target||!currentView(target.id,target.epoch)||!editorRef.value?.pasteMarkdown(markdown,target.snapshot.markdown,target.snapshot.selection)){
    tell('正文已变化，请重新选择粘贴位置');return;
  }
  markdownPasteOpen.value=false;
}
function applyProperties(markdown:string){
  const target=editorDialogSnapshot;
  if(!target||!currentView(target.id,target.epoch)||!editorRef.value?.replaceMarkdown(markdown,target.snapshot.markdown)){
    tell('正文已变化，请重新打开属性后修改');return;
  }
  propertiesOpen.value=false;tell('属性已应用，请手动保存笔记');
}
function insertSnippet(item:EditorSnippet){
  const target=editorDialogSnapshot;
  if(!target||!currentView(target.id,target.epoch)){tell('笔记已切换，请重新选择插入位置');return;}
  const snippet=createEditorSnippet(item.id,target.snapshot.markdown);
  if(!editorRef.value?.insertSourceSnippet(snippet.markdown,target.snapshot.markdown,target.snapshot.selection)){
    tell('正文已变化，请重新选择插入位置');return;
  }
  insertMenuOpen.value=false;
}
async function exportReading(print=false){
  if(!note.value||readingExportBusy.value)return;
  const printWindow=print?window.open('','_blank'):null;
  const id=note.value.id,epoch=viewEpoch,title=note.value.title,relativePath=note.value.relativePath;
  readingExportBusy.value=true;
  try{
    const snapshot=await editorRef.value?.flush();
    let markdown=snapshot?.markdown??draft.value;
    if(!currentView(id,epoch)){printWindow?.close();return;}
    const resolverAssets=[...assets.value];
    const stale=await collectCurrentDiagramSaveNeeds(markdown,markdown,id);
    markdown=stripDiagramPreviews(markdown,stale);
    const {buildReadingHtml,downloadReadingHtml,printReadingHtml}=await import('../reading-export');
    const html=await buildReadingHtml({title,markdown,unavailablePreviews:stale.length,resolveImage:async(source)=>{
      const path=localPath(source,relativePath),asset=resolverAssets.find(a=>a.relativePath===path);
      if(!asset||!/^image\//.test(asset.mime||''))return undefined;
      const response=await fetch('/api/assets/'+asset.id,{credentials:'same-origin',redirect:'error',signal:AbortSignal.timeout(15000)});
      if(!response.ok)throw Error('附件暂时无法导出，请重试');return response.blob();
    }});
    if(print)await printReadingHtml(html,printWindow);else downloadReadingHtml(html,title);
  }catch(cause){printWindow?.close();showError(cause);}finally{readingExportBusy.value=false;}
}
const LargeFileWorkspace=defineAsyncComponent(()=>import('./LargeFileWorkspace.vue'));
const noteInfo = ref<NoteInfo>(),
  largeRef = ref<InstanceType<typeof LargeFileWorkspace>>(),
  largeDirty = ref(false);
const blogModel = createBlogWorkbench(api, prepareBlogDiagrams);
const appsApp = ref<WorkspaceRoute['app']>(readWorkspaceRoute().app);
const appsSection = ref<BlogSection | ToDooAppSection>(readWorkspaceRoute().appSection || 'overview');
type ToDooSelection = Pick<WorkspaceRoute, 'task' | 'list' | 'date' | 'calendarView'>;
const toDooSelection = ref<ToDooSelection>({ task: readWorkspaceRoute().task, list: readWorkspaceRoute().list, date: readWorkspaceRoute().date, calendarView: readWorkspaceRoute().calendarView });
const appsRef = ref<InstanceType<typeof AppsWorkspace>>();
type CapturedTask = Extract<ToDooCommand, { action: 'create_task' }>['payload'];
const toDooCaptureOpen = ref(false), toDooCaptureBusy = ref(false), toDooCaptureError = ref('');
const capturedTask = ref<CapturedTask>(), capturedList = ref('inbox');
const captureLists = ref<ToDooSnapshot['lists']>([]);
let captureRequestId = '';
async function captureNoteTask() {
  if (!note.value) return;
  try {
    await editorRef.value?.flush();
    const markdown = noteInfo.value?.editorMode === 'full' ? draft.value : '';
    capturedTask.value = toDooCaptureFromNote({ noteId: note.value.id, title: note.value.title || note.value.relativePath,
      markdown, savedMarkdown: noteInfo.value?.editorMode === 'full' ? savedContent.value : '',
      selection: mode.value === 'preview' ? undefined : editorRef.value?.selection(), contentHash: noteInfo.value?.contentHash });
    captureRequestId = crypto.randomUUID(); capturedList.value = 'inbox'; toDooCaptureError.value = ''; toDooCaptureOpen.value = true;
    const response = await api<ToDooSnapshot>('/api/to-doo/state?kind=list&limit=1000');
    captureLists.value = response.lists.filter(list => !list.deletedAt && !list.archivedAt);
  } catch (cause) { toDooCaptureError.value = cause instanceof Error ? cause.message : '暂时无法准备任务'; }
}
async function saveCapturedTask() {
  if (!capturedTask.value || toDooCaptureBusy.value) return;
  toDooCaptureBusy.value = true; toDooCaptureError.value = '';
  try {
    const result = await api<{ ids: string[] }>('/api/to-doo/commands', 'POST', { requestId: captureRequestId, action: 'create_task', payload: { ...capturedTask.value, listId: capturedList.value === 'inbox' ? null : capturedList.value } });
    toDooCaptureOpen.value = false;
    appsApp.value = 'to-doo'; appsSection.value = 'tasks'; toDooSelection.value = { task: result.ids[0], ...(capturedList.value !== 'inbox' ? { list: capturedList.value } : {}) };
    await openApps();
  } catch (cause) { toDooCaptureError.value = cause instanceof Error ? cause.message : '任务结果待核对，请保留输入后重试'; }
  finally { toDooCaptureBusy.value = false; }
}
async function openBlogNote(id: string) {
  await run(async () => {
    if (note.value?.id === id) {
      await applyRoute({ note: id });
      if (panel.value === 'note') navigation.commit({ note: id });
    } else await openNote(id);
  });
}
async function navigateApp(app: WorkspaceRoute['app'], section: BlogSection | ToDooAppSection = 'overview', selection: ToDooSelection = {}) {
  if (appsApp.value === 'to-doo' && app !== 'to-doo' && (await appsRef.value?.requestLeave()) === false) return;
  appsApp.value = app; appsSection.value = section;
  toDooSelection.value = selection;
  navigation.commit({view:'apps', ...(app ? {app, appSection:section, ...(app === 'to-doo' ? selection : {})} : {})});
}
const initialNoteId = new URLSearchParams(window.location.search).get('note');
const noteLine = ref<number | undefined>();
const editorRef = ref<InstanceType<typeof NoteEditorHost>>();
const documentEditingEnabled=documentEditorEnabled();
const editorKind=ref<EditorKind>(documentEditingEnabled?editorPreferences.editorKind:'source');
const editorComposing=ref(false),editorHint=ref('');
watch(()=>editorPreferences.editorKind,value=>{editorKind.value=documentEditingEnabled?value:'source'});
const editorViews = createEditorViewTransitions({
  current: () => ({ kind: editorKind.value, mode: mode.value }),
  context: () => `${note.value?.id}:${viewEpoch}`,
  flush: () => editorRef.value?.flush() ?? Promise.resolve(undefined),
  apply(change) {
    if ('kind' in change) {
      editorKind.value = change.kind;
      mode.value = 'edit';
      editorHint.value = '';
    } else mode.value = change.mode;
  },
  afterRender: () => nextTick(),
  focus: (bookmark) => editorRef.value?.focus(bookmark),
  cancelPendingFocus: () => editorRef.value?.cancelPendingFocus(),
  error: showError,
});
function switchEditing(kind: EditorKind, sourceOffset?: number) {
  return editorViews.select({ kind, sourceOffset });
}
function changeNoteView(view: 'edit' | 'preview' | 'split') {
  return editorViews.select({ mode: view });
}
const previewRef = ref<HTMLElement>();
const mainRef = ref<HTMLElement>();
const noteOpening = ref(false),
  editorGeneration = ref(0),
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
  gitSyncOverlay.value?.close();
  if (gitSyncOpen.value) return;
  openNotes();
}
const gitSyncOpen = ref(false);
const gitSyncOverlay = ref<InstanceType<typeof SettingsOverlay>>();
const gitPanelBusy = ref(false), gitPanelDirty = ref(false);
const gitAvailable = computed(() =>
  pluginRegistry.value.installed?.some((entry) => entry.id === 'git' && entry.state === 'enabled'),
);
const createMenuOpen = ref(false);
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
  treeRefreshing = ref(true),
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
let treeRefreshRequest: Promise<void> | undefined;
const collection = ref<'notes' | 'recent' | 'favorites'>('notes');
const collectionFeed = createCollectionFeed(api);
const favoriteBusy = ref(false);
const favoriteIds = computed(() => {
  const values = new Map(flat.value.filter(entry => entry.id).map(entry => [entry.id!, !!entry.favorite]));
  for (const [id, value] of collectionFeed.favoriteStates.value) values.set(id, value);
  return [...values].filter(([, favorite]) => favorite).map(([id]) => id);
});
const currentFavorite = computed(() => !!note.value && favoriteIds.value.includes(note.value.id));
const collectionEntries = computed<TreeEntry[]>(() => collection.value === 'notes' ? [] : collectionFeed.entriesFor(collection.value).map(item => ({ ...item, type: 'note', updatedAt: item.updatedAt || undefined })));
async function toggleFavorite(id: string, next = !favoriteIds.value.includes(id)) {
  if (favoriteBusy.value) return;
  favoriteBusy.value = true;
  try {
    const result = await api<{ favorite: boolean }>(`/api/notes/${id}/favorite`, 'PUT', {
      favorite: next,
    });
    // A tree read started before this mutation must not restore its old favorite state.
    treeRefreshEpoch++;
    const entry = flat.value.find((item) => item.id === id);
    if (entry) entry.favorite = result.favorite;
    collectionFeed.updateFavorite(id, result.favorite);
    tell(result.favorite ? '已收藏' : '已取消收藏');
  } finally {
    favoriteBusy.value = false;
  }
}
async function showCollection(view: 'recent' | 'favorites', syncUrl = true, intent = ++navigationIntent) {
  await run(async () => {
    if (await retainNoteContext(intent) === false) return;
    if (!currentIntent(intent)) return;
    collection.value = view;
    panel.value = 'collection';
    query.value = '';
    sidebarCollapsed.value = false;
    drawer.value = false;
    if (syncUrl) navigation.commit({ view });
    await collectionFeed.select(view);
    await collectionFeed.checkForUpdates(view);
    if (collectionFeed.updated.value && collectionFeed.scrollTop.value < 80) await collectionFeed.refresh();
  });
}
async function favoriteCard(item: CollectionNote) { await run(() => toggleFavorite(item.id, !item.favorite)); }
async function createFromCollection() { if (!treeLoaded.value) await run(refresh); create('note'); }
function showTreeMenu(entry: TreeEntry, event: MouseEvent | KeyboardEvent) {
  treeMenu.value?.open(entry, event);
}
function folderRowKey(entry: TreeEntry, event: KeyboardEvent) {
  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
    event.preventDefault();
    event.stopPropagation();
    showTreeMenu(entry, event);
  }
}
async function treeAction(entry: TreeEntry, action: TreeAction) {
  await run(async () => {
    if (action === 'favorite' && entry.id) {
      await toggleFavorite(entry.id);
    } else if (action === 'copy') {
      await navigator.clipboard.writeText(entry.path);
      tell('路径已复制');
    } else if (action === 'new-note' || action === 'new-folder' || action === 'new-whiteboard') {
      create(action === 'new-whiteboard'?'whiteboard':action === 'new-note' ? 'note' : 'folder', entry.path);
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
    } else if (action === 'delete' && entry.type === 'folder') {
      const confirm = async () => {
        folderDeleteTarget.value = { path: entry.path, requestId: crypto.randomUUID() };
        folderDeleteUncertain.value = false;
        dialogError.value = '';
      };
      if (note.value?.relativePath.startsWith(entry.path + '/')) await guard(confirm);
      else await confirm();
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
  searchReasons = ref<string[]>([]),
  vectorReady = ref(false);
const searchRecallLimited = computed(() => searchReasons.value.includes('RECALL_LIMIT'));
const searchFeedback = computed(() => searchRecallLimited.value
  ? '搜索结果已达到候选上限，结果可能不完整。请使用更精确的关键词或缩小目录范围后重试。'
  : '部分内容搜索或索引尚未准备好，结果可能不完整。');
const showSearchSettings = computed(() => !searchRecallLimited.value ||
  searchReasons.value.some((reason) => reason !== 'RECALL_LIMIT'));
const importFolder = ref('40-Resources'),
  importBusy = ref(false),
  batchImportBusy = ref(false),
  downloading = ref(false),
  outlineOpen = ref(false);
const outlineDocked = ref(true), narrowDocument = ref(false);
const outlineWidth = ref(storedOutlineWidth());
function storedOutlineWidth() {
  try {
    const width = Number(localStorage.getItem('dooknow.outlineWidth'));
    if (Number.isFinite(width) && width >= 200 && width <= 420) return width;
  } catch {}
  return 228;
}
function saveOutlineWidth() {
  try { localStorage.setItem('dooknow.outlineWidth', String(outlineWidth.value)); } catch {}
}
const outlineTrigger = ref<InstanceType<typeof AButton>>();
const outlineUsesPopup = computed(() => narrowDocument.value || mode.value === 'split');
let documentResizeObserver: ResizeObserver | undefined;
function measureDocumentWidth() {
  const width = mainRef.value?.clientWidth;
  if (width) narrowDocument.value = width <= 900;
}
function closeOutlineFromKeyboard() {
  outlineOpen.value = false;
  void nextTick(() => (outlineTrigger.value?.$el as HTMLButtonElement | undefined)?.focus());
}
watch(outlineUsesPopup, () => { outlineOpen.value = false; });
watch(mode, () => {
  outlineOpen.value = false;
});
const collapsedOutline = ref<OutlineHeading[]>([]);
watch(
  () => note.value?.id,
  () => {
    collapsedOutline.value = [];
    outlineOpen.value = false;
    propertiesOpen.value=false;insertMenuOpen.value=false;markdownPasteOpen.value=false;backlinksOpen.value=false;diagramSaveContext.value=undefined;editorDialogSnapshot=undefined;
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
let alive = true, navigationIntent = 0;
const currentIntent = (intent: number) => alive && intent === navigationIntent;
const draftIdentityReady = ref(false);
let draftIdentityGeneration = 0, signingOut = false;
let draftIdentityRequest: Promise<boolean> | undefined;
const currentView = (id: string, epoch: number) => note.value?.id === id && viewEpoch === epoch;
let searchTimer: ReturnType<typeof setTimeout>;
let noticeTimer: ReturnType<typeof setTimeout>;
const dirty = computed(
  () => !!note.value && (boardDirty.value || editorComposing.value || largeDirty.value || draft.value !== savedContent.value),
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
    enabled: noteInfo.value?.editorMode === 'full' && !isWhiteboard(note.value?.relativePath||'') && !editorComposing.value,
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
    !draftIdentityReady.value ||
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
  const intent = ++navigationIntent;
  await run(() =>
    guard(async () => {
      await localDrafts.flush();
      if (!currentIntent(intent)) return;
      viewEpoch++;
      noteOpening.value = false;
      note.value = undefined;
      panel.value = 'empty';
      folder.value = '';
      selected.value = '';
      drawer.value = false;
      navigation.commit({});
    }, intent),
  );
}
const navigation = createWorkspaceNavigation({
  dirty: () => dirty.value || !!embeddedBoardId.value || !!appsRef.value?.hasUnsavedChanges(),
  canPreserveDraft: (route) => !embeddedBoardId.value && (
    (route.view === 'apps' && route.app === 'to-doo' && panel.value === 'apps' && appsApp.value === 'to-doo') ||
    (!appsRef.value?.hasUnsavedChanges() && (!!route.view || (!!route.note && note.value?.id === route.note)))),
  guard,
  apply: applyRoute,
  error: showError,
  onState: (state) => {
    navigationState.value = state;
  },
});
function invalidateDraftIdentity() {
  draftIdentityGeneration++;
  draftIdentityReady.value = false;
  draftIdentityRequest = undefined;
}
function initializeDrafts(force = false): Promise<boolean> {
  if (!alive || signingOut) return Promise.resolve(false);
  if (force) invalidateDraftIdentity();
  if (draftIdentityReady.value) return Promise.resolve(true);
  if (draftIdentityRequest) return draftIdentityRequest;
  const generation = ++draftIdentityGeneration;
  const current = () => alive && generation === draftIdentityGeneration;
  draftIdentityRequest = (async () => {
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
      if (!current()) return false;
      localDrafts.setup({ ownerId: session.user.id, knowledgeId });
      draftIdentityReady.value = true;
      draftError.value = '';
      return true;
    } catch (cause) {
      if (!current()) return false;
      draftError.value =
        cause instanceof Error ? cause.message : '本地草稿保护暂不可用，请手动保存原文。';
      throw cause;
    } finally {
      if (current()) draftIdentityRequest = undefined;
    }
  })();
  return draftIdentityRequest;
}
async function applyRoute(route: WorkspaceRoute, intent = ++navigationIntent) {
  if (!currentIntent(intent)) return;
  if (panel.value === 'apps' && appsApp.value === 'to-doo' && !(route.view === 'apps' && route.app === 'to-doo') && (await appsRef.value?.requestLeave()) === false) return;
  if (route.note && ['settings', 'trash', 'apps', 'collection'].includes(panel.value) && note.value?.id === route.note) {
    if (!await initializeDrafts() || !currentIntent(intent)) return;
    panel.value = 'note';
    drawer.value = false;
    await nextTick();
    if (!currentIntent(intent)) return;
  }
  if (route.note) {
    if (note.value?.id === route.note) {
      if (noteOpening.value) {
        viewEpoch++;
        noteOpening.value = false;
        await nextTick();
        if (!currentIntent(intent)) return;
      }
      if(route.fragment)await revealFragment(route.fragment);
      else if(route.line)revealLine(route.line);
    } else await openNote(route.note, route.line, false, false, intent, route.fragment);
    return;
  }
  if (route.view === 'recent' || route.view === 'favorites') return showCollection(route.view, false, intent);
  if (route.view === 'apps') {
    appsApp.value = route.app; appsSection.value = route.appSection || 'overview';
    toDooSelection.value = { task: route.task, list: route.list, date: route.date, calendarView: route.calendarView };
    return openApps(false, intent);
  }
  if (route.view === 'trash') return openTrash(false, intent);
  if (route.view === 'settings') return settings(route.section, false, intent);
  if (route.folder && !treeLoaded.value) await refresh();
  if (!currentIntent(intent) || (route.folder && !treeLoaded.value)) return;
  const entry = route.folder
    ? flat.value.find((item) => item.type === 'folder' && item.path === route.folder)
    : undefined;
  if (entry) return select(entry, false, intent);
  await guard(async () => {
    await localDrafts.flush();
    if (!currentIntent(intent)) return;
    viewEpoch++;
    noteOpening.value = false;
    note.value = undefined;
    panel.value = 'empty';
    folder.value = '';
    selected.value = '';
  }, intent);
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
const md = new MarkdownIt({ html: false, linkify: true }).use(markdownStyles).use(markdownTasks).use(knowledgeMarkdown).use(previewSource).use(diagramFences);
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
const notesByPath = computed(() => new Map(flat.value.filter(item => item.type === 'note').map(item => [item.path, item])));
const assetsByPath = computed(() => new Map(assets.value.map(asset => [asset.relativePath, asset])));
function localPath(url: string, base = note.value?.relativePath || '') {
  const target = markdownDestination(url, base);
  return target?.kind === 'local' ? target.path : '';
}
function resolveEditorImage(url:string){const asset=assetsByPath.value.get(localPath(url));return asset?`/api/assets/${asset.id}`:undefined;}
let pendingFragment: {noteId:string;epoch:number;fragment:string} | undefined;
async function revealFragment(fragment: string) {
  const noteId=note.value?.id,epoch=viewEpoch;
  if(!noteId)return;
  let id: string;
  try { id = decodeURIComponent(fragment.slice(1)); } catch { return; }
  await nextTick();
  if(!currentView(noteId,epoch))return;
  if(!previewRef.value&&!editorRef.value){pendingFragment={noteId,epoch,fragment};return;}
  pendingFragment=undefined;
  if (previewRef.value) {
    const target = [...previewRef.value.querySelectorAll<HTMLElement>('[id]')].find(element => element.id === id);
    if (target) { target.scrollIntoView({block:'start'}); return; }
  }
  const line = markdownAnchorLines(md.parse(draft.value, {})).get(id) ?? Number(/^L([1-9]\d*)$/.exec(id)?.[1]);
  if (line) revealLine(line);
}
watch([previewRef,editorRef],()=>{
  if(pendingFragment&&currentView(pendingFragment.noteId,pendingFragment.epoch))void revealFragment(pendingFragment.fragment);
});
async function openMarkdownNote(id: string, fragment: string) {
  if (note.value?.id !== id) return openNote(id, undefined, true, false, ++navigationIntent, fragment, mode.value);
  if (!fragment) return;
  navigation.commit({ note: id, fragment });
  await revealFragment(fragment);
}
function openEditorLink(url: string) {
  const destination = markdownDestination(url, note.value?.relativePath || '');
  if (destination?.kind === 'fragment') {
    const id=note.value?.id;
    if(id)void run(() => openMarkdownNote(id,destination.fragment));
    return;
  }
  if (destination?.kind === 'external') {
    if (/^(?:https?:\/\/|\/\/)/i.test(url)) window.open(url,'_blank','noopener,noreferrer');
    else tell('未找到此链接对应的笔记或附件，可在链接设置中核对地址');
    return;
  }
  if (destination?.kind === 'local') {
    const target = notesByPath.value.get(destination.path), asset = assetsByPath.value.get(destination.path);
    if (target?.id) { void run(() => openMarkdownNote(target.id!, destination.fragment)); return; }
    if (asset) { window.open(`/api/assets/${asset.id}`,'_blank','noopener,noreferrer'); return; }
  }
  tell('未找到此链接对应的笔记或附件，可在链接设置中核对地址');
}
const preview = computed(() => {
  // The watcher also reads this computed value. Do not parse an unmounted pane.
  if (mode.value === 'edit') return '';
  const tokens = md.parse(draft.value, {});
  markdownAnchorLines(tokens);
  const visit = (list: typeof tokens) => {
    for (const t of list) {
      if (t.type === 'image' || t.type === 'link_open') {
        const attr = t.type === 'image' ? 'src' : 'href', url = String(t.attrGet(attr) || '');
        const destination = markdownDestination(url, note.value?.relativePath || '');
        if (destination?.kind === 'fragment' && t.type === 'link_open') {
          // Includes Markdown's footnote reference and back-reference targets.
        } else if (destination?.kind === 'external' && t.type === 'link_open' && /^(?:https?:\/\/|\/\/)/i.test(url)) {
          t.attrSet('target', '_blank'); t.attrSet('rel', 'noopener noreferrer');
        } else if (destination?.kind === 'local') {
          const asset = assetsByPath.value.get(destination.path), target = notesByPath.value.get(destination.path);
          if (asset) {
            if (t.type === 'image') deferImageSource(t, `/api/assets/${asset.id}`);
            else t.attrSet(attr, `/api/assets/${asset.id}${destination.fragment}`);
          } else if (target?.id && t.type === 'link_open') {
            t.attrSet(attr, `?note=${encodeURIComponent(target.id)}${destination.fragment}`);
            t.attrSet('data-note-id', target.id);
          } else t.attrSet(attr, '');
        } else t.attrSet(attr, '');
      }
      if (t.children && t.type !== 'image') visit(t.children);
    }
  };
  visit(tokens);
  return DOMPurify.sanitize(md.renderer.render(tokens, md.options, {}), { ADD_ATTR: ['target'] });
});
watch([preview,mode,previewRef],async(_value,_old,onCleanup)=>{
  const container=previewRef.value;
  if(container)onCleanup(()=>clearDiagrams(container));
  await nextTick();
  if(container&&previewRef.value===container)syncDiagrams(container,{noteId:note.value?.id,editable:mode.value!=='preview'});
},{flush:'post'});
function onBoardSaved(document:NoteDocument){
  if(note.value?.id!==document.id)return;
  note.value=document;draft.value=document.content;savedContent.value=document.content;
}
async function openBoardPicker(){
  if(!note.value||isWhiteboard(note.value.relativePath))return;
  try{await editorRef.value?.flush();
    boardInsertTarget={id:note.value.id,epoch:viewEpoch,content:draft.value,selection:editorRef.value!.selection()};
    boardPickerOpen.value=true;
  }catch(cause){showError(cause);}
}
function insertBoard(id:string){
  const target=boardInsertTarget;
  if(!target||!currentView(target.id,target.epoch)||draft.value!==target.content){tell('正文已变化，请重新选择白板插入位置');return;}
  if(!editorRef.value?.insertAsset(whiteboardFence(id),target.selection)){tell('请重新选择正文中的插入位置');return;}
  boardPickerOpen.value=false;boardInsertTarget=undefined;
}
async function newBoard(content=JSON.stringify(emptyWhiteboard())){
  const parent=folder.value||'00-Inbox';
  if(!flat.value.some(item=>item.type==='folder'&&item.path===parent)){
    try{await api('/api/folders','POST',{parent:'',name:parent});}
    catch(cause){if(!(cause instanceof ApiError)||cause.status!==409)throw cause;}
    await refresh();
  }
  const stem=[...(note.value?.title||'未命名').replace(/[\u0000-\u001f/\\:]/g,' ').trim()].slice(0,35).join('')+'白板';
  const paths=new Set(flat.value.map(item=>item.path));
  let count=1;
  while(paths.has(parent+'/'+stem+(count===1?'':' ('+count+')')+'.excalidraw'))count++;
  const created=await api<NoteDocument>('/api/notes','POST',{folderPath:parent,
    fileName:stem+(count===1?'':' ('+count+')')+'.excalidraw',content,requestId:crypto.randomUUID()});
  await refresh();return created;
}
async function createInlineBoard(){
  if(boardCreating.value)return;boardCreating.value=true;
  try{const created=await newBoard();insertBoard(created.id);if(!boardPickerOpen.value)embeddedBoardId.value=created.id;}
  catch(cause){showError(cause);}finally{boardCreating.value=false;}
}
async function openDiagramEvent(event:Event){
  const detail=(event as CustomEvent).detail,originId=note.value?.id,originEpoch=viewEpoch;
  if(embeddedBoardId.value||boardCreating.value)return;
  try{
    await editorRef.value?.flush();
    if(detail?.mermaid){
      boardCreating.value=true;tell('正在转换为白板…');
      const scene=await (await import('../whiteboards/canvas')).mermaidScene(detail.mermaid);
      if(note.value?.id!==originId||viewEpoch!==originEpoch)return;
      const created=await newBoard(JSON.stringify(scene));
      if(note.value?.id===originId&&viewEpoch===originEpoch)embeddedBoardId.value=created.id;
      notice.value='';
    }else if(typeof detail?.id==='string'&&whiteboardId(detail.id))embeddedBoardId.value=detail.id;
  }catch(cause){showError(cause);}finally{boardCreating.value=false;}
}
const portableBusy=ref(false);
type PortableDiagramEvent={kind:'svg'|'mermaid'|'excalidraw';code:string;noteId?:string;boardId?:string;sourceId?:string;sourceLine?:number;sourceContent?:string;png:Blob};
async function portableDiagram(event:Event){
  const detail=(event as CustomEvent<PortableDiagramEvent>).detail;
  if(!detail||!['svg','mermaid','excalidraw'].includes(detail.kind)||!(detail.png instanceof Blob)||!note.value||
    isWhiteboard(note.value.relativePath)||formatDisabled.value||portableBusy.value||detail.noteId&&detail.noteId!==note.value.id)return;
  const id=note.value.id,epoch=viewEpoch;portableBusy.value=true;
  try{
    const snapshot=await editorRef.value?.flush();
    if(!snapshot||!currentView(id,epoch))return;
    const range=findDiagramRange(snapshot.markdown,{kind:detail.kind,code:detail.code,line:detail.sourceLine,
      range:detail.sourceId?editorRef.value?.diagramRange(detail.sourceId):undefined});
    const source=detail.kind==='excalidraw'?detail.sourceContent:detail.code;
    if(!source)throw Error('图形源文件尚未读取，请重试');
    const {persistDiagramPreview}=await import('../diagrams/persist-preview');
    const result=await persistDiagramPreview({noteId:id,notePath:note.value?.relativePath,kind:detail.kind,source,png:detail.png});
    if(!currentView(id,epoch))return;
    const current=await editorRef.value?.flush();
    if(!current||current.markdown!==snapshot.markdown){tell('图形附件已准备，正文已变化，请重新生成以确认位置');return;}
    const attachments=await api(`/api/notes/${id}/assets`);
    if(!currentView(id,epoch))return;
    assets.value=attachments;
    const next=withDiagramPreview(snapshot.markdown,range,result.preview.markdownPath,result.source?.markdownPath,{kind:detail.kind,codeHash:await hashDiagramCode(detail.code),sourceHash:result.sourceHash});
    if((await collectCurrentDiagramSaveNeeds(next,next,id)).some(need=>need.kind==='excalidraw'))throw Error('白板设计已变化，请重新生成通用预览');
    if(!currentView(id,epoch)||!editorRef.value?.replaceMarkdown(next,snapshot.markdown))throw Error('正文已变化，请重新确认图形位置');
    tell('通用预览已插入，请手动保存笔记');
  }catch(cause){showError(cause);}finally{portableBusy.value=false;}
}
async function editDiagramSource(event:Event){
  const detail=(event as CustomEvent<PortableDiagramEvent>).detail;
  if(!note.value||detail.noteId&&detail.noteId!==note.value.id||formatDisabled.value)return;
  const id=note.value.id,epoch=viewEpoch;
  try{
    const snapshot=await editorRef.value?.flush();if(!snapshot||!currentView(id,epoch))return;
    const range=findDiagramRange(snapshot.markdown,{kind:detail.kind,code:detail.code,line:detail.sourceLine,
      range:detail.sourceId?editorRef.value?.diagramRange(detail.sourceId):undefined});
    await switchEditing('source',range.from);
  }catch(cause){showError(cause);}
}
async function portableWhiteboard(event:Event){
  const detail=(event as CustomEvent<{boardId:string;png:Blob;content:string}>).detail;
  if(!note.value||note.value.id!==detail?.boardId||!isWhiteboard(note.value.relativePath)||portableBusy.value)return;
  const board=note.value;portableBusy.value=true;
  try{
    const {persistDiagramPreview}=await import('../diagrams/persist-preview');
    const result=await persistDiagramPreview({noteId:board.id,notePath:board.relativePath,kind:'excalidraw',source:detail.content,png:detail.png});
    if(!result.source)throw Error('白板源快照尚未准备好');
    const markdown=renderPortableFigure({alt:board.title,previewPath:result.preview.markdownPath,source:{type:'file',path:result.source.markdownPath}});
    const parent=board.relativePath.split('/').slice(0,-1).join('/'),stem=board.title.replace(/[\\/:*?"<>|\u0000-\u001f]/g,' ').trim().slice(0,45)||'白板';
    await api('/api/notes','POST',{folderPath:parent,fileName:stem+'-预览-'+result.sourceHash.slice(0,8)+'-'+result.preview.id.slice(0,6)+'.md',content:markdown,requestId:'portable-'+board.id+'-'+result.preview.id});
    await refresh();tell('Markdown 预览笔记已创建，原白板保存状态保持原样');
  }catch(cause){showError(cause);}finally{portableBusy.value=false;}
}
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
    folderDeleteTarget.value ||
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
  treeRefreshing.value = true;
  const request = (async () => {
    const [ready, entries] = await Promise.all([
      initializeDrafts(), api<TreeEntry[]>('/api/tree'),
    ]);
    if (!ready || !alive || epoch !== treeRefreshEpoch) return;
    collectionFeed.observeFavorites(flatten(entries));
    tree.value = entries;
    treeLoaded.value = true;
  })().finally(() => {
    // Only the latest read owns the indicator, including reads invalidated by a mutation.
    if (treeRefreshRequest === request) treeRefreshing.value = false;
  });
  treeRefreshRequest = request;
  let waiting = request;
  // Initial folder lookup needs a published tree. A superseded read must join
  // the current read, rather than returning an empty directory as success.
  for (;;) {
    await waiting;
    if (!alive || treeLoaded.value || !treeRefreshRequest || waiting === treeRefreshRequest) return;
    waiting = treeRefreshRequest;
  }
}
let collectionRefreshing = false;
async function refreshCollection() {
  if (
    collection.value === 'notes' ||
    document.hidden ||
    collectionRefreshing ||
    ['settings', 'trash', 'apps'].includes(panel.value)
  )
    return;
  collectionRefreshing = true;
  try {
    await collectionFeed.checkForUpdates(collection.value);
  } catch (cause) {
    showError(cause);
  } finally {
    collectionRefreshing = false;
  }
}
async function openNote(id: string, location?: number | { line: number; query: string }, syncUrl = true, preserveDraft = false, intent = ++navigationIntent, fragment?: string, linkedMode?: 'edit' | 'preview' | 'split') {
  const line = typeof location === 'number' ? location : location?.line;
  const matchQuery = typeof location === 'object' ? location.query : undefined;
  if (!currentIntent(intent) || !await initializeDrafts() || !currentIntent(intent)) return;
  await guard(async () => {
    const useDefaultMode = note.value?.id !== id;
    const originalDraft = draft.value,
      originalSaved = savedContent.value;
    await localDrafts.flush();
    if (!currentIntent(intent)) return;
    const epoch = ++viewEpoch;
    noteOpening.value = true;
    try {
      let meta = await api<NoteInfo>(`/api/notes/${id}/meta`);
      if (!currentIntent(intent)) return;
      if (!isWhiteboard(meta.relativePath) && (meta.readState === 'unknown' || meta.readState === 'preparing') && meta.sizeBytes <= 1024 * 1024) {
        const prep = await api<FileReply<OutlinePage>>(`/api/notes/${id}/outline`);
        if (prep.kind === 'accepted') {
          let op = prep.operation;
          while (['queued', 'running'].includes(op.status)) {
            await new Promise((r) => setTimeout(r, 1000));
            if (epoch !== viewEpoch || !currentIntent(intent)) return;
            op = await api<FileOperation>(`/api/operations/${op.operationId}`);
          }
        }
        meta = await api<NoteInfo>(`/api/notes/${id}/meta`);
      }
      const documentRequest: Promise<NoteDocument> =
        meta.editorMode === 'full'
          ? api<NoteDocument>(`/api/notes/${id}`)
          : Promise.resolve({
              id: meta.id,
              title: meta.title,
              relativePath: meta.relativePath,
              content: '',
              modifiedAt: meta.modifiedAt,
              updatedAt: new Date().toISOString(),
              shared: meta.shared,
            });
      const [n, attachments] = await Promise.all([
        documentRequest,
        api<any[]>(`/api/notes/${id}/assets`).catch(() => []),
      ]);
      if (epoch !== viewEpoch || !currentIntent(intent) || !draftIdentityReady.value) return;
      if (
        preserveDraft &&
        (dirty.value || draft.value !== originalDraft || savedContent.value !== originalSaved)
      ) {
        tell('原文已更新，当前未保存草稿会保留，请重新核对版本');
        return;
      }
      if (meta.editorMode === 'full' && !isWhiteboard(meta.relativePath)) localDrafts.prepare();
      // Keep the current editor and its undo history while a different note is loading.
      editorGeneration.value = epoch;
      note.value = n;
      noteInfo.value = meta;
      largeDirty.value = false;
      boardDirty.value = false;
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
      if (useDefaultMode) mode.value = linkedMode ?? editorPreferences.mode;
      noteLine.value = line;
      if (syncUrl) navigation.commit({ note: id, line, fragment });
      if (meta.editorMode === 'full' && !isWhiteboard(meta.relativePath)) await localDrafts.load(id, currentDraftBase(), n.content);
      if (epoch !== viewEpoch || !currentIntent(intent)) return;
      // A mounted read-only editor can accept a model selection but cannot
      // establish DOM focus. Apply its editable state before revealing a target.
      noteOpening.value = false;
      await nextTick();
      if (epoch !== viewEpoch || !currentIntent(intent)) return;
      if (line) revealLine(line, true, matchQuery);
      if (fragment) await revealFragment(fragment);
    } finally {
      if (epoch === viewEpoch) noteOpening.value = false;
    }
  }, intent);
}
async function select(entry: TreeEntry, syncUrl = true, intent = ++navigationIntent) {
  await run(async () => {
    if (!currentIntent(intent)) return;
    if (entry.type === 'note' && entry.id === note.value?.id && panel.value === 'collection') {
      if (noteOpening.value) viewEpoch++;
      noteOpening.value = false;
      panel.value = 'note';
      drawer.value = false;
      if (syncUrl) navigation.commit({ note: entry.id, line: noteLine.value });
    } else if (entry.type === 'note') await openNote(entry.id!, undefined, syncUrl, false, intent);
    else
      await guard(async () => {
        if (!currentIntent(intent)) return;
        viewEpoch++;
        noteOpening.value = false;
        folder.value = entry.path;
        collection.value = 'notes';
        selected.value = entry.path;
        note.value = undefined;
        drawer.value = false;
        panel.value = 'folder';
        if (syncUrl) navigation.commit({ folder: entry.path });
      }, intent);
  });
}
const leaveOpen = ref(false);
let pendingNavigation: (() => Promise<void>) | undefined;
async function guard(fn: () => Promise<void>, intent = navigationIntent) {
  if (panel.value === 'apps' && appsApp.value === 'to-doo' && (await appsRef.value?.requestLeave()) === false) return;
  if(embeddedBoardId.value){await embeddedBoardRef.value?.requestClose();return;}
  if(noteInfo.value?.editorMode === 'full') {try {await editorRef.value?.flush();}catch(cause){showError(cause);if(!dirty.value)return;}}
  if (!currentIntent(intent)) return;
  const apply = async () => { if (currentIntent(intent)) await fn(); };
  if (dirty.value) {
    pendingNavigation = apply;
    leaveOpen.value = true;
  } else await apply();
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
      await boardRef.value?.discard();
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
let preparingSave: { noteId: string; epoch: number; promise: Promise<void> } | undefined;
function save(
  expected?: string,
  content?: string,
  revisionId?: string,
  retry?: NonNullable<typeof pendingSave.value>,
): Promise<void> {
  const target = note.value;
  if (
    expected !== undefined || content !== undefined || revisionId || retry || !target ||
    noteInfo.value?.editorMode !== 'full' || isWhiteboard(target.relativePath)
  ) return performSave(expected, content, revisionId, retry);
  const epoch = viewEpoch;
  if (preparingSave?.noteId === target.id && preparingSave.epoch === epoch)
    return preparingSave.promise;
  const promise: Promise<void> = Promise.resolve()
    .then(() => {
      if (alive && currentView(target.id, epoch))
        return performSave(expected, content, revisionId, retry);
    })
    .finally(() => {
      if (preparingSave?.promise === promise) preparingSave = undefined;
    });
  preparingSave = { noteId: target.id, epoch, promise };
  return promise;
}
async function performSave(
  expected?: string,
  content?: string,
  revisionId?: string,
  retry?: NonNullable<typeof pendingSave.value>,
) {
  if (!note.value || (busy.value && !retry) || (!retry&&content===undefined&&diagramSaveBusy.value) || props.serviceUnavailable) return;
  if (isWhiteboard(note.value.relativePath) && !revisionId) { await boardRef.value?.save(); return; }
  if(!retry && content === undefined && noteInfo.value?.editorMode === 'full'){
    const targetId=note.value.id,targetEpoch=viewEpoch;
    try{await editorRef.value?.flush();}catch(cause){if(alive&&currentView(targetId,targetEpoch))showError(cause);return;}
    if(!alive || !currentView(targetId,targetEpoch) || (busy.value && !retry))return;
  }
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
  if(!retry&&!revisionId&&content===undefined){
    const id=note.value.id,epoch=viewEpoch,markdown=draft.value;
    try{
      const needs=await collectCurrentDiagramSaveNeeds(markdown,savedContent.value,id);
      if(!currentView(id,epoch)||draft.value!==markdown)return;
      if(needs.length){diagramSaveError.value='';diagramSaveContext.value={id,epoch,markdown,needs};return;}
    }catch(cause){showError(cause);return;}
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
  share = ref<ShareStatus>({ enabled: false, state: 'private', permission: 'view', expiresAt: null, editSupported: false });
const shareContext = ref<{ id: string; epoch: number; title: string }>();
const currentShareView = (id: string, epoch: number) =>
  (note.value?.id || noteInfo.value?.id) === id && viewEpoch === epoch;
watch(() => note.value?.id || noteInfo.value?.id, () => { shareOpen.value = false; });
async function manageShare() {
  const id = note.value?.id || noteInfo.value?.id;
  if (shareBusy.value || !id) return;
  const epoch = viewEpoch, title = note.value?.title || noteInfo.value?.title || '分享笔记';
  shareBusy.value = true;
  error.value = '';
  dialogError.value = '';
  try {
    const response = await api<ShareStatus>(`/api/notes/${id}/share`);
    if (!currentShareView(id, epoch)) return;
    share.value = response;
    shareContext.value = { id, epoch, title };
    shareOpen.value = true;
  } catch (cause) {
    if (currentShareView(id, epoch)) showError(cause);
  } finally { shareBusy.value = false; }
}
async function shareAction(action: 'create' | 'reset' | 'revoke', options?: ShareOptions) {
  const target = shareContext.value;
  if (shareBusy.value || !target) return;
  if (!currentShareView(target.id, target.epoch)) { shareOpen.value = false; return; }
  shareBusy.value = true;
  error.value = '';
  dialogError.value = '';
  const wasEnabled = share.value.enabled;
  try {
    const base = `/api/notes/${target.id}/share`;
    const response = await api<ShareStatus>(
      base + (action === 'reset' ? '/reset' : ''),
      action === 'revoke' ? 'DELETE' : 'POST',
      action === 'revoke' ? undefined : options,
    );
    if (!currentShareView(target.id, target.epoch)) return;
    share.value = response;
    if (note.value?.id === target.id) note.value.shared = response.enabled;
    if (noteInfo.value?.id === target.id) noteInfo.value.shared = response.enabled;
    tell(action === 'revoke' ? '分享已取消' : action === 'reset' ? '旧链接已失效' : wasEnabled ? '分享设置已保存' : '分享链接已生成');
  } catch (cause) {
    if (currentShareView(target.id, target.epoch)) showError(cause);
  } finally { shareBusy.value = false; }
}
const createBusy = ref(false),
  inboxBusy = ref(false);
const createOpen = ref(false),
  createKind = ref<'note' | 'folder' | 'whiteboard'>('note'),
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
    !newFolder.value && (createKind.value === 'whiteboard' ||
    (createKind.value === 'note' && (newName.value.endsWith('.md') ? newName.value : newName.value + '.md') !== 'README.md')),
);
const rootFolderNeedsPurpose = computed(
  () =>
    createKind.value === 'folder' &&
    !newFolder.value &&
    !rootFolderPurposes.some((purpose) => purpose.value === newName.value),
);
let createRequestId = crypto.randomUUID();
function create(kind: 'note' | 'folder' | 'whiteboard', parent?: string, intent = navigationIntent) {
  if (!currentIntent(intent) || !treeLoaded.value || !draftIdentityReady.value) return;
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
  const intent = navigationIntent;
  try {
    await run(async () => {
      if (createKind.value === 'folder') {
        await api('/api/folders', 'POST', { parent: newFolder.value, name: newName.value });
        await refresh();
        createOpen.value = false;
        tell('文件夹已创建');
      } else {
        await guard(async () => {
          const name = createKind.value === 'whiteboard' ? (/\.excalidraw$/i.test(newName.value)?newName.value:newName.value+'.excalidraw') : newName.value.endsWith('.md') ? newName.value : newName.value + '.md';
          const epoch = viewEpoch;
          let n: NoteDocument;
          try {
            n = await api<NoteDocument>('/api/notes', 'POST', {
              folderPath: newFolder.value,
              fileName: name,
              content: createKind.value === 'whiteboard' ? JSON.stringify(emptyWhiteboard()) : `# ${newName.value.replace(/\.md$/, '')}\n\n`,
              requestId: createRequestId,
            });
          } catch (e) {
            if (e instanceof ApiError && e.status >= 400 && e.status < 500)
              createRequestId = crypto.randomUUID();
            throw e;
          }
          createOpen.value = false;
          await refresh();
          if (!currentIntent(intent)) {
            tell('笔记已创建，可在目录中打开');
            return;
          }
          await openNote(n.id, undefined, true, false, intent);
        }, intent);
      }
    });
  } finally {
    createBusy.value = false;
  }
}
const panel = ref<'empty' | 'folder' | 'note' | 'trash' | 'settings' | 'apps' | 'collection'>('empty'),
  revisionsOpen = ref(false),
  revisions = ref<any[]>([]),
  revisionCursor = ref<string>(),
  deleteOpen = ref(false);
const deleteTarget = ref<NoteDocument>();
const folderDeleteTarget = ref<{ path: string; requestId: string }>();
const folderDeleteBusy = ref(false),
  folderDeleteUncertain = ref(false);
async function removeFolder() {
  const target = folderDeleteTarget.value;
  if (!target || folderDeleteBusy.value) return;
  folderDeleteBusy.value = true;
  dialogError.value = '';
  try {
    await api('/api/folders', 'DELETE', target);
    folderDeleteTarget.value = undefined;
    folderDeleteUncertain.value = false;
    const contains = (path: string) => path === target.path || path.startsWith(target.path + '/');
    if (noteOpening.value || (note.value && contains(note.value.relativePath))) {
      viewEpoch++;
      noteOpening.value = false;
    }
    if (note.value && contains(note.value.relativePath)) {
      note.value = undefined;
      noteInfo.value = undefined;
      draft.value = savedContent.value = '';
      largeDirty.value = false;
      returnRoute = {};
    }
    if (contains(folder.value)) folder.value = target.path.split('/').slice(0, -1).join('/');
    if (contains(selected.value)) selected.value = folder.value;
    if (!['settings', 'trash', 'apps'].includes(panel.value) && !note.value) {
      panel.value = folder.value ? 'folder' : 'empty';
      navigation.commit(folder.value ? { folder: folder.value } : {});
    }
    tell('文件夹已移入回收站');
    await refresh();
  } catch (cause) {
    if (folderDeleteTarget.value) {
      folderDeleteUncertain.value =
        !(cause instanceof ApiError) ||
        cause.status === 0 ||
        cause.status >= 500 ||
        ['OPERATION_OUTCOME_UNKNOWN', 'RECOVERY_REQUIRED'].includes(String(cause.data.code));
      if (!folderDeleteUncertain.value) target.requestId = crypto.randomUUID();
    }
    showError(cause);
  } finally {
    folderDeleteBusy.value = false;
  }
}
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
async function openApps(syncUrl = true, intent = ++navigationIntent) {
  await run(async () => {
    if (panel.value !== 'apps' && await retainNoteContext(intent) === false) return;
    if (!currentIntent(intent)) return;
    panel.value = 'apps';
    drawer.value = false;
    if (syncUrl) navigation.commit({ view: 'apps', ...(appsApp.value ? { app: appsApp.value, appSection: appsSection.value, ...(appsApp.value === 'to-doo' ? toDooSelection.value : {}) } : {}) });
  });
}
async function openTrash(syncUrl = true, intent = ++navigationIntent) {
  await run(async () => {
    if (await retainNoteContext(intent) === false) return;
    if (!currentIntent(intent)) return;
    panel.value = 'trash';
    drawer.value = false;
    if (syncUrl) navigation.commit({ view: 'trash' });
  });
}
async function retainNoteContext(intent = navigationIntent) {
  if (panel.value === 'apps' && appsApp.value === 'to-doo' && (await appsRef.value?.requestLeave()) === false) return false;
  if(noteInfo.value?.editorMode === 'full') await editorRef.value?.flush();
  await localDrafts.flush();
  if (!currentIntent(intent)) return;
  if (!['settings', 'trash', 'apps', 'collection'].includes(panel.value)) {
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
async function settings(section?: string, syncUrl = true, intent = ++navigationIntent) {
  if (!currentIntent(intent)) return;
  const target = section ? normalizeSettingsSection(section) : rememberedSetting();
  if (panel.value === 'settings') {
    scrollSetting(target, syncUrl);
    return;
  }
  await run(async () => {
    if (await retainNoteContext(intent) === false) return;
    if (!currentIntent(intent)) return;
    panel.value = 'settings';
    drawer.value = false;
    scrollSetting(target, false);
    if (syncUrl) navigation.commit({ view: 'settings', section: target });
  });
}
async function backFromSettings(intent = ++navigationIntent) {
  if (returnRoute.note && note.value?.id === returnRoute.note) {
    if (!await initializeDrafts() || !currentIntent(intent)) return;
    panel.value = 'note';
    drawer.value = false;
    navigation.commit(returnRoute);
    return;
  }
  await applyRoute(returnRoute, intent);
  if (currentIntent(intent)) navigation.commit(returnRoute);
}
async function openNotes(intent = ++navigationIntent) {
  collection.value = 'notes';
  sidebarCollapsed.value = false;
  if (['settings', 'trash', 'apps', 'collection'].includes(panel.value)) await run(() => backFromSettings(intent));
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
  const intent = ++navigationIntent;
  await run(() =>
    guard(async () => {
      signingOut = true;
      invalidateDraftIdentity();
      treeRefreshEpoch++;
      searchEpoch++;
      try {
        await localDrafts.logout();
        await api('/api/auth/sign-out', 'POST', {});
      } catch (cause) {
        signingOut = false;
        await initializeDrafts(true);
        throw cause;
      }
      if (!alive) return;
      viewEpoch++;
      resetCsrf();
      tree.value = [];
      note.value = undefined;
      draft.value = '';
      emit('logout');
    }, intent),
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
  const intent = navigationIntent;
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
        if (!currentIntent(intent)) { tell('笔记已创建，可在目录中打开'); return; }
        await openNote(created.id, undefined, true, false, intent);
        await nextTick();
        if (currentIntent(intent)) editorRef.value?.goToLine(3);
      } finally {
        quickBusy.value = false;
      }
    }, intent),
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
  const front=frontmatterRange(draft.value);
  const metadataLines=front?draft.value.slice(0,front.end).split('\n').length-1:0;
  return outlineFromTokens(md.parse(draft.value, {}),metadataLines);
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
  const headings = container.querySelectorAll<HTMLElement>(
    ':is(h1,h2,h3,h4,h5,h6)[data-source-line]',
  );
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
let pendingPreviewLine: { noteId: string; epoch: number; line: number } | undefined;
async function revealLine(line: number, navigateEditor = true, matchQuery?: string) {
  const noteId = note.value?.id, epoch = viewEpoch;
  if (!noteId) return;
  // The host queues navigation while an async editor is loading. Schedule that
  // immediately; only the rendered preview needs an additional DOM update.
  if (navigateEditor) editorRef.value?.goToLine(line, 'center', matchQuery);
  await nextTick();
  if (!currentView(noteId, epoch)) return;
  if (mode.value === 'edit') {
    pendingPreviewLine = undefined;
    return;
  }
  if (!previewRef.value) {
    pendingPreviewLine = { noteId, epoch, line };
    return;
  }
  const container = previewRef.value;
  container
    .querySelectorAll('[data-search-hit]')
    .forEach((element) => element.removeAttribute('data-search-hit'));
  let target: HTMLElement | undefined;
  for (const element of container.querySelectorAll<HTMLElement>('[data-source-line]')) {
    const sourceLine = Number(element.dataset.sourceLine);
    if (sourceLine <= line && (!target || sourceLine >= Number(target.dataset.sourceLine)))
      target = element;
  }
  if (target) {
    pendingPreviewLine = undefined;
    target.setAttribute('data-search-hit', 'true');
    // Scroll only the article pane so split view and the sidebar stay in place.
    const targetBounds = target.getBoundingClientRect(), bounds = container.getBoundingClientRect();
    container.scrollTop +=
      (targetBounds.top + targetBounds.bottom) / 2 - (bounds.top + container.clientHeight / 2);
  } else pendingPreviewLine = { noteId, epoch, line };
}
watch([previewRef, preview], () => {
  const pending = pendingPreviewLine;
  if (!pending) return;
  if (!currentView(pending.noteId, pending.epoch)) pendingPreviewLine = undefined;
  else void revealLine(pending.line, false);
}, { flush: 'post' });
watch(mode, async () => {
  await nextTick();
  if (noteLine.value && noteInfo.value?.editorMode === 'full') revealLine(noteLine.value, false);
});
const uploadInput = ref<HTMLInputElement>();
type UploadRequest = {
  noteId: string;
  generation: number;
  target?: AssetTarget;
  replacement?: ImageReplacementTarget;
  requestId?: string;
};
type PendingAsset = { noteId: string; markdown: string; name: string };
let uploadRequest: UploadRequest | undefined;
const uploadBusy = ref(false), uploadPreparing = ref(false), uploadName = ref('');
const uploadFailure = ref<{ file: File; request: UploadRequest; message: string }>();
const pendingAsset = ref<PendingAsset>();
async function prepareUpload(replacement?: ImageReplacementTarget) {
  if (uploadBusy.value || uploadPreparing.value || !note.value) return;
  uploadPreparing.value = true;
  const id = note.value.id, epoch = viewEpoch;
  try {
    const snapshot = await editorRef.value?.flush();
    if (!currentView(id, epoch)) return;
    uploadRequest = {
      noteId: id,
      generation: epoch,
      target: snapshot ? captureAssetTarget(snapshot) : undefined,
      replacement: replacement ? { ...replacement } : undefined,
    };
    // Keep file filtering in sync before opening the native picker.
    if (uploadInput.value) uploadInput.value.multiple = !replacement;
    if (uploadInput.value)
      uploadInput.value.accept = replacement
        ? 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml'
        : 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml,application/pdf';
    uploadInput.value?.click();
  } catch (cause) {
    showError(cause);
  } finally {
    uploadPreparing.value = false;
  }
}
function prepareImageReplacement(target: ImageReplacementTarget) {
  return prepareUpload(target);
}
async function insertPendingAsset() {
  const asset = pendingAsset.value;
  if (!asset || asset.noteId !== note.value?.id) return;
  const id = note.value.id, epoch = viewEpoch;
  try {
    await editorRef.value?.flush();
    if (currentView(id, epoch) && editorRef.value?.insertAsset(asset.markdown))
      pendingAsset.value = undefined;
  } catch (cause) {
    showError(cause);
  }
}
async function upload(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0];
  if (!file) return;
  const request = uploadRequest;
  uploadRequest = undefined;
  try {
    if (!request) { tell('插入位置已变化，请重新选择附件'); return; }
    const files=Array.from(input.files||[]);
    if(files.length>1&&!request.replacement)await uploadFiles(files,request);else await uploadFile(file, request);
  } finally {
    input.value = '';
  }
}
async function uploadPastedFile(file: File) {
  if (uploadBusy.value || uploadPreparing.value) return;
  const id = note.value?.id, epoch = viewEpoch;
  try {
    const snapshot = await editorRef.value?.flush();
    if (!id || !currentView(id, epoch)) {
      tell('笔记已切换，请在目标笔记重新粘贴附件');
      return;
    }
    await uploadFile(file, {
      noteId: id,
      generation: epoch,
      target: snapshot ? captureAssetTarget(snapshot) : undefined,
    });
  } catch (cause) {
    showError(cause);
  }
}
type QueuedAttachment={file:File;request:UploadRequest;inserted:boolean};
type UploadedAttachment={id:string;markdownPath:string;mime:string;relativePath:string;markdown:string};
const batchTick=ref(0);
let batchContext:UploadRequest|undefined;
const uploadQueue=createUploadQueue<QueuedAttachment,UploadedAttachment>(async(item)=>{
  const data=new FormData();data.append('file',item.data.file);
  const asset=await api(`/api/notes/${item.data.request.noteId}/assets`,'POST',data,{uploadRequestId:item.requestId});
  const label=item.data.file.name.replace(/[\\[\]]/g,'\\$&');
  return {...asset,markdown:`${/^image\//.test(asset.mime)?'![':'['}${label}](${asset.markdownPath})`};
},()=>{batchTick.value++;});
const batchItems=computed(()=>{batchTick.value;return [...uploadQueue.items];});
async function runUploadQueue(){
  uploadBusy.value=true;
  try{await uploadQueue.run();if(uploadQueue.items.every(item=>['succeeded','cancelled'].includes(item.state)))await insertBatch(false);}
  finally{uploadBusy.value=false;uploadName.value='';}
}
async function uploadFiles(files:File[],request?:UploadRequest){
  if(!files.length||uploadBusy.value||uploadPreparing.value||!note.value)return;
  if(files.length===1&&!request){await uploadPastedFile(files[0]);return;}
  try{
    if(batchItems.value.some(item=>!item.data.inserted&&item.state!=='cancelled')){tell('请先处理上一批附件，再添加新附件');return;}
    const id=note.value.id,epoch=viewEpoch,snapshot=await editorRef.value?.flush();
    if(!snapshot||!currentView(id,epoch))return;
    batchContext=request||{noteId:id,generation:epoch,target:captureAssetTarget(snapshot)};
    uploadQueue.items.splice(0);
    uploadQueue.add(files.map(file=>({file,request:batchContext!,inserted:false})));
    uploadName.value=files.map(file=>file.name).join('、');
    await runUploadQueue();
  }catch(cause){showError(cause);}
}
async function insertBatch(explicit=true){
  const context=batchContext;
  const completed=uploadQueue.items.filter(item=>item.state==='succeeded'&&!item.data.inserted);
  if(!context||!completed.length||note.value?.id!==context.noteId)return;
  const id=note.value.id,epoch=viewEpoch;
  const attachments=await api(`/api/notes/${id}/assets`);
  if(!currentView(id,epoch))return;
  const current=await editorRef.value?.flush();
  if(!current||!currentView(id,epoch))return;
  assets.value=attachments;
  const target=explicit?current.selection:context.target&&resolveAssetTarget(context.target,current);
  if(!target){tell('附件已上传，请选择位置后插入');return;}
  if(!editorRef.value?.insertAsset(completed.map(item=>item.result!.markdown).join('\n\n'),target))return;
  completed.forEach(item=>item.data.inserted=true);batchTick.value++;
  tell('附件已插入，请手动保存笔记');
}
async function retryBatch(item:UploadItem<QueuedAttachment,UploadedAttachment>){uploadQueue.retry(item.id);await runUploadQueue();}
function dismissBatch(){uploadQueue.items.forEach(item=>uploadQueue.cancel(item.id));if(!uploadBusy.value){uploadQueue.items.splice(0);batchTick.value++;}}
async function retryUpload() {
  const failure = uploadFailure.value;
  if (!failure || uploadBusy.value) return;
  if (note.value?.id !== failure.request.noteId) {
    tell('请返回原笔记重试上传');
    return;
  }
  // An old bookmark stays old after reopening the note; the uploaded attachment
  // is retained for explicit insertion instead of silently using a new caret.
  await uploadFile(failure.file, { ...failure.request, generation: viewEpoch });
}
async function uploadFile(file: File, request: UploadRequest) {
  if (uploadBusy.value) return;
  const id = request.noteId, epoch = request.generation;
  if (!currentView(id, epoch)) {
    tell('插入位置已变化，请重新选择附件');
    return;
  }
  uploadBusy.value = true;
  uploadName.value = file.name;
  uploadFailure.value = undefined;
  error.value = '';
  dialogError.value = '';
  let uploaded: PendingAsset | undefined;
  try {
    const data = new FormData();
    data.append('file', file);
    const asset = await api(`/api/notes/${id}/assets`, 'POST', data, {uploadRequestId:request.requestId ||= crypto.randomUUID()});
    const label = file.name.replace(/[\\[\]]/g, '\\$&');
    const markdown = `${/^image\//.test(asset.mime) ? '![' : '['}${label}](${asset.markdownPath})`;
    uploaded = { noteId: id, markdown, name: file.name };
    const attachments = await api(`/api/notes/${id}/assets`);
    if (!currentView(id, epoch)) {
      pendingAsset.value = uploaded;
      tell('附件已上传，可返回原笔记插入链接');
      return;
    }
    assets.value = attachments;
    const editor = editorRef.value;
    if (!editor) {
      pendingAsset.value = uploaded;
      tell('附件已上传，请打开编辑器后插入');
      return;
    }
    const current = await editor.flush();
    if (!currentView(id, epoch)) {
      pendingAsset.value = uploaded;
      tell('附件已上传，可返回原笔记插入链接');
      return;
    }
    if (request.replacement) {
      if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'].includes(asset.mime)) {
        pendingAsset.value = uploaded;
        tell('所选附件不是受支持的图片，原图片已保留，可选择位置后插入附件链接');
        return;
      }
      if (!editor.replaceImage(request.replacement, asset.markdownPath)) {
        pendingAsset.value = uploaded;
        tell('原图片已变化，附件已上传，请选择位置后插入');
        return;
      }
      tell('图片已替换，请手动保存笔记');
      return;
    }
    const bookmark = documentEditingEnabled
      ? request.target ? resolveAssetTarget(request.target, current) : undefined
      : { anchor: current.markdown.length, head: current.markdown.length, affinity: 'after' as const };
    if (!bookmark || !editor.insertAsset(documentEditingEnabled ? markdown : `\n${markdown}\n`, bookmark)) {
      pendingAsset.value = uploaded;
      tell('附件已上传，请选择位置后插入');
      return;
    }
    tell('附件已插入，请手动保存笔记');
  } catch (cause) {
    if (uploaded) {
      pendingAsset.value = uploaded;
      tell('附件已上传，请选择位置后插入');
    } else {
      uploadFailure.value = {
        file,
        request,
        message: cause instanceof Error ? cause.message : String(cause),
      };
    }
  } finally {
    uploadBusy.value = false;
  }
}
function clickPreview(event: MouseEvent) {
  const a = (event.target as HTMLElement).closest('a');
  const href = a?.getAttribute('href');
  if (!a || !href) return;
  if (a.dataset.noteId) {
    event.preventDefault();
    const fragment = href.includes('#') ? href.slice(href.indexOf('#')) : '';
    void run(() => openMarkdownNote(a.dataset.noteId!, fragment));
  } else if (href.startsWith('#')) {
    event.preventDefault();
    const id=note.value?.id;
    if(id)void run(() => openMarkdownNote(id,href));
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
    line: r.matches[0]?.matchLine || r.matches[0]?.startLine || 1,
    headingPath: r.matches[0]?.headingPath || [],
    matches: r.matches,
  }));
  searchDegraded.value = !!response.degraded;
  searchReasons.value = response.reasons || [];
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
  searchReasons.value = [];
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
watch(flat, () => {
  if (!query.value.trim()) return;
  const contentHits = results.value
    .filter((item) => !item.filenameMatch)
    .map((item) => ({ ...item, filenameRank: undefined }));
  results.value = mergeSearchResults(
    contentHits,
    filenameResults(flat.value, query.value, searchDirectory.value),
  );
});
function shortcut(e: KeyboardEvent) {
  handleSaveShortcut(e, () => { if (panel.value === 'note') void save(); });
}
function unload(e: BeforeUnloadEvent) {
  if (dirty.value) {
    e.preventDefault();
    e.returnValue = '';
  }
}
onMounted(() => {
  measureDocumentWidth();
  if (typeof ResizeObserver !== 'undefined' && mainRef.value) {
    documentResizeObserver = new ResizeObserver(measureDocumentWidth);
    documentResizeObserver.observe(mainRef.value);
  }
  window.addEventListener('resize', measureDocumentWidth);
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
    const intent = navigationIntent;
    await refresh();
    if (!alive) return;
    if (!treeLoaded.value) {
      // A user action superseded the prefetch while draft identity was pending.
      await refresh();
    }
    if (!currentIntent(intent)) return;
    await applyRoute(readWorkspaceRoute(), intent);
    if (!currentIntent(intent)) return;
    if (sessionStorage.getItem('dooknow-welcome-action') === 'create-note') {
      create('note', undefined, intent);
      if (createOpen.value) sessionStorage.removeItem('dooknow-welcome-action');
    }
  });
  window.addEventListener('dooknow-open-whiteboard', openDiagramEvent);
  window.addEventListener('dooknow-portable-diagram', portableDiagram);
  window.addEventListener('dooknow-edit-diagram-source', editDiagramSource);
  window.addEventListener('dooknow-portable-whiteboard', portableWhiteboard);
  window.addEventListener('dooknow-git-return-save', returnGitSave);
  window.addEventListener('keydown', shortcut);
  window.addEventListener('beforeunload', unload);
});
onBeforeUnmount(() => {
  documentResizeObserver?.disconnect();
  window.removeEventListener('resize', measureDocumentWidth);
  alive = false;
  uploadQueue.items.forEach(item=>uploadQueue.cancel(item.id));
  navigationIntent++;
  invalidateDraftIdentity();
  treeRefreshEpoch++;
  viewEpoch++;
  searchEpoch++;
  editorViews.cancel();
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
  window.removeEventListener('dooknow-open-whiteboard', openDiagramEvent);
  window.removeEventListener('dooknow-portable-diagram', portableDiagram);
  window.removeEventListener('dooknow-edit-diagram-source', editDiagramSource);
  window.removeEventListener('dooknow-portable-whiteboard', portableWhiteboard);
  if(previewRef.value)clearDiagrams(previewRef.value);
  window.removeEventListener('dooknow-git-return-save', returnGitSave);
  window.removeEventListener('keydown', shortcut);
  window.removeEventListener('beforeunload', unload);
});
</script>
<template>
  <div
    :class="['workspace', { 'sidebar-collapsed': panel === 'apps' || (sidebarCollapsed && panel === 'note') }]"
    :style="{ '--sidebar-width': sidebarWidth + 'px', '--outline-width': outlineWidth + 'px' }"
  >
    <Transition name="scrim">
      <div v-if="drawer" class="drawer-scrim" @click="drawer = false"></div>
    </Transition>
    <aside id="notebook-navigation" :class="['sidebar', { open: drawer }]" aria-label="笔记导航">
      <div class="brand">
        <Icon name="book" :size="31" /><strong>DooKnow</strong
        ><button class="mobile-only icon-button" aria-label="关闭侧栏" @click="drawer = false">
          <Icon name="close" />
        </button>
      </div>
      <nav v-if="panel === 'settings'" class="settings-sidebar" aria-label="设置分类">
        <button class="settings-return" @click="backFromSettings()">
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
      <div v-show="panel !== 'settings' && panel !== 'apps'" class="notebook-sidebar-content">
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
                  <button :disabled="!treeLoaded" @click="createMenuOpen=false;create('whiteboard')"><Icon name="whiteboard"/>新建白板</button>
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
          ><button class="icon-button" aria-label="刷新目录" :disabled="treeRefreshing" :aria-busy="treeRefreshing" @click="run(refresh)">
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
        <div class="tree-scroll" :aria-busy="query ? searchBusy || searchWaiting : treeRefreshing">
          <template v-if="query"
            ><button
              v-for="r in results"
              :key="r.id"
              class="search-result"
              @click="
                run(() =>
                  r.type === 'folder'
                    ? select({ type: 'folder', name: r.title, path: r.relativePath })
                    : openNote(r.id, r.filenameMatch ? r.line : { line: r.line || 1, query: searchNeedle(query) }),
                )
              "
            >
              <b>{{ r.title }}</b
              ><small>{{ r.relativePath }}</small
              ><small v-if="!r.filenameMatch && r.line">第 {{ r.line }} 行</small
              ><span>{{ r.snippet }}</span>
            </button>
            <p v-if="searchDegraded && !searchError" class="search-feedback" role="status">
              {{ searchFeedback }}<button
                v-if="showSearchSettings"
                class="text-link"
                @click="settings('search')"
              >
                检查搜索设置
              </button>
            </p>
            <p v-if="results.length" class="muted search-results-count">
              已显示 {{ results.length }}
              {{ results.some((item) => item.type === 'folder') ? '项' : '篇' }}
            </p>
            <p
              v-if="searchBusy || searchWaiting"
              class="search-feedback"
              role="status"
              aria-live="polite"
            >
              <span class="loading-dot" aria-hidden="true"></span>
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
          ><LoadingState
            v-else-if="!treeLoaded && treeRefreshing"
            variant="list"
            label="正在读取目录…"
          /><div v-else-if="!treeLoaded" class="tree-load-error">
            <p class="muted">目录暂时无法读取</p>
            <AButton size="small" @click="run(refresh)">重新加载目录</AButton>
          </div><NoteCollection
            v-else-if="collection !== 'notes'"
            :entries="collectionEntries"
            :selected="selected"
            :kind="collection"
            :menu-path="treeMenuPath"
            :total="collectionFeed.total.value"
            @select="select"
            @menu="showTreeMenu"
            @browse="showCollection(collection === 'favorites' ? 'favorites' : 'recent')"
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
          <button
            v-if="gitAvailable"
            type="button"
            class="sidebar-tool-button"
            @click="gitSyncOpen = true"
          >
            <Icon name="refresh" :size="17" /><span>云端同步</span>
            <Icon class="sidebar-tool-chevron" name="chevron" :size="13" />
          </button>
          <PluginSlot slot-name="navigation" :context="pluginContext" sidebar />
          <PluginSlot slot-name="libraryAction" :context="pluginContext" sidebar />
        </div>
      </div>
      <WorkspaceFooter
        :username="props.username"
        :active="panel"
        :collection="collection"
        @collection="showCollection"
        @settings="settings"
        @trash="openTrash()"
        @logout="logout"
        @notes="openNotes"
        @apps="openApps()"
      />
    </aside>
    <SettingsOverlay
      ref="gitSyncOverlay"
      v-model:show="gitSyncOpen"
      title="云端同步"
      description="查看同步状态，管理云端关联并检查本次提交。"
      icon="refresh"
      kind="drawer"
      :width="900"
      :busy="gitPanelBusy"
      :dirty="gitPanelDirty"
      @after-leave="
        gitPanelBusy = false;
        gitPanelDirty = false;
      "
    >
      <GitRemotePanel
        v-if="gitSyncOpen"
        inline
        @return-save="returnGitSave"
        @busy-change="gitPanelBusy = $event"
        @dirty-change="gitPanelDirty = $event"
      />
    </SettingsOverlay>
    <DocumentProperties v-if="propertiesOpen" :markdown="propertiesSource" :read-only="formatDisabled" @apply="applyProperties" @close="propertiesOpen=false" />
    <MarkdownPaste v-if="markdownPasteOpen" :read-only="formatDisabled" @insert="pasteMarkdown" @close="markdownPasteOpen=false" />
    <NoteBacklinks v-if="backlinksOpen && note" :note-id="note.id" @open="openBacklink" @close="backlinksOpen=false" />
    <DiagramSaveDialog v-if="diagramSaveContext" :needs="diagramSaveContext.needs" :busy="diagramSaveBusy" :error="diagramSaveError" @generate="finishDiagramSave(true)" @source-only="finishDiagramSave(false)" @close="diagramSaveContext=undefined" />
    <EditorInsertMenu v-if="insertMenuOpen" :open="insertMenuOpen" :read-only="formatDisabled" @insert="insertSnippet" @close="insertMenuOpen=false" />
    <SidebarResizer v-model="sidebarWidth" @commit="saveSidebarWidth" />
    <main
      ref="mainRef"
      :class="['main-content', { 'utility-scroll': ['settings', 'trash', 'apps'].includes(panel) }]"
      :aria-busy="noteOpening || (!treeLoaded && treeRefreshing)"
      :tabindex="['settings', 'trash', 'apps'].includes(panel) ? 0 : undefined"
    >
      <div class="mobile-bar">
        <button class="icon-button" aria-label="打开侧栏" @click="drawer = true">
          <Icon name="menu" /></button
        ><b>DooKnow</b><span>{{ dirty ? '未保存' : '私人笔记' }}</span>
      </div>
      <div v-if="noteOpening || (!treeLoaded && treeRefreshing)" class="workspace-load-progress">
        <LoadingState variant="inline" :label="noteOpening ? '正在打开笔记…' : '正在读取目录…'" />
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
      <div v-if="uploadBusy" class="asset-upload-status" role="status" aria-live="polite" aria-busy="true">
        <span class="upload-progress-indicator" aria-hidden="true"></span>
        <span>上传中 · {{ uploadName }}</span>
      </div>
      <div v-if="uploadFailure && note?.id === uploadFailure.request.noteId && panel === 'note'" class="asset-upload-status upload-failure" role="alert">
        <span>{{ uploadFailure.file.name }} 上传失败：{{ uploadFailure.message }}</span>
        <AButton size="small" :disabled="uploadBusy" @click="retryUpload">重试上传</AButton>
      </div>
      <div v-if="batchItems.length && note?.id===batchContext?.noteId && panel==='note'" class="batch-upload-panel" aria-label="批量附件上传">
        <div v-for="item in batchItems" :key="item.id" class="batch-upload-item">
          <span>{{ item.data.file.name }}</span><span>{{ item.data.inserted?'已插入':({queued:'等待上传',uploading:'正在上传',succeeded:'待插入',failed:'上传失败',cancelled:'已取消'})[item.state] }}</span>
          <span v-if="item.error" role="alert">{{ item.error }}</span>
          <AButton v-if="item.state==='failed'" size="small" :disabled="uploadBusy" @click="retryBatch(item)">重试此附件</AButton>
        </div>
        <AButton v-if="batchItems.some(item=>item.state==='succeeded'&&!item.data.inserted)" size="small" :disabled="uploadBusy" @click="insertBatch(true)">插入已上传附件</AButton>
        <AButton size="small" :disabled="uploadBusy" @click="dismissBatch">清除上传记录</AButton>
      </div>
      <CollectionWorkspace v-if="panel === 'collection' && collection !== 'notes'" :kind="collection" :feed="collectionFeed" :favorite-busy="favoriteBusy" :menu-path="treeMenuPath" @select="select" @menu="showTreeMenu" @favorite="favoriteCard" @create="createFromCollection" />
      <WhiteboardWorkspace v-if="note && isWhiteboard(note.relativePath)" v-show="panel==='note'" ref="boardRef" :key="note.id" :board-id="note.id" :draft-scope="draftScope" @dirty="boardDirty=$event" @saved="onBoardSaved" @close="select({type:'folder',name:folder,path:folder})"/>
      <section v-if="note && !isWhiteboard(note.relativePath)" v-show="panel === 'note'" class="note-workspace">
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
                :source-editor="mode !== 'preview' && (!documentEditingEnabled || editorKind === 'source')"
                :uploading="uploadBusy || uploadPreparing"
                @move="showMove"
                @download="downloadNote"
                @history="history()"
                @upload="prepareUpload"
              @search="editorRef?.openSearch()"
              @insert-menu="openInsertMenu"
              @properties="openProperties"
              @export-html="exportReading(false)"
              @print="exportReading(true)"
                @delete="confirmDelete"
                ><button type="button" @click="captureNoteTask"><Icon name="task" />创建关联任务</button><PluginSlot slot-name="noteAction" :context="pluginContext"
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
              :uploading="uploadBusy || uploadPreparing"
              @format="formatNote"
              @insert-table="(rows, columns) => editorRef?.insertTable(rows, columns)"
              @whiteboard="openBoardPicker"
              @upload="prepareUpload"
              @paste-markdown="openMarkdownPaste"
              @backlinks="backlinksOpen=true"
              @search="editorRef?.openSearch()"
              @insert-menu="openInsertMenu"
              @properties="openProperties"
              @export-html="exportReading(false)"
              @print="exportReading(true)"
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
                v-if="outlineUsesPopup"
                v-model:open="outlineOpen"
                trigger="click"
                placement="bottomRight"
                destroy-tooltip-on-hide
              >
                <template #content>
                  <DocumentOutline
                    v-if="outlineOpen"
                    v-model:collapsed="collapsedOutline"
                    class="outline-popup"
                    :headings="normalOutline"
                    :active-line="activeHeading"
                    @select="goToHeading"
                    @keydown.esc.stop="closeOutlineFromKeyboard"
                  />
                </template>
                <AButton
                  ref="outlineTrigger"
                  class="outline-toggle"
                  type="text"
                  size="small"
                  aria-label="章节目录"
                  title="章节目录"
                  :aria-expanded="outlineOpen"
                  @keydown.esc="closeOutlineFromKeyboard"
                  ><Icon name="list" :size="17" /><span class="outline-toggle-label"
                    >章节目录</span
                  ></AButton
                >
              </APopover>
              <AButton
                v-else
                class="outline-toggle"
                type="text"
                size="small"
                aria-label="章节目录"
                :title="outlineDocked ? '收起章节目录' : '显示章节目录'"
                :aria-expanded="outlineDocked"
                @click="outlineDocked = !outlineDocked"
                ><Icon name="list" :size="17" /><span class="outline-toggle-label">章节目录</span></AButton
              >
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
          :inert="!draftIdentityReady || noteOpening || editorTransfer ? '' : undefined"
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
                    @upload-files="uploadFiles"
                    @insert-menu="openInsertMenu"
                    @replace-image="prepareImageReplacement"
                    :generation="editorGeneration"
                    :kind="documentEditingEnabled ? editorKind : 'source'"
                    :visible="mode !== 'preview'"
                    @fallback="reason=>{editorKind='source';editorHint=reason}"
                    @source="switchEditing('source',$event)"
                    @composing="editorComposing=$event"
                    ref="editorRef"
                    v-model="draft"
                    :read-only="
                      !draftIdentityReady || noteOpening || editorTransfer || draftLoading || draftBusy || !!recoveryDraft
                    "
                    :key="`${note.id}:${editorGeneration}`"
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
                    ref="previewRef"
                    class="markdown"
                    v-html="preview"
                    @click="clickPreview"
                    @scroll.passive="trackPreview"
                  ></div>
                </section>
              </div>
            </div>
            <aside v-if="!outlineUsesPopup && outlineDocked" id="document-outline" class="document-outline">
              <SidebarResizer
                v-model="outlineWidth"
                side="right"
                :min="200"
                :max="420"
                :default-width="228"
                label="调整章节目录宽度"
                controls="document-outline"
                @commit="saveOutlineWidth"
              />
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
          accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml,application/pdf" multiple
          :disabled="uploadBusy"
          hidden
          @change="upload"
        />
      </section>
      <section v-if="panel === 'empty'" class="utility-view workspace-empty">
        <LoadingState v-if="noteOpening || (!treeLoaded && treeRefreshing)" variant="document" :label="noteOpening ? '正在打开笔记…' : '正在准备工作区…'" />
        <div v-else-if="!treeLoaded" class="utility-empty">
          <Icon name="folder" :size="36" />
          <h1>暂时无法打开目录</h1>
          <p>请检查连接后重新尝试。</p>
          <AButton type="primary" @click="run(refresh)">重试连接</AButton>
        </div>
        <div v-else class="utility-empty">
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
              <th class="folder-entry-actions"><span class="sr-only">操作</span></th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="entry in folderEntries"
              :key="entry.path"
              :class="{ 'menu-open': treeMenuPath === entry.path }"
              @contextmenu.prevent.stop="showTreeMenu(entry, $event)"
              @keydown="folderRowKey(entry, $event)"
            >
              <td>
                <button type="button" class="folder-entry-open" @click="select(entry)">
                  <Icon :name="entry.type === 'folder' ? 'folder' : isWhiteboard(entry.path)?'whiteboard':'file'" :size="23" /><span>{{
                    entry.name
                  }}</span>
                </button>
              </td>
              <td>{{ entry.type === 'folder' ? '文件夹' : isWhiteboard(entry.path)?'白板':'Markdown' }}</td>
              <td :title="entry.path">
                {{
                  entry.updatedAt
                    ? new Date(entry.updatedAt).toLocaleString('zh-CN', {
                        timeZone: 'Asia/Shanghai',
                      })
                    : '—'
                }}
              </td>
              <td class="folder-entry-actions">
                <button
                  type="button"
                  class="folder-entry-more"
                  :aria-label="`${entry.name} 的更多操作`"
                  aria-haspopup="menu"
                  :aria-expanded="treeMenuPath === entry.path"
                  :aria-controls="treeMenuPath === entry.path ? 'tree-context-menu' : undefined"
                  @click.stop="showTreeMenu(entry, $event)"
                >
                  <Icon name="more" :size="18" />
                </button>
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
      <AppsWorkspace
        v-else-if="panel === 'apps'"
        ref="appsRef"
        :app="appsApp"
        :section="appsSection"
        :tree="tree"
        :model="blogModel"
        :selection="toDooSelection"
        @navigate="navigateApp"
        @open-note="openBlogNote"
        @note-created="run(refresh)"
      />
      <TrashWorkspace
        v-else-if="panel === 'trash'"
        @open-note="openNote"
        @changed="run(refresh)"
        @back="backFromSettings"
      />
      <SettingsWorkspace
        v-else-if="panel === 'settings'"
        :section="activeSetting"
        @settings="settings"
        :username="props.username"
        @changed="run(refresh)"
        @back="backFromSettings"
        @logout="logout"
        @open-note="openNote"
      />
    </main>
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
    <NModal v-model:show="toDooCaptureOpen" preset="card" class="dialog-card" title="从资料创建任务" :mask-closable="!toDooCaptureBusy" :close-on-esc="!toDooCaptureBusy" :closable="!toDooCaptureBusy">
      <form v-if="capturedTask" class="to-doo-capture-form" @submit.prevent="saveCapturedTask">
        <label>任务标题<AInput v-model:value="capturedTask.title" aria-label="任务标题" :maxlength="256" :disabled="toDooCaptureBusy" /></label>
        <label>目标或清单<ASelect v-model:value="capturedList" aria-label="目标或清单" :options="[{label:'收集箱',value:'inbox'},...captureLists.map(list=>({label:list.name,value:list.id}))]" :disabled="toDooCaptureBusy" /></label>
        <label>行动说明<AInput.TextArea v-model:value="capturedTask.description" aria-label="行动说明" :auto-size="{minRows:3,maxRows:10}" :disabled="toDooCaptureBusy" /></label>
        <p class="muted">{{ capturedTask.source?.draft ? '来源包含尚未保存的笔记内容，将保留本次引用快照，笔记仍由你手动保存。' : '任务将关联这篇资料，原文与勾选状态保持不变。' }}</p>
        <AAlert v-if="toDooCaptureError" type="error" :message="toDooCaptureError" role="alert" />
        <div class="dialog-actions"><AButton :disabled="toDooCaptureBusy" @click="toDooCaptureOpen=false">取消</AButton><AButton type="primary" html-type="submit" :loading="toDooCaptureBusy" :disabled="!capturedTask.title.trim()">创建任务</AButton></div>
      </form>
    </NModal>
    <NModal
      v-model:show="importOpen"
      preset="card"
      class="dialog-card"
      title="导入 Markdown"
      :mask-closable="!importBusy && !batchImportBusy"
      :close-on-esc="!importBusy && !batchImportBusy"
      :closable="!importBusy && !batchImportBusy"
    >
      <label>导入到</label
      ><DirectoryTreeSelect
        v-model:value="importFolder"
        label="导入目录"
        :disabled="importBusy || batchImportBusy"
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
          inline
          :folder-path="importFolder"
          :show-export="false"
          @busy="batchImportBusy = $event"
          @changed="run(refresh)"
          @open-note="
            (id) => {
              importOpen = false;
              run(() => openNote(id));
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
        <AButton :disabled="importBusy || batchImportBusy" @click="importOpen = false">完成</AButton>
      </div>
    </NModal>
    <PluginPanel />
    <Transition name="toast">
      <div v-if="notice" class="toast" role="status">
        <Icon name="check" :size="18" />{{ notice }}
      </div>
    </Transition>
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
    <ShareDialog v-model:show="shareOpen" :title="shareContext?.title || ''" :status="share" :busy="shareBusy" :error="dialogError" @action="shareAction" />
    <NModal
      v-model:show="createOpen"
      preset="card"
      class="dialog-card"
      :title="createKind === 'whiteboard' ? '新建白板' : createKind === 'note' ? '新建笔记' : '新建文件夹'"
      :aria-label="createKind === 'whiteboard' ? '新建白板' : createKind === 'note' ? '新建笔记' : '新建文件夹'"
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
        <label>{{ createKind !== 'folder' ? '文件名' : '文件夹名' }}</label
        ><AInput
          v-model:value="newName"
          :disabled="createBusy || inboxBusy"
          autofocus
          :aria-label="createKind !== 'folder' ? '文件名' : '文件夹名'"
          :placeholder="
            createKind !== 'folder'
              ? (createKind === 'whiteboard'?'例如：系统架构.excalidraw':'例如：新的想法.md')
              : !newFolder
                ? '选择上方用途后自动填写'
                : '例如：读书笔记'
          "
        />
        <p v-if="createKind==='whiteboard'" class="muted">创建后保存为 .excalidraw 白板文件，默认私有。</p>
        <p v-else class="muted">
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
    <NModal
      :show="!!folderDeleteTarget"
      preset="card"
      class="dialog-card"
      title="文件夹移入回收站？"
      :mask-closable="false"
      :closable="!folderDeleteBusy && !folderDeleteUncertain"
      :close-on-esc="!folderDeleteBusy && !folderDeleteUncertain"
      @update:show="
        (value) => {
          if (!value && !folderDeleteBusy && !folderDeleteUncertain) folderDeleteTarget = undefined;
        }
      "
    >
      <AAlert v-if="dialogError" type="error" :message="dialogError" role="alert" />
      <p class="tree-delete-path">{{ folderDeleteTarget?.path }}</p>
      <p>
        文件夹及其中的笔记、附件和子文件夹将一起移入回收站，可整体恢复。相关笔记的分享链接立即失效。
      </p>
      <p v-if="folderDeleteUncertain">操作结果尚未确认，请按原请求核对结果。</p>
      <div class="dialog-actions">
        <AButton
          v-if="!folderDeleteUncertain"
          :disabled="folderDeleteBusy"
          @click="folderDeleteTarget = undefined"
          >取消</AButton
        >
        <AButton
          danger
          type="primary"
          :loading="folderDeleteBusy"
          :disabled="folderDeleteBusy"
          @click="removeFolder"
          >{{ folderDeleteUncertain ? '核对删除结果' : '移入回收站' }}</AButton
        >
      </div>
    </NModal>
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
    <WhiteboardWorkspace ref="embeddedBoardRef" v-if="embeddedBoardId" :key="'embedded-'+embeddedBoardId" :board-id="embeddedBoardId" embedded :draft-scope="draftScope" @close="embeddedBoardId=undefined"/>
    <SettingsOverlay v-model:show="boardPickerOpen" title="插入白板" description="引用已有白板，或创建一块新的画布。" icon="whiteboard" :busy="boardCreating" :width="560">
      <div class="whiteboard-picker"><button v-for="board in flat.filter(item=>isWhiteboard(item.path))" :key="board.id" type="button" @click="insertBoard(board.id!)"><Icon name="whiteboard" :size="18"/><span>{{board.name}}<small>{{board.path}}</small></span><Icon name="chevron" :size="15"/></button><p v-if="!flat.some(item=>isWhiteboard(item.path))" class="muted">还没有白板，可以先创建一个。</p></div>
      <template #footer="{close}"><AButton :disabled="boardCreating" @click="close">取消</AButton><AButton type="primary" :loading="boardCreating" @click="createInlineBoard">新建并插入白板</AButton></template>
    </SettingsOverlay>
  </div>
</template>
<style scoped>
.main-content {
  position: relative;
}
.workspace-load-progress {
  position: absolute;
  inset: 0 0 auto;
  z-index: 12;
  display: flex;
  justify-content: flex-end;
  overflow: hidden;
  padding: 8px 12px;
  pointer-events: none;
  animation: pending-appear var(--motion-base, 180ms) ease 120ms backwards;
}
.workspace-load-progress::before {
  content: '';
  position: absolute;
  inset: 0 auto auto 0;
  width: 35%;
  height: 2px;
  background: var(--blue);
  animation: pending-progress 1.4s ease-in-out infinite;
}
.workspace-load-progress > .loading-state {
  padding: 7px 11px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel, #fff);
  box-shadow: 0 3px 12px #00000008;
}
.tree-load-error {
  padding: 12px 16px;
}
.workspace-empty > .loading-state {
  width: 100%;
}
.loading-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-right: 6px;
  vertical-align: middle;
  border-radius: 50%;
  background: var(--blue);
  animation: pending-appear 1s ease-in-out infinite alternate;
}
.tree-heading .icon-button[aria-busy='true'] > svg {
  animation: refresh-turn 1s linear infinite;
}
.scrim-enter-active,
.scrim-leave-active {
  transition: opacity var(--motion-base, 180ms) ease;
}
.scrim-enter-from,
.scrim-leave-to {
  opacity: 0;
}
.scrim-leave-active {
  pointer-events: none;
}
@keyframes pending-appear {
  from { opacity: 0.25; }
  to { opacity: 1; }
}
@keyframes pending-progress {
  from { transform: translateX(-100%); }
  to { transform: translateX(390%); }
}
@keyframes refresh-turn {
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .workspace-load-progress::before {
    animation: none;
    width: 100%;
  }
}
</style>
