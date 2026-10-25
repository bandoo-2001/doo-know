<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import { NModal } from 'naive-ui';
import { Alert as AAlert, Button as AButton, Spin as ASpin } from 'ant-design-vue';
import type { PublicShareAccess, PublicShareSource } from '../../../shared/share-contracts';
import type { EditorKind, EditorSnapshot } from '../editor/contracts';
import { ApiError } from '../api';
import {
  publicShareAsset,
  readPublicShareSource,
  savePublicShareSource,
} from '../public-share-api';
import { handleSaveShortcut } from '../editor/keyboard-shortcuts';
import NoteEditorHost from './NoteEditorHost.vue';
const props = defineProps<{ token: string; access: PublicShareAccess }>();
const emit = defineEmits<{ close: []; saved: [] }>();
const source = ref<PublicShareSource>(),
  draft = ref(''),
  baseline = ref(''),
  kind = ref<EditorKind>('document');
const busy = ref(false),
  loading = ref(false),
  error = ref(''),
  blocked = ref(false),
  warning = ref(''),
  composing = ref(false);
const confirmation = ref<'reload' | 'close'>(),
  editor = ref<{ flush(): Promise<EditorSnapshot> }>();
const generation = ref(0),
  dirty = computed(() => draft.value !== baseline.value),
  now = ref(Date.now());
const expired = computed(
  () => !!source.value?.expiresAt && new Date(source.value.expiresAt).getTime() <= now.value,
);
const saveDisabled = computed(
  () =>
    loading.value ||
    busy.value ||
    composing.value ||
    blocked.value ||
    expired.value ||
    !dirty.value,
);
let disposed = false,
  timer: ReturnType<typeof setInterval> | undefined;
