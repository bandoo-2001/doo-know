<script setup lang="ts">
import {
  Button as AButton,
  Checkbox as ACheckbox,
  Input as AInput,
  Modal as AModal,
  Textarea as ATextarea,
} from 'ant-design-vue';
import ToDooSelect from './ToDooSelect.vue';
import ToDooIcon from './ToDooIcon.vue';
import ToDooDisclosure from './ToDooDisclosure.vue';
import ToDooFormLayout from './ToDooFormLayout.vue';
import ToDooMarkdownPreview from './ToDooMarkdownPreview.vue';
import { computed, onBeforeUnmount, reactive, ref } from 'vue';
import type { TreeEntry } from '../../../../shared/contracts';
import type {
  ToDooOccurrence,
  ToDooTask,
  ToDooEntityMap,
} from '../../../../shared/to-doo-contracts';
import { toDooOutcomeResumeInput, type ToDooWorkbench } from '../../to-doo-workbench';
import DirectoryTreeSelect from '../DirectoryTreeSelect.vue';
import { useToDooConfirm } from '../../to-doo-controls';
import { guardToDooTaskAction } from '../../to-doo-action-guard';
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
const ownerDatasetId = props.model.state.snapshot?.datasetId;
let alive = true;
onBeforeUnmount(() => { alive = false; });
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
const previewing = ref(false);
function captureOwner() {
  const taskId = props.task.id, occurrenceId = props.occurrence.id,
    selectedTaskId = props.model.state.selectedTaskId,
    selectedOccurrenceId = props.model.state.selectedOccurrenceId,
    input = JSON.stringify(form);
  return { taskId, occurrenceId, current: () => alive && props.task.id === taskId &&
    props.occurrence.id === occurrenceId && props.occurrence.taskId === taskId &&
    props.model.state.snapshot?.datasetId === ownerDatasetId &&
    props.model.state.selectedTaskId === selectedTaskId &&
    props.model.state.selectedOccurrenceId === selectedOccurrenceId && JSON.stringify(form) === input };
}
async function guardOwner(owner: ReturnType<typeof captureOwner>, saved?: () => void) {
  if (!owner.current()) return false;
  if (!(await guardToDooTaskAction(props.model, [owner.taskId], confirm, {
    current: owner.current,
    save: async () => {
      const result = await props.model.saveTask();
      if (result && !props.model.dirty()) saved?.();
      return result;
    },
  }))) {
    error.value = props.model.state.error || '任务内容尚未保存，这次成果操作尚未执行。';
    return false;
  }
  return owner.current();
}
async function save() {
  if (busy.value) return;
  const owner = captureOwner();
  if (!owner.current()) return;
  busy.value = true;
  error.value = '';
  try {
    if (!submitted.value) {
      // A retained note can outlive the task selection and the version it opened with.
      let savedRevision: string | undefined, savedCriteria: string | undefined;
      if (!(await props.model.ensureTask(owner.taskId)) || !owner.current() || !(await guardOwner(owner, () => {
        savedRevision = props.model.state.snapshot?.occurrences.find(o => o.id === owner.occurrenceId && o.taskId === owner.taskId)?.revision;
        savedCriteria = props.model.taskDefinitions().find(task => task.id === owner.taskId)?.criteria;
      }))) return;
      const occurrence = props.model.state.snapshot?.occurrences.find(o => o.id === owner.occurrenceId && o.taskId === owner.taskId && !o.deletedAt),
        task = props.model.taskDefinitions().find(task => task.id === owner.taskId && !task.deletedAt);
      if (!occurrence || !task) {
        error.value = '关联任务或执行记录暂不可用，请先回到任务核对。';
        return;
      }
      // An unrelated refresh must still produce a 409 against the version this form opened with.
      // Only the task save explicitly confirmed above may advance that expectation.
      if (savedRevision) expectedRevision.value = savedRevision;
      submitted.value = {
        requestId, occurrenceId: owner.occurrenceId, expectedRevision: expectedRevision.value,
        title: form.title, content: form.content, verification: form.verification, complete: form.complete,
        criteriaResults: (savedCriteria ?? props.task.criteria).split('\n').map(label => label.trim()).filter(Boolean).map(label => ({ label, passed: false })),
        ...(form.folderPath ? { folderPath: form.folderPath } : {}),
      };
    }
    // A retry must reconcile the exact original request, even if task input became dirty later.
    const payload = submitted.value;
    const response = await props.model.request('/api/to-doo/outcome-note', 'POST', payload);
    if (props.model.state.snapshot?.datasetId !== ownerDatasetId || response.snapshot.datasetId !== ownerDatasetId) return;
    props.model.acceptSnapshot(response.snapshot, true);
    void props.model.loadPendingOperations();
    savedNoteId.value = response.noteId;
    props.model.state.notice = '成果笔记已创建并关联';
    if (owner.current()) emit('saved', response.noteId);
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
  if (busy.value || (!operationId.value && !canReconcile.value)) return;
  const owner = captureOwner();
  if (!owner.current()) return;
  let ready = false;
  busy.value = true;
  error.value = '';
  try {
    const data = await props.model.request(
      '/api/to-doo/state?kind=occurrence&ids=' + encodeURIComponent(owner.occurrenceId) + '&limit=1',
    );
    if (!owner.current() || data.datasetId !== ownerDatasetId) return;
    props.model.acceptSnapshot(data, true);
    const current = props.model.state.snapshot?.occurrences.find(o => o.id === owner.occurrenceId && o.taskId === owner.taskId && !o.deletedAt);
    if (!current) {
      error.value = '执行记录暂不可用，请先回到任务核对';
      return;
    }
    if (!(await confirm(
      '已重新载入任务状态。使用当前版本继续这次成果操作？标题、正文与目录保持原内容；如果笔记已保存，会继续关联同一篇。',
    )) || !owner.current() || !(await guardOwner(owner))) return;
    const latest = props.model.state.snapshot?.occurrences.find(o => o.id === owner.occurrenceId && o.taskId === owner.taskId && !o.deletedAt);
    if (!latest) return;
    expectedRevision.value = latest.revision;
    submitted.value = {
      ...submitted.value,
      ...(operationId.value ? { operationId: operationId.value } : {}),
      expectedRevision: latest.revision,
    };
    ready = true;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    busy.value = false;
  }
  if (ready && owner.current()) await save();
}
defineExpose({ hasUnsavedChanges: () => dirty.value || busy.value });
</script>
<template>
  <AModal
    :open="props.open !== false"
    :footer="null"
    :mask-closable="false"
    :closable="false"
    :width="840"
    :keyboard="!busy"
    wrap-class-name="todo-ant-modal todo-outcome-modal"
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
      ><ToDooIcon name="close" :size="16" /></AButton
    >

    <p>
      关联任务：{{ task.title
      }}<template v-if="occurrence.scheduledDate || occurrence.due?.date">
        · {{ occurrence.scheduledDate || occurrence.due?.date }}</template
      >
    </p>
    <p
      v-if="model.state.selectedOccurrenceId && model.state.selectedOccurrenceId !== occurrence.id"
      class="todo-warning"
      role="status"
    >
      当前显示的是已保留的成果草稿。保存后会关联上方任务，请先完成这份草稿。
    </p>

    <ToDooFormLayout :busy="busy" @submit="save">
      <fieldset class="todo-create-fields" :disabled="busy || !!submitted">
        <label>笔记标题<AInput v-model:value="form.title" required :maxlength="256" /></label>
        <div class="todo-between">
          <span>成果正文（Markdown）</span>
          <AButton
            html-type="button"
            type="link"
            :aria-label="previewing ? '继续编辑成果正文' : '预览成果正文'"
            :aria-pressed="previewing"
            :disabled="!form.content.trim() && !previewing"
            @click="previewing = !previewing"
            >{{ previewing ? '继续编辑' : '预览' }}</AButton
          >
        </div>
        <label v-show="!previewing"
          ><ATextarea
            aria-label="成果正文（Markdown）"
            v-model:value="form.content"
            :rows="10"
            required
          ></ATextarea></label
        ><ToDooMarkdownPreview v-if="previewing" :content="form.content" /><ACheckbox
          class="todo-checkbox"
          v-model:checked="form.complete"
          :disabled="busy || !!submitted"
          >同时完成这次行动</ACheckbox
        >
        <p v-if="form.complete" class="todo-form-help">
          父项仍有未完成子项时，请先处理子项，或取消同时完成。
        </p>
        <ToDooDisclosure>
          <template #header>更多保存选项</template>
          <section class="todo-form-section">
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
              >验证方式<ToDooSelect v-model="form.verification" :disabled="busy || !!submitted">
                <option value="self_assessed">自评</option>
                <option value="practice">练习验证</option>
                <option value="reviewed">经过评审</option>
                <option value="delivered">已交付</option>
              </ToDooSelect></label
            >
            <p class="todo-form-help">未调整时，保存到默认目录，验证方式为自评。</p>
          </section>
        </ToDooDisclosure>
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
      <template #actions>
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
      </template>
    </ToDooFormLayout>
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
