<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, shallowRef, watch, type Component } from 'vue';
import { NModal } from 'naive-ui';
import { Alert as AAlert, Button as AButton } from 'ant-design-vue';
import Icon from './Icon.vue';
import type { ReadPage } from '../../../shared/knowledge-contracts';
import { api } from '../api';
import { pluginRegistry } from '../plugins';
import { createGitHistoryModel, gitRestoreMessages } from '../../../packages/plugin-ui/git-history';
import {
  createRevisionDiff,
  HISTORY_COMPARE_MAX_BYTES,
  nextRevisionReadInput,
  readRevisionPage,
  readRevisionList,
  type NoteRevision,
} from '../note-history';

const props = defineProps<{
  show: boolean;
  noteId: string;
  title: string;
  currentContent?: string;
  currentModifiedAt: string;
  dirty: boolean;
  busy: boolean;
  error?: string;
  savePending?: boolean;
  savePendingRestore?: boolean;
  baselineStale?: boolean;
}>();
const emit = defineEmits<{
  'update:show': [show: boolean];
  restore: [revision: NoteRevision];
  'check-save': [];
}>();

const historySource = ref<'saved' | 'git'>('saved');
const gitNotice = ref('');
const deferredContext = ref(false);
const gitNoteTitle = ref(props.title);
const editorBaselineStale = ref(!!props.baselineStale);
let savedRecordsStale = false;
let gitBaselineStale = false;
const gitAvailable = computed(() =>
  pluginRegistry.value.installed.some(
    (plugin) => plugin.id === 'git' && plugin.state === 'enabled',
  ),
);
const git = reactive(
  createGitHistoryModel({
    call: (kind, id, input) => api('/api/plugins/git/call', 'POST', { kind, id, input }),
    context: () => ({ noteId: props.noteId, expectedModifiedAt: props.currentModifiedAt }),
    friendlyError: (cause) => {
      const response = cause as any;
      const code = response?.data?.code || response?.data?.error?.code || response?.code;
      const labels: Record<string, string> = {
        GIT_REPOSITORY_MISSING: '尚未建立 Git 仓库，可在 Git 设置中初始化后查看提交。',
        GIT_DEPENDENCY_MISSING: '当前设备尚未准备好 Git，保存记录仍可正常使用。',
        VERSION_CONFLICT: '原文已更新，请保留草稿，关闭历史并重新核对笔记后恢复。',
        WORKSPACE_BUSY: '工作区正在写入，请稍后重试。',
      };
      return labels[String(code)] || message(cause);
    },
    onRestored: (noteId) => {
      savedRecordsStale = true;
      if (props.dirty) {
        editorBaselineStale.value = true;
        git.restoreNeedsReload = true;
      }
      gitNotice.value = props.dirty
        ? 'Git 提交已恢复，当前未保存草稿仍保留，请核对最新原文。'
        : 'Git 提交已恢复，恢复前的正文已保留在保存记录中。';
      window.dispatchEvent(new CustomEvent('dooknow-workspace-changed', { detail: { noteId } }));
    },
  }),
);
const historyBusy = computed(() => props.busy || git.busy);
const unresolved = computed(() => !!props.savePending || !!git.pendingRestore);
const historyLocked = computed(() => historyBusy.value || unresolved.value);
// The workspace must retain this component while a Git write is in flight or
// still needs reconciliation, including browser navigation outside the modal.
defineExpose({ hasPendingRestore: () => git.busy || !!git.pendingRestore });
const selectedGit = computed(() => git.rows.find((row) => row.commit === git.selected));
const gitSelectedId = computed({
  get: () => git.selected || '',
  set: (commit: string) => {
    if (!historyLocked.value) void git.show(commit);
  },
});

const renderer = shallowRef<Component>();
const diffToolbarHost = ref<HTMLElement>();
const rendererLoading = ref(false),
  rendererError = ref('');
let rendererGeneration = 0;
async function loadRenderer() {
  const generation = ++rendererGeneration;
  rendererLoading.value = true;
  rendererError.value = '';
  try {
    const module = await import('../../../packages/plugin-ui/diff-view');
    if (props.show && generation === rendererGeneration) renderer.value = module.DiffView;
  } catch {
    if (props.show && generation === rendererGeneration)
      rendererError.value = '差异视图暂不可用，仍可查看原始差异。';
  } finally {
    if (generation === rendererGeneration) rendererLoading.value = false;
  }
}

const revisions = ref<NoteRevision[]>([]);
const cursor = ref<string>();
const selected = ref<NoteRevision>();
const selectedId = computed({
  get: () => selected.value?.id || '',
  set: (id: string) => {
    const revision = revisions.value.find((item) => item.id === id);
    if (revision) void select(revision);
  },
});
const mode = ref<'compare' | 'source'>('compare');
const listLoading = ref(false),
  reading = ref(false),
  comparing = ref(false);
const listError = ref(''),
  readError = ref(''),
  diffError = ref('');
const source = ref(''),
  page = ref<ReadPage>();
const previewPagesInSession = ref(1);
const complete = ref(false),
  patch = ref<string>();
const compareNotice = ref(''),
  confirmRestore = ref(false),
  copyNotice = ref('');
let lifetime = 0,
  selectionGeneration = 0,
  diffGeneration = 0;
const utf8 = new TextEncoder();
const selectionBusy = computed(() => historyLocked.value);
const formatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});
function time(value?: string, format: 'full' | 'clock' | 'date' | 'short' = 'full') {
  if (!value) return '时间未知';
  const date = /^\d+$/.test(value) ? new Date(Number(BigInt(value) / 1_000_000n)) : new Date(value);
  if (!Number.isFinite(date.getTime())) return '时间未知';
  if (format === 'full') return formatter.format(date);
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  );
  const clock = `${parts.hour}:${parts.minute}:${parts.second}`;
  if (format === 'clock') return clock;
  if (format === 'date') return `${parts.year}/${parts.month}/${parts.day}`;
  return `${parts.month}/${parts.day} ${clock}`;
}
function size(bytes?: number) {
  if (bytes === undefined) return '大小未知';
  if (bytes < 1024) return `${bytes} B`;
  return bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(1)} KiB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
