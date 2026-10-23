<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { api, ApiError } from '../api';
import Icon from './Icon.vue';
import DraftRecovery from './DraftRecovery.vue';
import { useNoteDraft } from '../useNoteDraft';
import { noteDraftBase, type DraftScope } from '../drafts';
import { parseWhiteboard, MAX_WHITEBOARD_BYTES } from '../../../shared/whiteboard';
import type { NoteDocument } from '../../../shared/contracts';
import { downloadBlob } from '../whiteboards/download';
const props = defineProps<{ boardId: string; embedded?: boolean; draftScope?: DraftScope }>();
const emit = defineEmits<{ close: []; dirty: [value: boolean]; saved: [document: NoteDocument] }>();
const root = ref<HTMLElement>(),
  mount = ref<HTMLElement>(),
  document = ref<NoteDocument>();
const content = ref(''),
  savedContent = ref(''),
  error = ref(''),
  loading = ref(true),
  saving = ref(false),
  ready = ref(false),
  pauseAutosave = ref(false),
  conflict = ref(false),
  closing = ref(false),
  exporting = ref(false),
  draftNotice = ref('');
const dirty = computed(() => ready.value && content.value !== savedContent.value);
const draft = useNoteDraft(
  () => ({
    noteId: props.boardId,
    baseRevision: noteDraftBase({ modifiedAt: document.value?.modifiedAt || '' }),
    content: content.value,
    dirty: dirty.value,
    enabled: ready.value && !loading.value,
  }),
  (text) => {
    void restore(text, true);
  },
);
watch(
  () => props.draftScope,
  (value) => {
    if (value) draft.setup(value);
  },
  { immediate: true },
);
watch(dirty, (value) => emit('dirty', value), { immediate: true });
let canvas: ReturnType<(typeof import('../whiteboards/canvas'))['mountCanvas']> | undefined;
let timer: ReturnType<typeof setTimeout> | undefined,
  disposed = false,
  epoch = 0;