let pending: { content: string; version: string; requestId: string } | undefined;
function explain(cause: unknown) {
  if (cause instanceof ApiError) {
    if (cause.status === 409)
      return '笔记已更新，当前编辑已保留。请先复制需要保留的内容，再重新载入最新内容后继续编辑。';
    if (cause.status === 404) {
      blocked.value = true;
      return '分享已到期、取消或链接已重置，无法保存。当前编辑已保留，可复制保存到本地。';
    }
    if (cause.status === 403 && /不能新增.*(?:附件|白板)|SHARE_RESOURCE/.test(cause.message))
      return `${cause.message}。当前编辑已保留，移除新增引用后可以重试。`;
    if (cause.status === 403) {
      blocked.value = true;
      return '分享已改为只读或编辑授权已失效，无法保存。当前编辑已保留，可复制保存到本地。';
    }
    if (cause.status === 400 || cause.status === 413 || cause.status === 422) {
      return `${cause.message}。公开编辑不支持新增私有附件或白板引用，也不能上传附件。当前编辑已保留。`;
    }
    if (cause.status === 429) return '请求较多，请稍后再保存。当前编辑已保留。';
  }
  return '暂时无法保存或读取，请检查连接后重试。当前编辑已保留。';
}
async function load() {
  if (loading.value || busy.value) return;
  loading.value = true;
  error.value = '';
  try {
    const result = await readPublicShareSource(props.token);
    if (disposed) return;
    source.value = result;
    draft.value = result.content;
    baseline.value = result.content;
    blocked.value = !result.canEdit;
    generation.value++;
    pending = undefined;
  } catch (cause) {
    if (!disposed) error.value = explain(cause);
  } finally {
    if (!disposed) loading.value = false;
  }
}
async function flush() {
  const snapshot = await editor.value?.flush();
  if (snapshot) draft.value = snapshot.markdown;
}
async function save() {
  if (saveDisabled.value || !source.value) return;
  busy.value = true;
  error.value = '';
  warning.value = '';
  try {
    await flush();
    if (!dirty.value) return;
    const content = draft.value,
      version = source.value.modifiedAt;
    if (!pending || pending.content !== content || pending.version !== version)
      pending = { content, version, requestId: crypto.randomUUID() };
    const result = await savePublicShareSource(props.token, {
      content,
      expectedModifiedAt: version,
      requestId: pending.requestId,
    });
    if (disposed) return;
    source.value.modifiedAt = result.modifiedAt;
    baseline.value = content;
    pending = undefined;
    emit('saved');
  } catch (cause) {
    if (!disposed) error.value = explain(cause);
  } finally {
    if (!disposed) busy.value = false;
  }
}
async function switchKind(value: EditorKind) {
  if (kind.value === value || busy.value || composing.value) return;
  try {
    await flush();
    kind.value = value;
  } catch (cause) {
    error.value = explain(cause);
  }
}
async function ask(action: 'reload' | 'close') {
  if (busy.value || loading.value) return;
  try {
    await flush();
    if (dirty.value) confirmation.value = action;
    else if (action === 'reload') await load();
    else emit('close');
  } catch (cause) {
    error.value = explain(cause);
  }
}
async function confirmDiscard() {
  const action = confirmation.value;
  confirmation.value = undefined;
  if (action === 'reload') await load();
  else if (action === 'close') emit('close');
}
function protect(event: BeforeUnloadEvent) {
  if (dirty.value || busy.value) {
    event.preventDefault();
    event.returnValue = '';
  }
}
function keyboard(event: KeyboardEvent) {
  handleSaveShortcut(event, () => void save());
}
function rejectUpload() {
  warning.value = '公开编辑不支持上传附件。原有图片和附件仍可保留。';
}
function openLink(url: string) {
  const asset = publicShareAsset(props.token, url);
  if (asset) window.open(asset, '_blank', 'noopener,noreferrer');
  else if (/^https?:\/\//i.test(url)) window.open(url, '_blank', 'noopener,noreferrer');
}
onMounted(() => {
  window.addEventListener('beforeunload', protect);
  timer = setInterval(() => {
    now.value = Date.now();
  }, 1000);
  void load();
});
onBeforeUnmount(() => {
  disposed = true;
  clearInterval(timer);
  window.removeEventListener('beforeunload', protect);
});
</script>
<template>
  <section class="public-share-editor" aria-label="编辑分享笔记" @keydown="keyboard">
    <div class="public-editor-toolbar">
      <div class="public-editor-modes" role="group" aria-label="编辑方式">
        <AButton
          :type="kind === 'document' ? 'primary' : 'default'"
          :disabled="busy || composing"
          @click="switchKind('document')"
          >文档编辑</AButton
        >
        <AButton
          :type="kind === 'source' ? 'primary' : 'default'"
          :disabled="busy || composing"
          @click="switchKind('source')"
          >Markdown 源码</AButton
        >
      </div>
      <span class="public-save-state" role="status">{{
        busy ? '正在保存…' : dirty ? '未保存' : '已保存'
      }}</span>
      <AButton type="primary" :loading="busy" :disabled="saveDisabled" @click="save"
        >保存修改</AButton
      >
      <AButton :disabled="busy || loading" @click="ask('close')">返回阅读</AButton>
    </div>
    <p class="public-editor-help">编辑这篇笔记后请手动保存。不支持上传附件；引用的白板仅供查看。</p>
    <AAlert
      v-if="error || expired"
      type="error"
      :message="error || '分享已到期，无法保存。当前编辑已保留，可复制保存到本地。'"
      role="alert"
      show-icon
    />
    <AAlert v-if="warning" type="warning" :message="warning" role="alert" show-icon />
    <div v-if="error" class="public-editor-recovery">
      <AButton :disabled="busy || loading" @click="ask('reload')">重新载入最新内容</AButton>
    </div>
    <div v-if="loading && !source" class="public-editor-loading">
      <ASpin />
      <p>正在读取可编辑原文…</p>
    </div>
    <NoteEditorHost
      v-if="source"
      :key="generation"
      ref="editor"
      v-model="draft"
      note-id="public-share"
      :share-token="token"
      :generation="generation"
      :kind="kind"
      :read-only="busy"
      :resolve-image="(url) => publicShareAsset(token, url)"
      @fallback="
        kind = 'source';
        warning = $event;
      "
      @source="switchKind('source')"
      @upload-file="rejectUpload"
      @upload-files="rejectUpload"
      @replace-image="rejectUpload"
      @open-link="openLink"
      @composing="composing = $event"
    />
    <NModal
      :show="!!confirmation"
      @update:show="
        (value) => {
          if (!value) confirmation = undefined;
        }
      "
      preset="card"
      class="dialog-card public-discard-dialog"
      title="当前编辑尚未保存"
      role="dialog"
      aria-label="当前编辑尚未保存"
    >
      <p>
        {{
          confirmation === 'reload'
            ? '重新载入会放弃当前未保存的编辑。请先复制需要保留的内容。'
            : '返回阅读会放弃当前未保存的编辑。请先复制需要保留的内容。'
        }}
      </p>
      <div class="dialog-actions">
        <AButton @click="confirmation = undefined">保留编辑</AButton
        ><AButton danger @click="confirmDiscard">{{
          confirmation === 'reload' ? '放弃编辑并重新载入' : '放弃编辑并返回阅读'
        }}</AButton>
      </div>
    </NModal>
  </section>
</template>
<style scoped>
.public-share-editor {
  width: 100%;
  max-width: 1120px;
  margin: 0 auto;
  flex: 1;
  padding: 24px 32px 40px;
  min-width: 0;
}
.public-editor-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--border);
}
.public-editor-modes {
  display: flex;
  gap: 6px;
}
.public-save-state {
  margin-left: auto;
  color: var(--muted);
  font-size: 12px;
}
.public-editor-help {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.8;
}
.public-editor-recovery {
  margin: 12px 0;
}
.public-editor-loading {
  text-align: center;
  padding: 64px 0;
  color: var(--muted);
}
.public-share-editor :deep(.note-editor-host) {
  display: flex;
  flex-direction: column;
  min-height: 55dvh;
  margin-top: 18px;
  border: 1px solid var(--border);
  border-radius: 7px;
  overflow: hidden;
}
.public-share-editor :deep(.cm-editor) {
  min-height: 55dvh;
}
.public-share-editor :deep(.document-editor) {
  flex: 1;
}
@media (max-width: 720px) {
  .public-share-editor {
    padding: 18px 16px 28px;
  }
  .public-editor-modes {
    width: 100%;
  }
  .public-editor-modes :deep(.ant-btn) {
    flex: 1;
  }
  .public-save-state {
    margin-right: auto;
    margin-left: 0;
  }
  .public-editor-toolbar {
    gap: 8px;
  }
}
</style>