function versionTime(revision: NoteRevision, format: 'full' | 'clock' | 'date' | 'short' = 'full') {
  return time(revision.modifiedAt || revision.createdAt, format);
}
function message(cause: unknown) {
  return cause instanceof Error ? cause.message : '历史版本暂时不可用，请重试';
}
function invalidateSelection() {
  selectionGeneration++;
  diffGeneration++;
  reading.value = comparing.value = false;
  confirmRestore.value = false;
}
function canCompare(revision: NoteRevision) {
  return (
    !editorBaselineStale.value &&
    props.currentContent !== undefined &&
    utf8.encode(props.currentContent).byteLength <= HISTORY_COMPARE_MAX_BYTES &&
    !(revision.sizeBytes > HISTORY_COMPARE_MAX_BYTES)
  );
}
async function compare() {
  const generation = ++diffGeneration;
  patch.value = undefined;
  diffError.value = '';
  if (!complete.value || props.currentContent === undefined) return;
  comparing.value = true;
  const previous = source.value,
    current = props.currentContent;
  try {
    const result = await createRevisionDiff(previous, current);
    if (!props.show || generation !== diffGeneration) return;
    if (result.status === 'ready' || result.status === 'empty') {
      patch.value = result.diff;
      compareNotice.value = '';
    } else {
      compareNotice.value =
        result.status === 'too-large'
          ? '正文或差异较大，暂不生成完整对比。仍可查看历史原文和恢复此版本。'
          : '本次变化较多，暂不生成完整对比。仍可查看历史原文和恢复此版本。';
    }
  } catch (cause) {
    if (props.show && generation === diffGeneration) diffError.value = message(cause);
  } finally {
    if (generation === diffGeneration) comparing.value = false;
  }
}
async function select(revision: NoteRevision) {
  invalidateSelection();
  const generation = selectionGeneration,
    noteId = props.noteId;
  const active = () => props.show && props.noteId === noteId && generation === selectionGeneration;
  selected.value = revision;
  source.value = '';
  page.value = undefined;
  complete.value = false;
  patch.value = undefined;
  readError.value = diffError.value = copyNotice.value = '';
  const comparable = canCompare(revision);
  mode.value = comparable ? 'compare' : 'source';
  compareNotice.value = comparable
    ? ''
    : editorBaselineStale.value
      ? '原文已更新，当前草稿和编辑器基准仍保留。核对最新原文后可继续对比；历史原文仍可查看。'
      : '正文较大或当前文档不支持文本对比，暂不生成完整对比。仍可逐页查看历史原文和恢复此版本。';
  reading.value = true;
  try {
    const first = await readRevisionPage(
      api,
      noteId,
      revision.id,
      { maxBytes: 128 * 1024, range: { startLine: 1 } },
      active,
    );
    if (!first || !active()) return;
    page.value = first;
    previewPagesInSession.value = 1;
    source.value = first.content;
    complete.value = !first.hasMore;
    if (comparable) {
      const parts = [first.content];
      let last = first,
        bytes = utf8.encode(first.content).byteLength,
        pages = 1,
        pagesInSession = 1;
      while (last.hasMore && bytes <= HISTORY_COMPARE_MAX_BYTES && pages < 512) {
        const input = nextRevisionReadInput(last, pagesInSession);
        if (!input) throw new Error('历史原文尚未完整加载，请重试');
        const next = await readRevisionPage(api, noteId, revision.id, input, active);
        if (!next || !active()) return;
        if (
          next.snapshotId !== first.snapshotId ||
          next.sourceHash !== first.sourceHash ||
          next.startByte !== last.endByte
        )
          throw new Error('历史原文分页不连续，请重新读取');
        bytes += utf8.encode(next.content).byteLength;
        parts.push(next.content);
        last = next;
        pages++;
        pagesInSession = input.cursor ? pagesInSession + 1 : 1;
      }
      if (!last.hasMore && bytes <= HISTORY_COMPARE_MAX_BYTES) {
        source.value = parts.join('');
        complete.value = true;
        page.value = {
          ...last,
          startLine: first.startLine,
          startByte: first.startByte,
          content: source.value,
        };
      } else {
        complete.value = false;
        compareNotice.value =
          '历史正文较长，暂不生成完整对比。可在历史原文中逐页查看，也可直接恢复此版本。';
      }
    }
    if (comparable && complete.value) await compare();
  } catch (cause) {
    if (active()) readError.value = message(cause);
  } finally {
    if (active()) reading.value = false;
  }
}
async function nextPage() {
  const revision = selected.value,
    current = page.value;
  if (!revision || !current?.nextCursor || reading.value) return;
  const generation = selectionGeneration,
    noteId = props.noteId;
  const active = () => props.show && props.noteId === noteId && generation === selectionGeneration;
  reading.value = true;
  readError.value = copyNotice.value = '';
  try {
    const input = nextRevisionReadInput(current, previewPagesInSession.value);
    if (!input) return;
    const next = await readRevisionPage(api, noteId, revision.id, input, active);
    if (!next || !active()) return;
    if (
      next.snapshotId !== current.snapshotId ||
      next.sourceHash !== current.sourceHash ||
      next.startByte !== current.endByte
    )
      throw new Error('历史原文分页不连续，请重新读取');
    page.value = next;
    source.value = next.content;
    previewPagesInSession.value = input.cursor ? previewPagesInSession.value + 1 : 1;
  } catch (cause) {
    if (active()) readError.value = message(cause);
  } finally {
    if (active()) reading.value = false;
  }
}
async function load(more = false) {
  if (listLoading.value) return;
  const generation = lifetime,
    noteId = props.noteId;
  const active = () => props.show && props.noteId === noteId && generation === lifetime;
  listLoading.value = true;
  listError.value = '';
  try {
    const result = await readRevisionList(api, noteId, more ? cursor.value : undefined, active);
    if (!result || !active()) return;
    revisions.value = more ? [...revisions.value, ...result.items] : result.items;
    cursor.value = result.nextCursor;
    if (!selected.value && result.items[0]) void select(result.items[0]);
  } catch (cause) {
    if (active()) listError.value = message(cause);
  } finally {
    if (active()) listLoading.value = false;
  }
}
async function copy() {
  const generation = selectionGeneration,
    text = source.value;
  try {
    await navigator.clipboard.writeText(text);
    if (generation === selectionGeneration)
      copyNotice.value = complete.value ? '历史全文已复制' : '当前片段已复制';
  } catch {
    if (generation === selectionGeneration)
      copyNotice.value = '复制暂不可用，请在历史原文中手动选择复制';
  }
}
function restore() {
  if (!selected.value || historyLocked.value) return;
  confirmRestore.value = false;
  emit('restore', selected.value);
}
async function loadGit(more = false, preferredCommit?: string) {
  if (!gitAvailable.value || git.pendingRestore) return;
  gitNoteTitle.value = props.title;
  const generation = lifetime,
    id = props.noteId;
  await git.load(more);
  if (
    !props.show ||
    generation !== lifetime ||
    id !== props.noteId ||
    historySource.value !== 'git'
  )
    return;
  if (!git.selected && git.rows[0])
    await git.show(
      git.rows.some((row) => row.commit === preferredCommit)
        ? preferredCommit!
        : git.rows[0].commit,
    );
}
async function refreshGitBaseline() {
  if (
    !props.show ||
    !gitAvailable.value ||
    historySource.value !== 'git' ||
    git.busy ||
    git.pendingRestore
  )
    return;
  const preferred = git.selected;
  git.reset();
  gitBaselineStale = false;
  await loadGit(false, preferred);
}
function retryGit() {
  if (git.pendingRestore) return;
  if (git.selected && !git.diffCommit) void git.show(git.selected);
  else void loadGit(!!git.rows.length && !!git.cursor);
}
async function changeSource(target: 'saved' | 'git') {
  if (
    historyLocked.value ||
    (target === 'git' && !gitAvailable.value) ||
    target === historySource.value
  )
    return;
  historySource.value = target;
  confirmRestore.value = false;
  git.cancelRestore();
  if (target === 'git') {
    if (gitBaselineStale) await refreshGitBaseline();
    else if (!git.rows.length) await loadGit();
    else if (!git.selected && git.rows[0]) await git.show(git.rows[0].commit);
  } else if (savedRecordsStale) {
    lifetime++;
    invalidateSelection();
    listLoading.value = false;
    revisions.value = [];
    selected.value = undefined;
    cursor.value = undefined;
    savedRecordsStale = false;
    await load();
  }
}
function switchSource(event: KeyboardEvent, target: 'saved' | 'git') {
  if (historyLocked.value || (target === 'git' && !gitAvailable.value)) return;
  void changeSource(target);
  const list = (event.currentTarget as HTMLElement).closest('[role="tablist"]');
  list?.querySelector<HTMLElement>(`[data-source="${target}"]`)?.focus();
}
function closeHistory() {
  if (historyLocked.value) return;
  if (historySource.value === 'git' && git.confirmRestore) git.cancelRestore();
  else if (historySource.value === 'saved' && confirmRestore.value) confirmRestore.value = false;
  else emit('update:show', false);
}
function switchTab(event: KeyboardEvent, target: 'compare' | 'source') {
  mode.value = target;
  const button = event.currentTarget as HTMLElement;
  const sibling = target === 'source' ? button.nextElementSibling : button.previousElementSibling;
  (sibling as HTMLElement | null)?.focus();
}
function resetHistoryContext() {
  lifetime++;
  invalidateSelection();
  revisions.value = [];
  selected.value = undefined;
  cursor.value = undefined;
  listLoading.value = false;
  listError.value = '';
  if (git.busy || git.pendingRestore) {
    deferredContext.value = true;
    historySource.value = 'git';
    return;
  }
  deferredContext.value = false;
  historySource.value = 'saved';
  gitNotice.value = '';
  gitNoteTitle.value = props.title;
  savedRecordsStale = false;
  gitBaselineStale = false;
  editorBaselineStale.value = !!props.baselineStale;
  git.reset();
  if (props.show) void load();
}
watch(() => [props.show, props.noteId] as const, resetHistoryContext, { immediate: true });
watch(
  () => props.currentModifiedAt,
  () => {
    if (!props.show) return;
    editorBaselineStale.value = !!props.baselineStale;
    savedRecordsStale = true;
    gitBaselineStale = true;
    if (historySource.value === 'saved' && selected.value) void select(selected.value);
    if (historySource.value === 'git') void refreshGitBaseline();
  },
);
watch(
  () => props.baselineStale,
  (value) => {
    if (value) {
      editorBaselineStale.value = true;
      if (historySource.value === 'saved' && selected.value) void select(selected.value);
    }
  },
);
watch([() => git.busy, () => !!git.pendingRestore], ([busy, pending]) => {
  if (!props.show || busy || pending) return;
  if (deferredContext.value) resetHistoryContext();
  else if (gitBaselineStale && historySource.value === 'git') void refreshGitBaseline();
});
watch(patch, (value) => {
  if (value !== undefined && !renderer.value && !rendererLoading.value) void loadRenderer();
});
watch(
  () => git.diffCommit,
  (value) => {
    if (value && !renderer.value && !rendererLoading.value) void loadRenderer();
  },
);
watch(gitAvailable, (available) => {
  if (!available && !git.pendingRestore && !git.busy) {
    git.reset();
    if (historySource.value === 'git') void changeSource('saved');
  }
});
onBeforeUnmount(() => {
  lifetime++;
  rendererGeneration++;
  invalidateSelection();
  git.dispose();
});
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    aria-label="历史版本"
    class="note-history-dialog"
    :mask-closable="!historyLocked"
    :close-on-esc="!historyLocked"
    :closable="!historyLocked"
    @update:show="
      (value) => {
        if (!historyLocked) emit('update:show', value);
      }
    "
  >
    <template #header>
      <div class="note-history-heading">
        <span class="note-history-heading-icon"><Icon name="clock" :size="21" /></span>
        <div>
          <h2>历史版本</h2>
          <p :title="deferredContext ? gitNoteTitle : title">
            <Icon name="file" :size="12" />{{ deferredContext ? gitNoteTitle : title }}
          </p>
        </div>
      </div>
    </template>
    <template #header-extra>
      <div class="note-history-source-bar" role="tablist" aria-label="历史来源">
        <button
          id="note-history-saved-source"
          type="button"
          role="tab"
          data-source="saved"
          :aria-selected="historySource === 'saved'"
          :tabindex="historySource === 'saved' ? 0 : -1"
          aria-controls="note-history-source-pane"
          :disabled="historyLocked"
          @click="changeSource('saved')"
          @keydown.right.prevent="switchSource($event, 'git')"
        >
          <Icon name="clock" :size="15" />保存记录
        </button>
        <button
          v-if="gitAvailable || historySource === 'git'"
          id="note-history-git-source"
          type="button"
          role="tab"
          data-source="git"
          :aria-selected="historySource === 'git'"
          :tabindex="historySource === 'git' ? 0 : -1"
          aria-controls="note-history-source-pane"
          :disabled="historyLocked"
          @click="changeSource('git')"
          @keydown.left.prevent="switchSource($event, 'saved')"
        >
          <Icon name="git-branch" :size="15" />Git 提交
        </button>
      </div>
    </template>
    <div
      id="note-history-source-pane"
      class="note-history-source-pane"
      role="tabpanel"
      :aria-labelledby="
        historySource === 'saved' ? 'note-history-saved-source' : 'note-history-git-source'
      "
    >
      <template v-if="historySource === 'saved'">
        <AAlert v-if="error" type="error" :message="error" role="alert" />
        <AAlert v-if="listError" type="error" :message="listError" role="alert">
          <template #action
            ><AButton size="small" @click="load(!!revisions.length)">重试加载</AButton></template
          >
        </AAlert>
        <div v-if="revisions.length" class="note-history-layout">
          <nav class="note-history-list" aria-label="历史版本列表">
            <div class="note-history-list-heading">
              <span>版本记录</span><span class="note-history-count">{{ revisions.length }}</span>
            </div>
            <label class="note-history-mobile-picker">
              <Icon name="clock" :size="16" />
              <select v-model="selectedId" aria-label="选择历史版本" :disabled="selectionBusy">
                <option v-for="revision in revisions" :key="revision.id" :value="revision.id">
                  {{ versionTime(revision, 'short') }} · {{ size(revision.sizeBytes) }}
                </option>
              </select>
            </label>
            <ul>
              <li v-for="(revision, index) in revisions" :key="revision.id">
                <button
                  type="button"
                  class="note-history-version"
                  :aria-pressed="selected?.id === revision.id"
                  :disabled="selectionBusy"
                  :title="
                    '该版本最后修改于 ' +
                    versionTime(revision) +
                    '；保全于 ' +
                    time(revision.createdAt)
                  "
                  @click="select(revision)"
                >
                  <span class="note-history-version-icon"><Icon name="clock" :size="15" /></span>
                  <span class="note-history-version-copy">
                    <span class="note-history-version-top"
                      ><time>{{ versionTime(revision, 'clock') }}</time
                      ><span v-if="index === 0" class="note-history-recent">最近</span></span
                    >
                    <span class="note-history-version-meta"
                      ><span>{{ versionTime(revision, 'date') }}</span
                      ><span>·</span><span>{{ size(revision.sizeBytes) }}</span></span
                    >
                  </span>
                  <Icon
                    v-if="selected?.id === revision.id"
                    name="check"
                    :size="14"
                    class="note-history-selected-icon"
                  />
                </button>
              </li>
            </ul>
            <AButton v-if="cursor" block :loading="listLoading" :disabled="busy" @click="load(true)"
              >加载更早版本</AButton
            >
          </nav>
          <section v-if="selected" class="note-history-detail" :aria-busy="reading || comparing">
            <div class="note-history-detail-heading">
              <div class="note-history-reference">
                <strong><span class="note-history-reference-dot" />历史版本</strong
                ><time :title="versionTime(selected)">{{ versionTime(selected, 'short') }}</time>
              </div>
              <span class="note-history-versus"><Icon name="forward" :size="15" /></span>
              <div class="note-history-reference note-history-reference-current">
                <strong
                  ><span class="note-history-reference-dot" />{{
                    editorBaselineStale ? '编辑器原保存版本' : '当前已保存版本'
                  }}</strong
                ><time :title="time(currentModifiedAt)">{{
                  time(currentModifiedAt, 'short')
                }}</time>
              </div>
            </div>
            <p v-if="dirty" class="note-history-draft">
              未保存的草稿不参与对比；恢复时会先询问如何处理草稿。
            </p>
            <div class="note-history-control-row">
              <div class="note-history-tabs" role="tablist" aria-label="历史内容视图">
                <button
                  id="note-history-compare-tab"
                  type="button"
                  role="tab"
                  :aria-selected="mode === 'compare'"
                  :tabindex="mode === 'compare' ? 0 : -1"
                  aria-controls="note-history-content"
                  @click="mode = 'compare'"
                  @keydown.right.prevent="switchTab($event, 'source')"
                >
                  <Icon name="git-branch" :size="14" />差异对比
                </button>
                <button
                  id="note-history-source-tab"
                  type="button"
                  role="tab"
                  :aria-selected="mode === 'source'"
                  :tabindex="mode === 'source' ? 0 : -1"
                  aria-controls="note-history-content"
                  @click="mode = 'source'"
                  @keydown.left.prevent="switchTab($event, 'compare')"
                >
                  <Icon name="file" :size="14" />历史原文
                </button>
              </div>
              <div ref="diffToolbarHost" class="note-history-layout-outlet" />
            </div>
            <AAlert v-if="readError" type="error" :message="readError" role="alert">
              <template #action
                ><AButton size="small" @click="select(selected!)">重试读取</AButton></template
              >
            </AAlert>
            <p v-if="reading" class="note-history-status" role="status">正在读取历史原文…</p>
            <div
              id="note-history-content"
              role="tabpanel"
              :aria-labelledby="
                mode === 'compare' ? 'note-history-compare-tab' : 'note-history-source-tab'
              "
            >
              <template v-if="mode === 'compare'">
                <p v-if="compareNotice" class="note-history-status">{{ compareNotice }}</p>
                <p v-if="comparing" class="note-history-status" role="status">正在计算版本差异…</p>
                <AAlert v-if="diffError" type="error" :message="diffError" role="alert">
                  <template #action
                    ><AButton size="small" @click="compare">重试对比</AButton></template
                  >
                </AAlert>
                <template v-if="patch !== undefined">
                  <component
                    v-if="renderer"
                    :is="renderer"
                    :key="selected.id"
                    :diff="patch"
                    :file-label="title"
                    :toolbar-target="diffToolbarHost"
                  />
                  <div v-else class="git-diff-view">
                    <p class="note-history-status" role="status">
                      {{ rendererLoading ? '正在准备差异视图…' : rendererError }}
                    </p>
                    <AButton v-if="rendererError" size="small" @click="loadRenderer"
                      >重试差异视图</AButton
                    >
                    <details open>
                      <summary>原始差异</summary>
                      <pre class="note-history-source">{{ patch }}</pre>
                    </details>
                  </div>
                </template>
              </template>
              <template v-else>
                <p v-if="compareNotice" class="note-history-status">{{ compareNotice }}</p>
                <template v-if="page">
                  <div class="note-history-source-tools">
                    <span>{{
                      complete
                        ? '完整原文'
                        : `当前片段 · 第 ${page.startLine}–${page.endLine} 行 · ${page.startByte}–${page.endByte} 字节`
                    }}</span>
                    <AButton size="small" @click="copy">{{
                      complete ? '复制全文' : '复制当前片段'
                    }}</AButton>
                  </div>
                  <pre class="note-history-source">{{ source }}</pre>
                  <AButton v-if="!complete && page.nextCursor" :loading="reading" @click="nextPage"
                    >下一片段</AButton
                  >
                  <p v-else-if="!complete" class="note-history-status">已到历史原文末尾。</p>
                  <p v-if="copyNotice" class="note-history-status" role="status">
                    {{ copyNotice }}
                  </p>
                </template>
              </template>
            </div>
          </section>
        </div>
        <p v-else-if="listLoading" class="note-history-empty" role="status">正在加载历史版本…</p>
        <div v-else-if="!listError" class="note-history-empty">
          <span class="note-history-empty-icon"><Icon name="clock" :size="24" /></span>
          <strong>尚无历史版本</strong>
          <p>保存笔记修改后，可以在这里查看和恢复之前的内容。</p>
        </div>
      </template>
      <template v-else>
        <AAlert
          v-if="deferredContext"
          type="warning"
          message="正在核对之前笔记的恢复结果。完成后将显示当前笔记的历史。"
          role="alert"
        />
        <AAlert v-if="git.error" type="error" :message="git.error" role="alert">
          <template v-if="!git.pendingRestore && !git.restoreNeedsReload" #action
            ><AButton size="small" @click="retryGit">重试读取</AButton></template
          >
        </AAlert>
        <AAlert
          v-if="!gitAvailable"
          type="warning"
          message="Git 插件当前不可用，保存记录仍可正常使用。"
          role="alert"
        />
        <AAlert
          v-if="git.restoreNeedsReload"
          type="warning"
          message="原文版本需要重新核对。当前草稿会保留，请关闭历史并重新读取笔记后再恢复。"
          role="alert"
        />
        <div v-if="git.rows.length" class="note-history-layout">
          <nav class="note-history-list note-history-git-list" aria-label="Git 提交列表">
            <div class="note-history-list-heading">
              <span>提交记录</span><span class="note-history-count">{{ git.rows.length }}</span>
            </div>
            <label class="note-history-mobile-picker"
              ><Icon name="git-branch" :size="16" />
              <select v-model="gitSelectedId" aria-label="选择 Git 提交" :disabled="historyLocked">
                <option v-for="entry in git.rows" :key="entry.commit" :value="entry.commit">
                  {{ time(entry.at, 'short') }} · {{ entry.message || '无提交说明' }}
                </option>
              </select>
            </label>
            <ul>
              <li v-for="entry in git.rows" :key="entry.commit">
                <button
                  type="button"
                  class="note-history-version note-history-git-version"
                  :aria-pressed="git.selected === entry.commit"
                  :disabled="historyLocked"
                  :title="entry.author + ' · ' + entry.message + ' · ' + time(entry.at)"
                  @click="git.show(entry.commit)"
                >
                  <span class="note-history-version-icon"
                    ><Icon name="git-branch" :size="15"
                  /></span>
                  <span class="note-history-version-copy">
                    <span class="note-history-git-message">{{
                      entry.message || '无提交说明'
                    }}</span>
                    <span class="note-history-git-author">{{ entry.author }}</span>
                    <span class="note-history-version-meta"
                      ><code>{{ entry.commit.slice(0, 8) }}</code
                      ><span>·</span><time>{{ time(entry.at, 'short') }}</time></span
                    >
                  </span>
                  <Icon
                    v-if="git.selected === entry.commit"
                    name="check"
                    :size="14"
                    class="note-history-selected-icon"
                  />
                </button>
              </li>
            </ul>
            <AButton
              v-if="git.cursor"
              block
              :loading="git.loading"
              :disabled="historyLocked"
              @click="loadGit(true)"
              >更早的 Git 提交</AButton
            >
          </nav>
          <section class="note-history-detail" :aria-busy="git.diffLoading">
            <template v-if="selectedGit">
              <div class="note-history-git-heading">
                <span class="note-history-git-commit"
                  ><Icon name="git-branch" :size="14" /><code>{{
                    selectedGit.commit.slice(0, 12)
                  }}</code></span
                >
                <h3>{{ selectedGit.message || '无提交说明' }}</h3>
                <p>{{ selectedGit.author }} · {{ time(selectedGit.at) }}</p>
              </div>
              <p class="note-history-git-baseline">
                <strong>本次提交变更</strong
                ><span>仅显示该提交引入的变化，不包含当前未提交的内容。</span>
              </p>
              <p v-if="dirty" class="note-history-draft">
                当前未保存的草稿不会参与对比，恢复后仍会保留。
              </p>
              <AAlert
                v-if="git.restoreBlockedCode"
                type="warning"
                :message="
                  gitRestoreMessages[git.restoreBlockedCode] ||
                  gitRestoreMessages.GIT_RESTORE_UNSUPPORTED
                "
                role="alert"
              />
              <p v-if="gitNotice" class="note-history-status" role="status">{{ gitNotice }}</p>
              <p v-if="git.diffLoading" class="note-history-status" role="status">
                正在读取提交差异…
              </p>
              <div class="note-history-git-content">
                <template v-if="git.diffCommit === git.selected">
                  <component
                    v-if="renderer"
                    :is="renderer"
                    :key="git.diffCommit"
                    :diff="git.diff"
                    :truncated="git.diffTruncated"
                    :file-label="deferredContext ? gitNoteTitle : title"
                  />
                  <div v-else class="git-diff-view">
                    <p class="note-history-status" role="status">
                      {{ rendererLoading ? '正在准备差异视图…' : rendererError }}
                    </p>
                    <AButton v-if="rendererError" size="small" @click="loadRenderer"
                      >重试差异视图</AButton
                    >
                    <p v-if="git.diffTruncated" class="note-history-status">
                      差异超过 256 KiB，请在服务器查看。
                    </p>
                    <details v-else open>
                      <summary>原始差异</summary>
                      <pre class="note-history-source">{{ git.diff }}</pre>
                    </details>
                  </div>
                </template>
              </div>
            </template>
            <p v-else class="note-history-status">选择一条提交，查看变更内容。</p>
          </section>
        </div>
        <p v-else-if="git.loading" class="note-history-empty" role="status">正在加载 Git 提交…</p>
        <div v-else-if="!git.error" class="note-history-empty">
          <span class="note-history-empty-icon"><Icon name="git-branch" :size="24" /></span
          ><strong>暂无 Git 提交记录</strong>
          <p>这篇笔记提交到 Git 后，可以在这里查看变更和恢复历史内容。</p>
        </div>
      </template>
    </div>
    <template #footer>
      <div class="note-history-footer">
        <div class="note-history-protection">
          <Icon name="shield" :size="17" />
          <div>
            <p>恢复前会保留当前原文<span>，并检查版本是否变化。</span></p>
            <p
              v-if="historySource === 'saved' && confirmRestore"
              class="note-history-confirm"
              role="status"
            >
              将恢复 {{ selected && versionTime(selected) }} 的历史原文，替换当前已保存内容。
            </p>
            <p
              v-if="historySource === 'git' && git.confirmRestore"
              class="note-history-confirm"
              role="status"
            >
              将恢复提交 {{ git.selected?.slice(0, 12) }}。当前未保存的编辑草稿会保留。
            </p>
          </div>
        </div>
        <div class="note-history-footer-actions">
          <AButton :disabled="historyLocked" @click="closeHistory">{{
            (historySource === 'saved' && confirmRestore) ||
            (historySource === 'git' && git.confirmRestore)
              ? '取消恢复'
              : '关闭'
          }}</AButton>
          <AButton
            v-if="savePending"
            type="primary"
            :loading="busy"
            :disabled="historyBusy"
            @click="emit('check-save')"
            >{{ savePendingRestore ? '核对恢复结果' : '核对保存结果' }}</AButton
          >
          <template v-else-if="historySource === 'saved'">
            <AButton
              v-if="selected && !confirmRestore"
              type="primary"
              :disabled="historyLocked"
              @click="confirmRestore = true"
              ><template #icon><Icon name="undo" :size="15" /></template>恢复此版本</AButton
            >
            <AButton
              v-else-if="selected"
              type="primary"
              :loading="busy"
              :disabled="historyLocked"
              @click="restore"
              >确认恢复</AButton
            >
          </template>
          <template v-else>
            <AButton
              v-if="!git.confirmRestore"
              type="primary"
              :disabled="
                historyBusy ||
                !git.diffCommit ||
                git.diffLoading ||
                git.restoreNeedsReload ||
                !!git.restoreBlockedCode ||
                !gitAvailable
              "
              @click="git.confirmRestore = true"
              ><template #icon><Icon name="undo" :size="15" /></template>恢复此版本</AButton
            >
            <AButton
              v-else
              type="primary"
              :loading="git.busy"
              :disabled="historyBusy || git.restoreNeedsReload || !!git.restoreBlockedCode"
              @click="git.restore"
              >{{ git.pendingRestore ? '核对恢复结果' : '确认恢复笔记' }}</AButton
            >
          </template>
        </div>
      </div>
    </template>
  </NModal>
