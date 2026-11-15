<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  Alert as AAlert,
  Button as AButton,
  Empty as AEmpty,
  Modal as AModal,
} from 'ant-design-vue';
import type { ToDooCommandResult, ToDooSnapshot } from '../../../../shared/to-doo-contracts';
import type { ToDooWorkbench } from '../../to-doo-workbench';
import ToDooDateField from './ToDooDateField.vue';
import ToDooSelect from './ToDooSelect.vue';
const props = defineProps<{ model: ToDooWorkbench; date: string }>();
const emit = defineEmits<{ close: []; create: [date: string]; scheduled: [date: string] }>();
const state = props.model.state;
const date = ref(props.date),
  selected = ref(''),
  error = ref(''),
  loading = ref(false),
  saving = ref(false);
const snapshot = ref<ToDooSnapshot>();
const cursor = ref<string>();
const prepared = ref<ToDooCommandResult['preview']>();
let epoch = 0;
onBeforeUnmount(() => {
  epoch++;
});
const options = computed(() =>
  (snapshot.value?.occurrences || []).flatMap((occurrence) => {
    if (occurrence.deletedAt || !['todo', 'doing', 'blocked'].includes(occurrence.status))
      return [];
    const task = snapshot.value?.tasks.find(
      (task) => task.id === occurrence.taskId && !task.deletedAt && !task.archivedAt,
    );
    if (!task) return [];
    const list = snapshot.value?.lists.find((list) => list.id === task.listId);
    return [
      {
        value: occurrence.id,
        label:
          (occurrence.titleOverride || task.title) +
          (list ? ' · ' + list.name : '') +
          (task.recurrence && occurrence.scheduledDate ? ' · ' + occurrence.scheduledDate : ''),
      },
    ];
  }),
);
const ownPending = computed(() => {
  const pending = state.pendingMutation;
  return pending?.action === 'preview_plan'
    ? pending.payload.changes.length === 1 &&
        pending.payload.changes[0]?.occurrenceId === selected.value
    : pending?.action === 'apply_plan' && pending.payload.plan.id === prepared.value?.id;
});
const blocked = computed(
  () => saving.value || state.busy || (!!state.pendingMutation && !ownPending.value),
);
function mergeRows<T extends { id: string }>(current: T[], next: T[]) {
  return [...new Map([...current, ...next].map((row) => [row.id, row])).values()];
}
async function load(append = false) {
  if (loading.value) return;
  loading.value = true;
  error.value = '';
  const ticket = ++epoch;
  const query = new URLSearchParams({
    view: 'tasks',
    filter: JSON.stringify({
      statuses: ['todo', 'doing', 'blocked'],
      unscheduled: true,
      ...(state.filter.listIds?.length ? { listIds: state.filter.listIds } : {}),
    }),
    limit: '200',
  });
  if (append && cursor.value) query.set('cursor', cursor.value);
  try {
    const data = (await props.model.request('/api/to-doo/state?' + query)) as ToDooSnapshot;
    if (ticket !== epoch) return;
    if (data.datasetId !== state.snapshot?.datasetId)
      throw Error('资料库已变化，请重新打开安排任务');
    if (append && snapshot.value) {
      data.tasks = mergeRows(snapshot.value.tasks, data.tasks);
      data.occurrences = mergeRows(snapshot.value.occurrences, data.occurrences);
      data.lists = mergeRows(snapshot.value.lists, data.lists);
    }
    snapshot.value = data;
    cursor.value = data.page.nextCursor || undefined;
  } catch (cause) {
    if (ticket === epoch)
      error.value = cause instanceof Error ? cause.message : '任务暂时无法读取，请重试';
  } finally {
    if (ticket === epoch) loading.value = false;
  }
}
onMounted(() => {
  void load();
});
function clearPreview() {
  if (prepared.value && state.preview?.id === prepared.value.id) state.preview = null;
  prepared.value = undefined;
}
watch([selected, date], () => {
  if (!state.pendingMutation && !saving.value) {
    clearPreview();
    error.value = '';
  }
});
function close() {
  if (saving.value || state.busy || ownPending.value) return;
  clearPreview();
  emit('close');
}
async function schedule() {
  if (blocked.value || !selected.value || !date.value) return;
  const occurrence = snapshot.value?.occurrences.find((row) => row.id === selected.value);
  const task = snapshot.value?.tasks.find((row) => row.id === occurrence?.taskId);
  if (!task || !occurrence || snapshot.value?.datasetId !== state.snapshot?.datasetId) return;
  saving.value = true;
  error.value = '';
  try {
    let result: ToDooCommandResult | undefined;
    if (ownPending.value) {
      const action = state.pendingMutation!.action;
      result = await props.model.retryPending();
      if (!result) {
        error.value = state.error || '安排结果暂未确认，请重试';
        return;
      }
      if (action === 'apply_plan') {
        clearPreview();
        state.notice = `已安排「${task.title}」到 ${date.value}`;
        emit('scheduled', date.value);
        emit('close');
        return;
      }
      prepared.value = result.preview;
    }
    if (!prepared.value) {
      result = await props.model.execute(
        {
          action: 'preview_plan',
          payload: {
            name: `安排「${task.title.slice(0, 200)}」`,
            includeDependents: false,
            changes: [
              {
                occurrenceId: occurrence.id,
                expectedRevision: occurrence.revision,
                start: {
                  date: date.value,
                  time: null,
                  timeZone: state.snapshot?.settings.timeZone || 'UTC',
                },
                durationMinutes: state.snapshot?.settings.defaultDurationMinutes || 30,
                allDay: false,
                dateEndExclusive: null,
              },
            ],
            reason: '安排选中的待办任务',
          },
        },
        '',
      );
      if (!result?.preview) {
        error.value = state.error || '暂时无法安排，请重试';
        return;
      }
      prepared.value = result.preview;
    }
    if (prepared.value.conflicts.length) {
      error.value = prepared.value.conflicts.join('；');
      clearPreview();
      return;
    }
    result = await props.model.execute(
      { action: 'apply_plan', payload: { plan: prepared.value } },
      `已安排「${task.title}」到 ${date.value}`,
    );
    if (!result) {
      error.value = state.error || '安排结果暂未确认，请重试';
      return;
    }
    clearPreview();
    emit('scheduled', date.value);
    emit('close');
  } finally {
    saving.value = false;
  }
}
</script>
<template>
  <AModal
    :open="true"
    title="安排已有任务"
    :footer="null"
    :mask-closable="false"
    :closable="false"
    wrap-class-name="todo-ant-modal todo-calendar-task-picker"
    @cancel="close"
  >
    <div class="todo-calendar-pick-fields">
      <AAlert v-if="error" type="error" :message="error" show-icon />
      <label
        >安排日期<ToDooDateField
          type="date"
          v-model="date"
          aria-label="安排日期"
          :allow-clear="false"
          :disabled="blocked || !!state.pendingMutation"
      /></label>
      <label v-if="options.length || loading"
        >待安排任务<ToDooSelect
          v-model="selected"
          aria-label="待安排任务"
          placeholder="选择一个待办任务"
          :options="options"
          :disabled="loading || blocked || !!state.pendingMutation"
          :loading="loading"
      /></label>
      <AEmpty v-if="!loading && !options.length && !error" description="没有待安排任务"
        ><AButton @click="emit('create', date)">新建任务</AButton></AEmpty
      >
      <AButton
        v-if="error && !state.pendingMutation"
        type="link"
        :disabled="loading || saving"
        @click="
          selected = '';
          load();
        "
        >重新读取任务</AButton
      >
      <AButton v-if="cursor" type="link" :loading="loading" :disabled="blocked" @click="load(true)"
        >载入更多任务</AButton
      >
      <div class="todo-ant-modal-actions">
        <AButton :disabled="saving || state.busy || ownPending" @click="close">取消</AButton
        ><AButton
          type="primary"
          :disabled="!selected || !date || loading || blocked"
          :loading="saving"
          @click="schedule"
          >{{ ownPending ? '重试安排' : '安排任务' }}</AButton
        >
      </div>
    </div>
  </AModal>
</template>
<style scoped>
.todo-calendar-pick-fields {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.todo-calendar-pick-fields > label {
  display: flex;
  flex-direction: column;
  gap: 7px;
  min-width: 0;
}
</style>
