<script setup lang="ts">
import { ref, watch } from 'vue';
import { NModal, NSelect } from 'naive-ui';
import { Button as AButton, Input as AInput, Alert as AAlert } from 'ant-design-vue';
import { api, ApiError } from '../api';
import type { MoveNoteResult } from '../../../shared/knowledge-contracts';
const props = defineProps<{
  show: boolean;
  noteId?: string;
  relativePath?: string;
  modifiedAt?: string;
  folders: { label: string; value: string }[];
}>();
const emit = defineEmits<{ 'update:show': [value: boolean]; moved: [result: MoveNoteResult] }>();
const folder = ref(''),
  name = ref(''),
  busy = ref(false),
  error = ref('');
let requestId = crypto.randomUUID();
watch(
  () => props.show,
  (shown) => {
    if (!shown) return;
    const path = props.relativePath || '';
    folder.value = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    name.value = path.split('/').at(-1) || '';
    error.value = '';
    requestId = crypto.randomUUID();
  },
);
watch([folder, name], () => {
  requestId = crypto.randomUUID();
  error.value = '';
});
async function move() {
  if (busy.value || !props.noteId || !name.value.trim()) return;
  busy.value = true;
  error.value = '';
  try {
    const result = await api<MoveNoteResult>(`/api/notes/${props.noteId}/move`, 'POST', {
      folderPath: folder.value,
      fileName: name.value.endsWith('.md') ? name.value : name.value + '.md',
      expectedModifiedAt: props.modifiedAt,
      requestId,
    });
    emit('update:show', false);
    emit('moved', result);
  } catch (cause) {
    const code = cause instanceof ApiError ? String(cause.data.code || '') : '';
    const messages: Record<string, string> = {
      RELATIVE_REFERENCES_REQUIRE_REVIEW:
        '这篇笔记包含相对图片、附件或笔记链接。请先处理这些引用，再跨目录移动；也可以在原目录改名。',
      CROSS_DIRECTORY_MOVE_REQUIRES_REVIEW:
        '这篇较大的笔记无法安全核对全部引用，请先在原目录改名；跨目录整理需要进一步核对。',
      NAME_CONFLICT: '目标位置已有同名文件，请换一个名称。',
      VERSION_CONFLICT: '原文刚刚发生变化，请关闭此窗口并重新打开笔记后再整理。',
      MOVE_CONFLICT: '文件或目录在整理期间发生变化，请保留当前文件并到“数据与恢复”检查。',
      OPERATION_OUTCOME_UNKNOWN: '上次写入结果需要核对，请到“数据与恢复”检查后再整理。',
      INVALID_PATH: '目标位置不能使用，请选择知识库内已有的目录。',
      INVALID_NAME: '请使用不包含斜杠的 Markdown 文件名。',
    };
    error.value =
      messages[code] ||
      (cause instanceof Error ? cause.message : '暂时无法移动，请保留当前参数重试。');
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <NModal
    :show="show"
    preset="card"
    class="dialog-card"
    title="移动或重命名笔记"
    :mask-closable="!busy"
    :close-on-esc="!busy"
    :closable="!busy"
    @update:show="emit('update:show', $event)"
  >
    <AAlert v-if="error" type="error" :message="error" role="alert" />
    <p class="muted">
      保持笔记身份、历史版本和分享链接，不会覆盖已有文件。跨目录时会先核对相对引用。
    </p>
    <form @submit.prevent="move">
      <label>目标目录</label
      ><NSelect
        v-model:value="folder"
        :options="folders"
        filterable
        aria-label="目标目录"
        :disabled="busy"
      />
      <label for="move-note-name">文件名</label
      ><AInput id="move-note-name" v-model:value="name" :disabled="busy" autofocus />
      <p v-if="!folder" class="muted">知识库根目录仅支持 README.md。</p>
      <div class="dialog-actions">
        <AButton :disabled="busy" @click="emit('update:show', false)">取消</AButton
        ><AButton
          type="primary"
          html-type="submit"
          aria-label="确认移动"
          :loading="busy"
          :disabled="busy || !name.trim()"
          >确认移动</AButton
        >
      </div>
    </form>
  </NModal>
</template>