let pending: { content: string; expected: string; requestId: string } | undefined;
let savingPromise: Promise<void> | undefined;
async function showCanvas(text: string, baseline: boolean) {
  const scene = { ...parseWhiteboard(text), dooknow: { id: props.boardId } },
    generation = ++epoch;
  const { mountCanvas } = await import('../whiteboards/canvas');
  if (disposed || generation !== epoch || !mount.value) return;
  canvas?.dispose();
  canvas = mountCanvas(mount.value, scene, (value, initial) => {
    if (disposed || generation !== epoch) return;
    content.value = value;
    if (initial && baseline) savedContent.value = value;
    ready.value = true;
    clearTimeout(timer);
    if (
      dirty.value &&
      !pauseAutosave.value &&
      !error.value &&
      !conflict.value &&
      !draft.recovered.value
    )
      timer = setTimeout(() => void save(true), 1200);
  });
}
async function load() {
  if (saving.value) return;
  loading.value = true;
  error.value = '';
  ready.value = false;
  try {
    const result = await api<NoteDocument>('/api/notes/' + encodeURIComponent(props.boardId));
    if (disposed) return;
    parseWhiteboard(result.content);
    document.value = result;
    content.value = result.content;
    savedContent.value = result.content;
    pending = undefined;
    conflict.value = false;
    draft.prepare();
    await draft.load(props.boardId, noteDraftBase(result), result.content);
    await nextTick();
    await showCanvas(result.content, true);
  } catch (e) {
    if (!disposed) error.value = (e as Error).message;
  } finally {
    if (!disposed) loading.value = false;
  }
}
async function restore(text: string, manual = false) {
  pauseAutosave.value = manual;
  try {
    parseWhiteboard(text);
    content.value = text;
    await showCanvas(text, false);
  } catch (e) {
    error.value = (e as Error).message;
  }
}
async function save(automatic = false) {
  if (automatic && pauseAutosave.value) return;
  clearTimeout(timer);
  if (savingPromise) {
    await savingPromise;
    return;
  }
  if (
    !ready.value ||
    !document.value ||
    conflict.value ||
    draft.recovered.value ||
    (!dirty.value && !pending)
  )
    return;
  const work = async () => {
    pauseAutosave.value = false;
    saving.value = true;
    error.value = '';
    try {
      parseWhiteboard(content.value);
      const draftVersion = await draft.flush();
      pending ||= {
        content: content.value,
        expected: document.value!.modifiedAt,
        requestId: crypto.randomUUID(),
      };
      const request = pending;
      const result = await api<NoteDocument>('/api/notes/' + props.boardId, 'PUT', {
        content: request.content,
        expectedModifiedAt: request.expected,
        requestId: request.requestId,
      });
      if (disposed) return;
      document.value = result;
      savedContent.value = request.content;
      pending = undefined;
      if (content.value === request.content) await draft.clearSaved(props.boardId, draftVersion);
      emit('saved', result);
      window.dispatchEvent(
        new CustomEvent('dooknow-whiteboard-saved', { detail: { id: props.boardId } }),
      );
    } catch (e) {
      if (disposed) return;
      error.value = (e as Error).message;
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
        conflict.value = e.data.code === 'VERSION_CONFLICT';
        if (conflict.value)
          error.value = '白板已在其他位置更新。当前设计已保留，请下载草稿后重新读取。';
        pending = undefined;
      }
    } finally {
      saving.value = false;
    }
  };
  savingPromise = work();
  await savingPromise;
  savingPromise = undefined;
  if (!disposed && dirty.value && !pauseAutosave.value && !error.value && !conflict.value)
    timer = setTimeout(() => void save(true), 300);
}
async function close() {
  if (pauseAutosave.value && dirty.value) {
    closing.value = true;
    return;
  }
  await save();
  if (dirty.value || pending || draft.recovered.value) closing.value = true;
  else emit('close');
}
async function discard() {
  clearTimeout(timer);
  await draft.discard();
  pending = undefined;
  content.value = savedContent.value;
  emit('dirty', false);
  closing.value = false;
}
async function abandon() {
  try {
    await discard();
    emit('close');
  } catch (e) {
    error.value = (e as Error).message;
  }
}
function original() {
  downloadBlob(
    new Blob([content.value || document.value?.content || ''], { type: 'application/json' }),
    document.value?.relativePath.split('/').at(-1) || '白板.excalidraw',
  );
}
async function png() {
  if (!canvas || exporting.value) return;
  exporting.value = true;
  try {
    downloadBlob(await canvas.png(), (document.value?.title || '白板') + '.png');
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    exporting.value = false;
  }
}
async function importScene(event: Event) {
  const input = event.target as HTMLInputElement,
    file = input.files?.[0];
  input.value = '';
  if (!file) return;
  if (dirty.value || pending) {
    error.value = '请先保存或下载当前设计，再导入替换文件。';
    return;
  }
  try {
    if (file.size > MAX_WHITEBOARD_BYTES) throw Error('白板文件不能超过 8 MiB');
    const text = await file.text();
    parseWhiteboard(text);
    await restore(text);
    draftNotice.value = '文件已载入，正在保存到当前白板。';
  } catch (e) {
    error.value = (e as Error).message;
  }
}
function key(event: KeyboardEvent) {
  if (!root.value?.getClientRects().length) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    event.stopImmediatePropagation();
    void save();
  }
}
function unload(event: BeforeUnloadEvent) {
  if (dirty.value || pending) {
    event.preventDefault();
    event.returnValue = '';
  }
}
onMounted(() => {
  void load();
  window.addEventListener('keydown', key, true);
  window.addEventListener('beforeunload', unload);
});
onBeforeUnmount(() => {
  disposed = true;
  epoch++;
  clearTimeout(timer);
  canvas?.dispose();
  window.removeEventListener('keydown', key, true);
  window.removeEventListener('beforeunload', unload);
  emit('dirty', false);
});
defineExpose({ save, discard, requestClose: close, flush: () => draft.flush() });
</script>
<template>
  <section
    ref="root"
    class="whiteboard-workspace"
    :class="{ embedded }"
    data-testid="whiteboard-workspace"
    aria-label="白板设计工作区"
  >
    <header class="whiteboard-header">
      <button
        type="button"
        class="whiteboard-back"
        :aria-label="embedded ? '返回笔记' : '返回目录'"
        :disabled="saving"
        @click="close"
      >
        <Icon name="back" :size="17" /><span>{{ embedded ? '返回笔记' : '返回目录' }}</span>
      </button>
      <div class="whiteboard-heading">
        <span class="whiteboard-symbol"><Icon name="whiteboard" :size="21" /></span>
        <div>
          <h1>{{ document?.title || '白板设计' }}</h1>
          <p>自由设计 · Excalidraw</p>
        </div>
      </div>
      <span class="whiteboard-status" role="status" :class="{ unsaved: dirty }"
        ><i></i
        >{{
          loading
            ? '正在载入'
            : saving
              ? '正在保存…'
              : error
                ? '保存未完成'
                : dirty
                  ? '未保存'
                  : '已保存'
        }}</span
      >
      <div class="whiteboard-actions">
        <label class="whiteboard-button" :class="{ disabled: saving || !ready }"
          ><Icon name="upload" :size="15" /><span>导入</span
          ><input
            type="file"
            accept=".excalidraw,application/json"
            :disabled="saving || !ready"
            @change="importScene"
        /></label>
        <button type="button" :disabled="!ready" @click="original">原文件</button>
        <button type="button" :disabled="!ready || exporting" @click="png">导出 PNG</button>
        <button
          type="button"
          class="primary"
          aria-label="保存白板"
          :disabled="!ready || saving || conflict"
          @click="save()"
        >
          <Icon name="save" :size="15" />保存
        </button>
      </div>
    </header>
    <div v-if="error || draft.error.value" class="whiteboard-feedback" role="alert">
      <span>{{ error || draft.error.value }}</span
      ><button v-if="document" @click="original">下载草稿</button
      ><button v-if="conflict" @click="load">重新读取</button
      ><button v-else :disabled="saving" @click="ready ? save() : load()">重试</button>
    </div>
    <p v-if="draftNotice" class="whiteboard-hint" role="status">{{ draftNotice }}</p>
    <DraftRecovery
      v-if="draft.recovered.value"
      :draft="draft.recovered.value"
      :busy="draft.busy.value"
      :base-changed="
        draft.recovered.value.baseRevision !==
        noteDraftBase({ modifiedAt: document?.modifiedAt || '' })
      "
      @restore="draft.restore"
      @discard="draft.discard"
    />
    <div class="whiteboard-canvas" :inert="!!draft.recovered.value || closing">
      <div ref="mount" class="whiteboard-mount"></div>
      <div v-if="loading" class="whiteboard-loading">正在准备画布…</div>
    </div>
    <div v-if="closing" class="whiteboard-close-mask">
      <section
        class="whiteboard-close-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="保留白板设计"
      >
        <Icon name="whiteboard" :size="28" />
        <h2>当前设计还未保存</h2>
        <p>可以继续编辑、下载草稿，或放弃本次修改后返回。</p>
        <div>
          <button @click="closing = false">继续编辑</button
          ><button @click="original">下载草稿</button
          ><button :disabled="saving" @click="abandon">放弃修改并返回</button>
        </div>
      </section>
    </div>
  </section>
</template>
<style src="../whiteboards/whiteboards.css"></style>
