<script setup lang="ts">
import {
  Button as AButton,
  Checkbox as ACheckbox,
  Input as AInput,
  Modal as AModal,
  Textarea as ATextarea,
} from 'ant-design-vue';
import ToDooSelect from './ToDooSelect.vue';
import { computed, reactive, ref } from 'vue';
import type { TreeEntry } from '../../../../shared/contracts';
import type {
  ToDooOccurrence,
  ToDooTask,
  ToDooEntityMap,
} from '../../../../shared/to-doo-contracts';
import { toDooOutcomeResumeInput, type ToDooWorkbench } from '../../to-doo-workbench';
import DirectoryTreeSelect from '../DirectoryTreeSelect.vue';
import { useToDooConfirm } from '../../to-doo-controls';
const props = defineProps<{
  open?: boolean;
  model: ToDooWorkbench;
  task: ToDooTask;
  occurrence: ToDooOccurrence;
  tree: TreeEntry[];
  operation?: ToDooEntityMap['operation'];
}>();
const emit = defineEmits<{ close: []; saved: [id: string]; 'open-note': [id: string] }>();
const confirm = useToDooConfirm();
const form = reactive({
  title: props.operation?.title || props.task.title + ' · 成果',
  folderPath: props.operation?.folderPath || '',
  content: props.operation?.content || '# ' + props.task.title + '\n\n## 成果\n\n\n## 验证依据\n\n',
  verification: props.operation?.verification || 'self_assessed',
  complete: props.operation?.complete || false,
});
const baseline = JSON.stringify(form),
  requestId = props.operation?.requestId || crypto.randomUUID(),
  expectedRevision = ref(props.operation?.expectedRevision || props.occurrence.revision),
  submitted = ref<Record<string, unknown> | undefined>(
    props.operation ? toDooOutcomeResumeInput(props.operation) : undefined,
  ),
  busy = ref(false),
  error = ref(''),
  savedNoteId = ref(props.operation?.noteId || ''),
  operationId = ref(props.operation?.id || ''),
  canReconcile = ref(!!props.operation);