</template>

<style scoped>
:global(.n-card.note-history-dialog) {
  width: min(1480px, calc(100vw - 32px));
  height: calc(100dvh - 32px);
  max-height: calc(100dvh - 32px);
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 16px;
  box-shadow:
    0 24px 90px #17223b30,
    0 4px 16px #17223b0a;
  color: var(--text);
}
:global(.note-history-dialog > .n-card-header) {
  flex-shrink: 0;
  padding: 12px 56px 12px 20px;
  border-bottom: 1px solid var(--border);
}
:global(.note-history-dialog > .n-card-content) {
  display: flex;
  flex: 1 1 0%;
  flex-direction: column;
  min-height: 0;
  padding: 0;
  overflow: hidden;
}
:global(.note-history-dialog > .n-card__footer) {
  flex-shrink: 0;
  padding: 10px 20px;
  border-top: 1px solid var(--border);
  background: var(--surface-soft, #fafbfc);
}
:global(.note-history-dialog > .n-card-content > .ant-alert) {
  margin: 12px 20px;
}
.note-history-source-pane {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}
.note-history-source-pane > :deep(.ant-alert) {
  flex-shrink: 0;
  margin: 12px 20px;
}
.note-history-source-bar {
  display: flex;
  flex-shrink: 0;
  gap: 6px;
  padding: 0;
}
.note-history-source-bar button {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 6px 12px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.note-history-source-bar button[aria-selected='true'] {
  border-color: color-mix(in srgb, var(--blue) 18%, transparent);
  background: var(--n-color, #fff);
  color: var(--blue);
  font-weight: 550;
}
.note-history-source-bar button:disabled {
  opacity: 0.6;
  cursor: default;
}
.note-history-source-bar button:focus-visible {
  outline: 2px solid var(--blue);
  outline-offset: 2px;
}
.note-history-git-version {
  min-height: 92px;
}
.note-history-git-message {
  display: -webkit-box;
  margin: 0 14px 4px 0;
  overflow: hidden;
  color: var(--text);
  font-size: 12px;
  font-weight: 550;
  line-height: 1.6;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.note-history-git-author {
  display: block;
  margin-bottom: 4px;
  color: var(--muted);
  font-size: 10px;
}
.note-history-git-version .note-history-version-meta {
  overflow: hidden;
  font-size: 9px;
}
.note-history-git-heading {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 4px 12px;
  margin: 0 0 8px;
}
.note-history-git-heading h3 {
  grid-column: 1;
  grid-row: 1;
  margin: 0;
  color: var(--text);
  font-size: 14px;
  font-weight: 600;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.note-history-git-heading p {
  grid-column: 1 / -1;
  margin: 0;
  color: var(--muted);
  font-size: 11px;
}
.note-history-git-commit {
  grid-column: 2;
  grid-row: 1;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 7px;
  border-radius: 5px;
  background: color-mix(in srgb, var(--blue) 7%, transparent);
  color: var(--blue);
  font-size: 11px;
}
.note-history-git-baseline {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 3px 9px;
  margin: 0 0 10px;
}
.note-history-git-baseline strong {
  flex-shrink: 0;
  color: var(--text);
  font-size: 12px;
  font-weight: 550;
}
.note-history-git-baseline span {
  color: var(--muted);
  font-size: 11px;
}
.note-history-git-content {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.note-history-detail > :deep(.ant-alert) {
  flex-shrink: 0;
  margin: 0 0 12px;
}
.note-history-heading {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.note-history-heading-icon {
  display: grid;
  place-items: center;
  flex: 0 0 32px;
  height: 32px;
  border: 1px solid color-mix(in srgb, var(--blue) 13%, transparent);
  border-radius: 9px;
  background: linear-gradient(
    145deg,
    color-mix(in srgb, var(--blue) 11%, transparent),
    color-mix(in srgb, var(--blue) 4%, transparent)
  );
  color: var(--blue);
}
.note-history-heading > div {
  display: flex;
  align-items: center;
  gap: 14px;
  min-width: 0;
}
.note-history-heading h2 {
  flex-shrink: 0;
  margin: 0;
  color: var(--text);
  font-size: 18px;
  font-weight: 650;
  line-height: 1.4;
  letter-spacing: -0.02em;
}
.note-history-heading p {
  display: flex;
  align-items: center;
  gap: 5px;
  max-width: 560px;
  min-width: 0;
  margin: 0;
  padding-left: 14px;
  border-left: 1px solid var(--border);
  overflow: hidden;
  color: var(--muted);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.note-history-heading p svg {
  flex-shrink: 0;
  opacity: 0.7;
}
.note-history-layout {
  display: grid;
  flex: 1;
  grid-template-columns: 200px minmax(0, 1fr);
  min-height: 0;
}
.note-history-list {
  min-height: 0;
  padding: 16px 10px;
  overflow: auto;
  border-right: 1px solid var(--border);
  background: var(--surface-soft, #fafbfc);
}
.note-history-list-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 0 10px 14px;
  color: var(--muted);
  font-size: 12px;
  font-weight: 500;
}
.note-history-count {
  display: grid;
  place-items: center;
  min-width: 23px;
  height: 21px;
  padding: 0 5px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--n-color, #fff);
  color: var(--muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.note-history-list ul {
  margin: 0 0 14px;
  padding: 0;
  list-style: none;
}
.note-history-list li + li {
  margin-top: 6px;
}
.note-history-version {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 72px;
  padding: 12px 10px;
  border: 1px solid transparent;
  border-radius: 9px;
  background: transparent;
  color: var(--text);
  text-align: left;
  cursor: pointer;
  font: inherit;
  transition:
    background 0.15s,
    border-color 0.15s;
}
.note-history-version:hover {
  background: color-mix(in srgb, var(--blue) 4%, transparent);
}
.note-history-version[aria-pressed='true'] {
  border-color: color-mix(in srgb, var(--blue) 14%, transparent);
  background: color-mix(in srgb, var(--blue) 7%, transparent);
}
.note-history-version[aria-pressed='true']::before {
  position: absolute;
  inset: 17px auto 17px -1px;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: var(--blue);
  content: '';
}
.note-history-version:focus-visible,
.note-history-tabs button:focus-visible {
  outline: 2px solid var(--blue);
  outline-offset: 2px;
}
.note-history-version:disabled {
  opacity: 0.6;
  cursor: default;
}
.note-history-version-icon {
  display: grid;
  place-items: center;
  flex: 0 0 28px;
  height: 28px;
  border: 1px solid var(--border);
  border-radius: 50%;
  background: var(--n-color, #fff);
  color: var(--muted);
}
.note-history-version[aria-pressed='true'] .note-history-version-icon {
  border-color: color-mix(in srgb, var(--blue) 20%, transparent);
  color: var(--blue);
}
.note-history-version-copy {
  min-width: 0;
  flex: 1;
}
.note-history-version-top {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 5px;
}
.note-history-version-top time {
  font-size: 13px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.01em;
}
.note-history-recent {
  padding: 1px 5px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--muted) 8%, transparent);
  color: var(--muted);
  font-size: 10px;
  line-height: 1.4;
}
.note-history-version-meta {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--muted);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.note-history-selected-icon {
  position: absolute;
  right: 9px;
  top: 14px;
  color: var(--blue);
}
.note-history-mobile-picker {
  display: none;
}
.note-history-detail {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  padding: 14px 18px 12px;
}
.note-history-detail-heading {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 32px minmax(0, 1fr);
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-soft, #fafbfc);
}
.note-history-reference {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.note-history-reference strong {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--muted);
  font-size: 11px;
  font-weight: 400;
}
.note-history-reference-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--blue);
}
.note-history-reference-current .note-history-reference-dot {
  background: #56a386;
}
.note-history-reference time {
  color: var(--text);
  font-size: 13px;
  font-weight: 550;
  font-variant-numeric: tabular-nums;
}
.note-history-versus {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border: 1px solid var(--border);
  border-radius: 50%;
  background: var(--n-color, #fff);
  color: var(--muted);
}
.note-history-draft {
  margin: 0 0 14px;
  padding: 8px 11px;
  border: 1px solid color-mix(in srgb, #bc8a32 16%, transparent);
  border-radius: 7px;
  background: color-mix(in srgb, #bc8a32 7%, transparent);
  font-size: 12px;
}
.note-history-control-row {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}
.note-history-control-row .note-history-tabs {
  margin-bottom: 0;
}
.note-history-layout-outlet {
  display: flex;
  align-items: center;
  min-width: 0;
}
.note-history-control-row .note-history-layout-outlet :deep(.git-diff-toolbar) {
  margin-bottom: 0;
}
.note-history-tabs {
  display: flex;
  flex: 0 0 auto;
  align-self: flex-start;
  gap: 3px;
  margin: 0 0 8px;
  padding: 2px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--surface-soft, #fafbfc);
}
.note-history-tabs button {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 4px 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: 12px;
  line-height: 1.5;
  cursor: pointer;
}
.note-history-tabs button[aria-selected='true'] {
  background: var(--n-color, #fff);
  color: var(--blue);
  font-weight: 550;
  box-shadow: 0 1px 4px #17223b13;
}
#note-history-content {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.note-history-status {
  margin: 0 0 12px;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.7;
}
.note-history-source-tools {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0 0 10px;
  color: var(--muted);
  font-size: 11px;
}
.note-history-source {
  margin: 0 0 12px;
  padding: 16px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-soft, #fafbfc);
  color: var(--text);
  font:
    13px/1.85 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.note-history-detail :deep(.git-diff-view) {
  margin: 0;
}
.note-history-detail :deep(.git-diff-toolbar) {
  gap: 2px;
  width: max-content;
  max-width: 100%;
  margin-bottom: 8px;
  padding: 2px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-soft, #fafbfc);
}
.note-history-detail :deep(.git-diff-toolbar button) {
  padding: 3px 10px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.6;
}
.note-history-detail :deep(.git-diff-toolbar button[aria-pressed='true']) {
  background: var(--n-color, #fff);
  color: var(--blue);
  box-shadow: 0 1px 3px #17223b12;
}
.note-history-detail :deep(.git-diff-layout-hint) {
  display: none;
}
.note-history-detail :deep(.git-diff-files) {
  max-height: none;
  overflow: visible;
  border-radius: 10px;
}
.note-history-detail :deep(.git-diff-file-heading) {
  align-items: center;
  gap: 6px 12px;
  padding: 11px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-soft, #fafbfc);
}
.note-history-detail :deep(.git-diff-file-heading strong) {
  font-size: 12px;
  font-weight: 550;
}
.note-history-detail :deep(.git-diff-count) {
  padding: 2px 7px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--n-color, #fff);
  font-size: 10px;
}
.note-history-detail :deep(.git-diff-table) {
  font-size: 13px;
  line-height: 1.85;
}
.note-history-detail :deep(.git-diff-table th) {
  padding: 6px;
  background: var(--n-color, #fff);
  font-family: inherit;
  font-size: 10px;
}
.note-history-detail :deep(.git-diff-table td) {
  padding: 2px 9px;
}
.note-history-detail :deep(.git-diff-number) {
  width: 38px;
  color: color-mix(in srgb, var(--muted) 75%, transparent);
  font-size: 11px;
}
.note-history-detail :deep(.git-diff-hunk td) {
  padding: 5px 10px;
  background: color-mix(in srgb, var(--blue) 5%, transparent);
  font-size: 10px;
}
.note-history-detail :deep(.git-diff-raw) {
  margin-top: 12px;
}
.note-history-detail :deep(.git-diff-raw summary) {
  color: var(--muted);
  font-size: 11px;
}
.note-history-empty {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin: 0;
  padding: 32px;
  text-align: center;
  color: var(--muted);
}
.note-history-empty-icon {
  display: grid;
  place-items: center;
  width: 52px;
  height: 52px;
  margin-bottom: 5px;
  border: 1px solid var(--border);
  border-radius: 15px;
  background: var(--surface-soft, #fafbfc);
  color: var(--blue);
}
.note-history-empty strong {
  color: var(--text);
  font-size: 14px;
  font-weight: 550;
}
.note-history-empty p {
  max-width: 290px;
  margin: 0;
  font-size: 12px;
  line-height: 1.8;
}
.note-history-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
}
.note-history-protection {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
}
.note-history-protection > svg {
  flex-shrink: 0;
  color: #5c9a83;
}
.note-history-footer p {
  margin: 0;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.8;
}
.note-history-footer .note-history-confirm {
  margin-top: 3px;
  color: var(--text);
}
.note-history-footer-actions {
  display: flex;
  flex-shrink: 0;
  gap: 8px;
}
.note-history-footer-actions :deep(.ant-btn) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 34px;
  padding: 0 15px;
  border-radius: 7px;
  font-size: 12px;
}
.note-history-footer-actions :deep(.ant-btn-primary) {
  box-shadow: 0 3px 9px color-mix(in srgb, var(--blue) 18%, transparent);
}
@media (max-width: 720px) {
  :global(.note-history-dialog > .n-card-header) {
    flex-wrap: wrap;
  }
  :global(.note-history-dialog > .n-card-header > .n-card-header__extra) {
    flex: 0 0 100%;
    order: 1;
    margin-top: 7px;
  }
  .note-history-source-bar {
    gap: 4px;
    padding: 0;
  }
  .note-history-source-bar button {
    padding: 5px 10px;
    font-size: 11px;
  }
  .note-history-git-heading h3 {
    font-size: 13px;
  }
  .note-history-git-baseline {
    margin-bottom: 8px;
  }
  :global(.n-card.note-history-dialog) {
    width: calc(100vw - 12px);
    height: calc(100dvh - 12px);
    max-height: calc(100dvh - 12px);
    border-radius: 10px;
  }
  :global(.note-history-dialog > .n-card-header) {
    padding: 10px 42px 10px 12px;
  }
  :global(.note-history-dialog > .n-card__footer) {
    padding: 8px 12px;
  }
  .note-history-heading {
    gap: 8px;
  }
  .note-history-heading-icon {
    flex-basis: 28px;
    height: 28px;
    border-radius: 8px;
  }
  .note-history-heading h2 {
    font-size: 16px;
  }
  .note-history-heading p {
    max-width: 230px;
    font-size: 11px;
    padding-left: 8px;
  }
  .note-history-heading > div {
    gap: 8px;
  }
  .note-history-layout {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr);
  }
  .note-history-list {
    padding: 7px 12px;
    overflow: visible;
    border-right: 0;
    border-bottom: 1px solid var(--border);
  }
  .note-history-list-heading,
  .note-history-list ul {
    display: none;
  }
  .note-history-mobile-picker {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 32px;
    padding: 0 10px;
    border: 1px solid var(--border);
    border-radius: 7px;
    background: var(--n-color, #fff);
    color: var(--muted);
  }
  .note-history-mobile-picker:focus-within {
    border-color: var(--blue);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--blue) 10%, transparent);
  }
  .note-history-mobile-picker > svg {
    flex-shrink: 0;
    color: var(--blue);
  }
  .note-history-mobile-picker select {
    flex: 1;
    width: 100%;
    min-width: 0;
    height: 100%;
    padding: 0;
    border: 0;
    outline: none;
    background: transparent;
    color: var(--text);
    font: inherit;
    font-size: 12px;
  }
  .note-history-list > :deep(.ant-btn) {
    height: 28px;
    margin-top: 8px;
    font-size: 11px;
  }
  .note-history-detail {
    padding: 10px 12px;
  }
  .note-history-detail-heading {
    grid-template-columns: minmax(0, 1fr) 20px minmax(0, 1fr);
    gap: 9px;
    margin-bottom: 8px;
    padding: 7px 10px;
    border-radius: 8px;
  }
  .note-history-reference {
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
  }
  .note-history-reference strong {
    font-size: 10px;
  }
  .note-history-reference time {
    font-size: 11px;
  }
  .note-history-versus {
    width: 22px;
    height: 22px;
  }
  .note-history-tabs {
    margin-bottom: 8px;
  }
  .note-history-control-row {
    gap: 8px;
  }
  .note-history-control-row .note-history-tabs {
    margin-bottom: 0;
  }
  .note-history-tabs button {
    padding: 4px 10px;
    font-size: 11px;
  }
  .note-history-detail :deep(.git-diff-toolbar) {
    margin-bottom: 8px;
  }
  .note-history-control-row .note-history-layout-outlet :deep(.git-diff-toolbar) {
    margin-bottom: 0;
  }
  .note-history-detail :deep(.git-diff-table) {
    font-size: 12px;
  }
  .note-history-detail :deep(.git-diff-table th) {
    padding: 5px 2px;
    white-space: nowrap;
  }
  .note-history-detail :deep(.git-diff-file-heading) {
    padding: 9px 10px;
  }
  .note-history-detail :deep(.git-diff-count) {
    padding: 1px 5px;
    font-size: 9px;
  }
  .note-history-detail :deep(.git-diff-table td) {
    padding: 2px 6px;
  }
  .note-history-detail :deep(.git-diff-number) {
    width: 30px;
    font-size: 10px;
  }
  .note-history-footer {
    flex-direction: column;
    align-items: stretch;
    gap: 6px;
  }
  .note-history-protection {
    gap: 7px;
  }
  .note-history-footer p {
    font-size: 10px;
  }
  .note-history-footer p > span {
    display: none;
  }
  .note-history-footer-actions {
    justify-content: flex-end;
  }
}
@media (max-width: 360px) {
  .note-history-control-row .note-history-tabs button {
    gap: 4px;
    padding: 4px 7px;
    font-size: 10px;
  }
  .note-history-layout-outlet :deep(.git-diff-toolbar button) {
    padding: 3px 7px;
    font-size: 10px;
  }
}
</style>