const folders = computed(() => {
  const walk = (items: TreeEntry[]): TreeEntry[] =>
    items.flatMap((n) => (n.type === 'folder' ? [n, ...walk(n.children || [])] : []));
  return walk(props.tree).map((folder) => ({ label: folder.path, value: folder.path }));
});
const dirty = computed(() => JSON.stringify(form) !== baseline || !!submitted.value);
async function save() {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  const payload = submitted.value || {
    requestId,
    occurrenceId: props.occurrence.id,
    expectedRevision: expectedRevision.value,
    title: form.title,
    content: form.content,
    verification: form.verification,
    complete: form.complete,
    criteriaResults: props.task.criteria
      .split('\n')
      .map((label) => label.trim())
      .filter(Boolean)
      .map((label) => ({ label, passed: false })),
    ...(form.folderPath ? { folderPath: form.folderPath } : {}),
  };
  submitted.value = payload;
  try {
    const response = await props.model.request('/api/to-doo/outcome-note', 'POST', payload);
    props.model.acceptSnapshot(response.snapshot, true);
    void props.model.loadPendingOperations();
    savedNoteId.value = response.noteId;
    props.model.state.notice = '成果笔记已创建并关联';
    emit('saved', response.noteId);
  } catch (cause) {
    const e = cause as Error & { status?: number; data?: Record<string, any> };
    error.value = e.message;
    savedNoteId.value = e.data?.noteId || savedNoteId.value;
    operationId.value =
      e.data?.needsReconciliation === false ? '' : e.data?.operationId || operationId.value;
    canReconcile.value = e.status === 409 && typeof e.data?.needsReconciliation === 'boolean';
  } finally {
    busy.value = false;
  }
}
async function reconcile() {
  if (!operationId.value && !canReconcile.value) return;
  try {
    const data = await props.model.request(
      '/api/to-doo/state?kind=occurrence&ids=' +
        encodeURIComponent(props.occurrence.id) +
        '&limit=1',
    );
    props.model.acceptSnapshot(data, true);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
    return;
  }
  const current = props.model.state.snapshot?.occurrences.find((o) => o.id === props.occurrence.id);
  if (!current) {
    error.value = '执行记录暂不可用，请先回到任务核对';
    return;
  }
  if (
    !(await confirm(
      '已重新载入任务状态。使用当前版本继续这次成果操作？标题、正文与目录保持原内容；如果笔记已保存，会继续关联同一篇。',
    ))
  )
    return;
  expectedRevision.value = current.revision;
  submitted.value = {
    ...submitted.value,
    ...(operationId.value ? { operationId: operationId.value } : {}),
    expectedRevision: current.revision,
  };
  await save();
}
defineExpose({ hasUnsavedChanges: () => dirty.value || busy.value });
</script>
<template>
  <AModal
    :open="props.open !== false"
    :footer="null"
    :mask-closable="false"
    :closable="false"
    :keyboard="!busy"
    wrap-class-name="todo-ant-modal"
    title="创建成果笔记"
    @cancel="!busy && emit('close')"
  >
    <AButton
      class="ant-modal-close"
      type="text"
      html-type="button"
      aria-label="收起成果笔记表单并保留输入"
      @click="emit('close')"
      :disabled="busy"
      >×</AButton
    >
    <p class="todo-muted todo-small">
      正文保存在知识库，并作为这次行动的成果证据。收起窗口会保留本次输入。
    </p>

    <form class="todo-form" @submit.prevent="save">
      <fieldset class="todo-create-fields" :disabled="busy || !!submitted">
        <label>笔记标题<AInput v-model:value="form.title" required :maxlength="256" /></label>
        <div class="todo-outcome-directory">
          <label for="to-doo-outcome-directory">保存目录</label>
          <DirectoryTreeSelect
            id="to-doo-outcome-directory"
            v-model:value="form.folderPath"
            :folders="folders"
            label="保存目录"
            root-label="默认目录"
            :disabled="busy || !!submitted"
          />
        </div>
        <label
          >成果正文（Markdown）<ATextarea
            v-model:value="form.content"
            :rows="10"
            required
          ></ATextarea></label
        ><label
          >验证方式<ToDooSelect v-model="form.verification" :disabled="busy || !!submitted">
            <option value="self_assessed">自评</option>
            <option value="practice">练习验证</option>
            <option value="reviewed">经过评审</option>
            <option value="delivered">已交付</option>
          </ToDooSelect></label
        ><ACheckbox
          class="todo-checkbox"
          v-model:checked="form.complete"
          :disabled="busy || !!submitted"
          >同时完成这次行动</ACheckbox
        >
        <p v-if="form.complete" class="todo-muted todo-small">
          父项仍有未完成子项时，请先处理子项，或取消同时完成。
        </p>
      </fieldset>
      <p v-if="error" class="todo-error" role="alert">{{ error }}</p>
      <AButton
        v-if="(operationId || canReconcile) && !savedNoteId"
        html-type="button"
        class="todo-button"
        :disabled="busy"
        @click="reconcile"
      >
        核对当前任务版本后继续
      </AButton>
      <div v-if="savedNoteId" class="todo-import-preview">
        <p>成果笔记已经保存，关联步骤仍需核对。重试会继续原操作，保留同一篇笔记。</p>
        <AButton
          html-type="button"
          class="todo-link"
          @click="emit('open-note', savedNoteId)"
          type="link"
        >
          打开已保存的笔记 ↗</AButton
        ><AButton
          v-if="operationId"
          html-type="button"
          class="todo-button"
          :disabled="busy"
          @click="reconcile"
        >
          核对当前任务版本后继续关联
        </AButton>
      </div>
      <div class="todo-actions">
        <AButton class="todo-button" html-type="button" :disabled="busy" @click="emit('close')">
          收起并保留输入</AButton
        ><AButton
          class="todo-button todo-primary"
          html-type="submit"
          :disabled="busy"
          type="primary"
        >
          {{ busy ? '正在保存…' : submitted ? '重试原操作' : '创建并关联成果笔记' }}
        </AButton>
      </div>
    </form>
  </AModal>
</template>
<style scoped>
.todo-outcome-directory {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
</style>
