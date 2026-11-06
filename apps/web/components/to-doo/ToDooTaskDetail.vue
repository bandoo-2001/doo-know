<script setup lang="ts">
import ToDooDisclosure from './ToDooDisclosure.vue';
import ToDooHint from './ToDooHint.vue';
import { useToDooConfirm } from '../../to-doo-controls';
import ToDooDateField from './ToDooDateField.vue';
import ToDooSelect from './ToDooSelect.vue';

import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue';
import {
  Button as AButton,
  Checkbox as ACheckbox,
  Popover as APopover,
  Input as AInput,
  InputNumber as AInputNumber,
  Select as ASelect,
  Tag as ATag,
  Textarea as ATextarea,
} from 'ant-design-vue';
import type { TreeEntry } from '../../../../shared/contracts';
import type { ToDooDateTime, ToDooEntityKind } from '../../../../shared/to-doo-contracts';
import {
  toDooLocalDate,
  toDooDisplayTime,
  parseToDooQuickEntry,
  toDooStatusLabels,
  toDooPriorityLabels,
  toDooDependencies,
  toDooDeadlineOverdue,
  type ToDooWorkbench,
  type ToDooItem,
} from '../../to-doo-workbench';
import ToDooNotes from './ToDooNotes.vue';
import ToDooReminders from './ToDooReminders.vue';
import ToDooDateExceptions from './ToDooDateExceptions.vue';
import ToDooIcon from './ToDooIcon.vue';
import ToDooTaskMenu from './ToDooTaskMenu.vue';
import { toDooDateLabel, toDooDraftPayload } from '../../to-doo-presentation';
const confirmAction = useToDooConfirm();
const props = defineProps<{
  model: ToDooWorkbench;
  tree: TreeEntry[];
  creating?: boolean;
  creationNotice?: string;
  parentTaskId?: string;
  listId?: string;
  createdNoteId?: string;
}>();
const emit = defineEmits<{
  close: [];
  created: [id: string];
  select: [id: string, occurrence?: string];
  edit: [kind: ToDooEntityKind, entity?: Record<string, any>, seed?: Record<string, any>];
  'open-note': [id: string];
  focus: [occurrenceId?: string];
  child: [id: string];
  'outcome-note': [];
}>();
const state = props.model.state,
  form = computed(() => props.model.draft());
void props.model.ensureListCatalog();
const detailElement = ref<HTMLElement>();
const deadlineSummaryId = 'todo-deadline-summary-' + useId();
const deadlineFields = ref<HTMLElement>();
const editingDue = ref(false);
const attributesOpen = ref(false),
  showDates = ref(false),
  showPriority = ref(false),
  showStatus = ref(false);
const savingTask = ref(false);
const advancedDetails = ref<InstanceType<typeof ToDooDisclosure>>();
const repeatDetails = ref<InstanceType<typeof ToDooDisclosure>>();
const moreOptions = ref<InstanceType<typeof ToDooDisclosure>>();
const linkedResources = ref<InstanceType<typeof ToDooDisclosure>>();
const repeatFields = ref<HTMLElement>();
const reminderFields = ref<HTMLElement>();
const resourceFields = ref<HTMLElement>();
const menuItem = computed<ToDooItem | null>(() =>
  form.value
    ? {
        key: form.value.task.id + '@' + (form.value.occurrence?.id ?? ''),
        task: form.value.task,
        occurrence: form.value.occurrence,
        blocks: form.value.blocks,
        title: form.value.task.title,
        status: form.value.occurrence?.status ?? 'unavailable',
        list: state.snapshot?.lists.find((list) => list.id === form.value?.task.listId),
        date: form.value.occurrence?.due?.date ?? '',
        depth: 0,
      }
    : null,
);
async function showProperty(property: 'dates' | 'priority' | 'status' | 'advanced') {
  attributesOpen.value = false;
  if (property === 'dates') {
    showDates.value = true;
    editingDue.value = true;
  } else if (property === 'priority') showPriority.value = true;
  else if (property === 'status') showStatus.value = true;
  else advancedDetails.value?.expand({ immediate: true });
  await nextTick();
  if (property === 'dates') deadlineFields.value?.querySelector<HTMLInputElement>('input')?.focus();
}
const repeatSummary = computed(() =>
  form.value?.task.parentTaskId && form.value.task.inheritRecurrence
    ? '跟随父任务'
    : form.value?.task.recurrence
      ? {
          daily: '每天',
          weekly: '每周',
          monthly: '每月',
          yearly: '每年',
          after_completion: '完成后重复',
        }[form.value.task.recurrence.frequency]
      : '不重复',
);
async function revealDetail(section: 'repeat' | 'reminders' | 'resources') {
  const taskId = state.selectedTaskId,
    occurrenceId = state.selectedOccurrenceId;
  advancedDetails.value?.expand({ immediate: true });
  await nextTick();
  if (!currentDetail(taskId, occurrenceId)) return;
  const disclosure =
    section === 'repeat' ? repeatDetails : section === 'reminders' ? moreOptions : linkedResources;
  disclosure.value?.expand({ immediate: true });
  await nextTick();
  if (!currentDetail(taskId, occurrenceId)) return;
  const target =
    section === 'repeat' ? repeatFields : section === 'reminders' ? reminderFields : resourceFields;
  target.value
    ?.querySelector?.<HTMLElement>(
      'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex="0"]',
    )
    ?.focus?.({ preventScroll: true });
  target.value?.scrollIntoView?.({ block: 'nearest' });
}
async function openAttributeDetail(section: 'repeat' | 'reminders' | 'resources') {
  attributesOpen.value = false;
  await revealDetail(section);
}
const validationError = ref('');
function validateDetail() {
  const invalid = detailElement.value?.querySelector<HTMLInputElement>(
    'input:invalid, textarea:invalid, [aria-invalid="true"]',
  );
  if (invalid) {
    validationError.value = '请检查日期、时间或其他输入后再保存';
    if (deadlineFields.value?.contains(invalid)) editingDue.value = true;
    void nextTick(() => {
      if (!detailAlive || !invalid.isConnected) return;
      invalid.focus();
      invalid.reportValidity?.();
    });
    return false;
  }
  validationError.value = '';
  return true;
}
async function save() {
  if (state.busy || !validateDetail()) return;
  if (!form.value?.task.title.trim()) {
    validationError.value = '请填写任务标题';
    return;
  }
  const taskId = state.selectedTaskId,
    occurrenceId = state.selectedOccurrenceId;
  savingTask.value = true;
  try {
    const result = await props.model.saveTask(scope.value);
    if (result && currentDetail(taskId, occurrenceId) && !props.model.dirty())
      editingDue.value = false;
    return result;
  } finally {
    savingTask.value = false;
  }
}
async function editDeadline() {
  editingDue.value = !editingDue.value;
  if (editingDue.value) {
    await nextTick();
    if (detailAlive) deadlineFields.value?.querySelector<HTMLInputElement>('input')?.focus();
  }
}
function shortcut(event: KeyboardEvent) {
  if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey) || event.isComposing) return;
  event.preventDefault();
  event.stopPropagation();
  void (props.creating ? create() : save());
}
function changeList(listId: string | null) {
  if (!form.value) return;
  form.value.task.listId = listId;
  form.value.task.sectionId = null;
}
let detailAlive = true;
onBeforeUnmount(() => {
  detailAlive = false;
});
function currentDetail(taskId: string, occurrenceId: string) {
  return (
    detailAlive && state.selectedTaskId === taskId && state.selectedOccurrenceId === occurrenceId
  );
}
const priorityOptions = ['high', 'normal', 'low', 'none'].map((value) => ({
  value,
  label:
    toDooPriorityLabels[value as keyof typeof toDooPriorityLabels] +
    (value === 'none' ? '' : '优先级'),
}));
function priorityPopupContainer(trigger: HTMLElement): HTMLElement {
  return trigger.closest<HTMLElement>('.to-doo-workspace') || trigger.parentElement || trigger;
}
const local = props.model.newTaskDraft(props.parentTaskId, props.listId);
const quick = computed(() =>
  parseToDooQuickEntry(
    local.title,
    toDooLocalDate(new Date(), state.snapshot?.settings.timeZone),
    state.snapshot?.tags.filter((t) => !t.deletedAt) || [],
  ),
);
function adoptQuick() {
  const value = quick.value;
  local.title = value.title;
  if (value.date) {
    if (value.due) {
      local.dueDate = value.date;
      local.dueTime = value.time || '';
    } else {
      local.planDate = value.date;
      local.planTime = value.time || '';
    }
  } else if (value.time) {
    local.planDate = toDooLocalDate(new Date(), zone.value);
    local.planTime = value.time;
  }
  local.tagIds = [...new Set([...local.tagIds, ...value.tagIds])];
  if (value.frequency) {
    local.frequency = value.frequency;
    local.weekdays = value.weekdays;
  }
}
const scope = ref<'all' | 'future'>('all'),
  previewAsset = ref('');
watch(
  () => [state.selectedTaskId, state.selectedOccurrenceId],
  () => {
    scope.value = 'all';
    previewAsset.value = '';
    validationError.value = '';
    editingDue.value = false;
    attributesOpen.value = false;
    showDates.value = showPriority.value = showStatus.value = false;
  },
);
const zone = computed(() => state.snapshot?.settings.timeZone || 'UTC');
const today = computed(() => toDooLocalDate(new Date(), zone.value));
function displaySchedule(value: ToDooDateTime) {
  const shown = toDooDisplayTime(value, zone.value);
  return toDooDateLabel(shown.date, today.value) + (shown.time ? ' ' + shown.time : '');
}
const deadlineSummary = computed(() =>
  form.value?.occurrence?.due ? displaySchedule(form.value.occurrence.due) : '设置截止日期',
);
const deadlineOverdue = computed(() =>
  toDooDeadlineOverdue(
    form.value?.occurrence?.due,
    form.value?.occurrence?.status || 'unavailable',
    today.value,
  ),
);
const currentListName = computed(() =>
  form.value?.task.listId
    ? state.snapshot?.lists.find((list) => list.id === form.value?.task.listId)?.name || '所属清单'
    : '收集箱',
);
const occurrences = computed(
  () =>
    state.snapshot?.occurrences.filter((o) => !o.deletedAt && o.taskId === state.selectedTaskId) ||
    [],
);
const children = computed(
  () =>
    state.snapshot?.tasks.filter((t) => !t.deletedAt && t.parentTaskId === state.selectedTaskId) ||
    [],
);
const outcomes = computed(
  () =>
    state.snapshot?.outcomes.filter(
      (o) => !o.deletedAt && o.occurrenceId === form.value?.occurrence?.id,
    ) || [],
);
const records = computed(
  () =>
    state.snapshot?.records.filter((o) => !o.deletedAt && o.taskId === state.selectedTaskId) || [],
);
const history = computed(
  () =>
    state.snapshot?.activities
      .filter(
        (a) => a.entityId === state.selectedTaskId || a.occurrenceId === form.value?.occurrence?.id,
      )
      .sort((a, b) => b.at.localeCompare(a.at)) || [],
);
const detailCollectionLabels: Record<string, string> = {
  task: '子任务',
  occurrence: '执行实例',
  timeBlock: '时间安排',
  activity: '操作历史',
  record: '推进记录',
  outcome: '成果',
  exception: '例外',
  focusSession: '专注记录',
};
const dependencies = computed({
  get: () => form.value?.task.dependencies.map((d) => d.taskId) || [],
  set: (ids: string[]) => {
    if (form.value)
      form.value.task.dependencies = toDooDependencies(form.value.task.dependencies, ids);
  },
});
function due(value: string, field: 'date' | 'time') {
  if (!form.value?.occurrence) return;
  if (!value && field === 'date') {
    form.value.occurrence.due = null;
    return;
  }
  const current = form.value.occurrence.due || {
    date: toDooLocalDate(new Date(), zone.value),
    time: null,
    timeZone: zone.value,
  };
  form.value.occurrence.due = { ...current, [field]: value || null };
}
function repeat(frequency: string) {
  if (!form.value) return;
  form.value.task.recurrence = frequency
    ? {
        id: crypto.randomUUID(),
        frequency: frequency as any,
        interval: 1,
        anchorDate: form.value.occurrence?.scheduledDate || toDooLocalDate(new Date(), zone.value),
        time: null,
        timeZone: zone.value,
        weekdays: [],
        until: null,
        count: null,
        shortMonth: 'last_day',
        excludedDates: [],
        additionalDates: [],
        endedAt: null,
        completionUnit: 'day',
      }
    : null;
}
function monthly(mode: string) {
  const rule = form.value?.task.recurrence;
  if (!rule) return;
  if (mode === 'weekday') {
    delete rule.monthDay;
    rule.weekOrdinal = 1;
    rule.weekdays = [1];
  } else {
    delete rule.weekOrdinal;
    rule.monthDay = Number(rule.anchorDate.slice(8));
  }
}
function addReminder() {
  form.value?.task.reminders.push({
    id: crypto.randomUUID(),
    anchor: 'due',
    offsetMinutes: -30,
    allDayTime: '09:00',
  });
}
async function create() {
  if (state.busy || !validateDetail()) return;
  if (!local.title.trim()) {
    validationError.value = '请填写任务标题';
    return;
  }
  const result = await props.model.createTask(toDooDraftPayload(local, zone.value));
  if (result) emit('created', state.selectedTaskId);
}
async function status(value: string) {
  if (!form.value?.occurrence) return;
  const taskId = state.selectedTaskId,
    occurrenceId = state.selectedOccurrenceId;
  const targetOccurrence = form.value.occurrence.id;
  const descendants = value === 'done' ? await props.model.statusChildCount(taskId) : 0;
  if (descendants === null || !currentDetail(taskId, occurrenceId)) return;
  let cascade = false;
  if (value === 'done' && descendants) {
    if (
      !(await confirmAction(`这个任务有 ${descendants} 个子任务。是否同时完成其未完成的子任务？`))
    )
      return;
    cascade = true;
  }
  if (!currentDetail(taskId, occurrenceId)) return;
  await props.model.setStatus(targetOccurrence, value as any, cascade);
  if (currentDetail(taskId, occurrenceId) && !props.model.dirty())
    props.model.selectTask(taskId, occurrenceId);
}
function makeOutcome() {
  emit('edit', 'outcome', undefined, {
    occurrenceId: form.value?.occurrence?.id || null,
    listId: form.value?.task.listId || null,
    criteriaResults: (form.value?.task.criteria || '')
      .split('\n')
      .map((s) => s.replace(/^[-*\s\[\]x]+/, '').trim())
      .filter(Boolean)
      .map((label) => ({ label, passed: false })),
  });
}
function assetUrl(hash: string, preview = false) {
  return (
    '/api/to-doo/tasks/' +
    encodeURIComponent(state.selectedTaskId) +
    '/assets/' +
    encodeURIComponent(hash) +
    (preview ? '?preview=true' : '')
  );
}
async function uploadAsset(event: Event) {
  const input = event.target as HTMLInputElement,
    file = input.files?.[0];
  if (!file || !form.value) return;
  if (props.model.dirty()) {
    state.error = '请先保存任务内容，再上传附件';
    input.value = '';
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    state.error = '单个附件不能超过 10 MB';
    input.value = '';
    return;
  }
  const data = new FormData();
  data.set('file', file);
  data.set('requestId', crypto.randomUUID());
  data.set('expectedRevision', form.value.task.revision);
  state.busy = true;
  state.error = '';
  state.notice = '';
  try {
    const result = await props.model.request(
      '/api/to-doo/tasks/' + encodeURIComponent(form.value.task.id) + '/assets',
      'POST',
      data,
    );
    props.model.acceptSnapshot(result.snapshot);
    state.notice = '附件已上传';
  } catch (e) {
    state.error = e instanceof Error ? e.message : String(e);
  } finally {
    state.busy = false;
    input.value = '';
  }
}
async function removeAsset(hash: string) {
  if (!form.value || props.model.dirty()) {
    state.error = '请先保存任务内容，再调整附件关联';
    return;
  }
  state.busy = true;
  state.error = '';
  state.notice = '';
  try {
    const result = await props.model.request(assetUrl(hash), 'DELETE', {
      requestId: crypto.randomUUID(),
      expectedRevision: form.value.task.revision,
    });
    props.model.acceptSnapshot(result.snapshot);
    if (previewAsset.value === hash) previewAsset.value = '';
    state.notice = '附件关联已移除';
  } catch (e) {
    state.error = e instanceof Error ? e.message : String(e);
  } finally {
    state.busy = false;
  }
}
async function discardNew() {
  const parent = props.parentTaskId,
    list = props.listId;
  if (!(await confirmAction('放弃这份尚未提交的新建任务草稿？'))) return;
  if (!detailAlive || !props.creating || props.parentTaskId !== parent || props.listId !== list)
    return;
  props.model.clearNewTaskDraft(parent, list);
  emit('close');
}
function close() {
  emit('close');
}
async function discardConflict() {
  const taskId = state.selectedTaskId,
    occurrenceId = state.selectedOccurrenceId;
  if (!(await confirmAction('放弃这份本地输入，改用服务端当前内容？'))) return;
  if (!currentDetail(taskId, occurrenceId)) return;
  await props.model.ensureTask(taskId);
  if (!currentDetail(taskId, occurrenceId)) return;
  props.model.discardDraft();
  state.conflict = false;
  state.error = '';
}
async function remove() {
  if (!form.value) return;
  const target = { ...form.value.task };
  const taskId = state.selectedTaskId,
    occurrenceId = state.selectedOccurrenceId;
  if (!(await confirmAction('将任务及其子任务移入回收站？', { danger: true }))) return;
  if (!currentDetail(taskId, occurrenceId)) return;
  const r = await props.model.removeEntity('task', target, false, true);
  if (r && detailAlive && (!state.selectedTaskId || state.selectedTaskId === taskId)) emit('close');
}
defineExpose({
  hasUnsavedChanges: () =>
    (props.creating ? !!local.title || !!local.description : props.model.dirty()) ||
    !!detailElement.value?.querySelector('[aria-invalid="true"]'),
});
</script>
<template>
  <aside
    ref="detailElement"
    class="todo-detail"
    :class="{ 'todo-document-detail': !creating }"
    aria-label="任务详情"
    @keydown="shortcut"
  >
    <header class="todo-between">
      <span class="todo-muted">{{ creating ? '新建任务' : '任务详情' }}</span
      ><span
        v-if="!creating"
        class="todo-small"
        :class="model.dirty() ? 'todo-warning' : 'todo-muted'"
        >{{ savingTask ? '保存中…' : model.dirty() ? '未保存的更改' : '已保存' }}</span
      ><AButton
        html-type="button"
        class="todo-icon-button"
        aria-label="关闭任务详情"
        @click="close"
        type="text"
      >
        ×
      </AButton>
    </header>
    <p v-if="validationError" class="todo-detail-validation todo-danger" role="alert">
      {{ validationError }}
    </p>
    <p v-if="creating && creationNotice" class="todo-detail-save-help todo-warning" role="status">
      {{ creationNotice }}
    </p>
    <ToDooHint
      :model="model"
      :hint-id="creating ? 'task-create-save' : 'task-edit-save'"
      class="todo-detail-save-help"
    >
      {{
        creating
          ? '点击“创建任务”后生效。关闭会保留新建草稿，保存范围为当前浏览器。'
          : '标题、日期、优先级、重复和提醒需点击“保存任务”；完成、执行状态和菜单操作立即生效。关闭保留当前页面输入，刷新前请保存。'
      }}
    </ToDooHint>
    <form v-if="creating" class="todo-form todo-detail-body" @submit.prevent="create">
      <fieldset class="todo-create-fields" :disabled="state.busy">
        <label
          >任务标题<AInput
            v-model:value="local.title"
            required
            :maxlength="256"
            autofocus
            placeholder="例如：明天 下午3点 写方案"
        /></label>
        <div v-if="quick.recognized" class="todo-quick-preview">
          <p>
            识别到 {{ quick.date || '' }} {{ quick.time || '' }}
            {{
              quick.frequency === 'daily'
                ? '每天重复'
                : quick.frequency === 'weekly'
                  ? '每周重复'
                  : ''
            }}{{ quick.tagIds.length ? ' · ' + quick.tagIds.length + ' 个标签' : '' }}
          </p>
          <AButton html-type="button" class="todo-link" @click="adoptQuick" type="link"
            >采用识别结果</AButton
          ><small>采用后仍可调整日期和时间。</small>
        </div>
        <label>任务说明<ATextarea v-model:value="local.description" :rows="3"></ATextarea></label
        ><label
          >目标或清单<ToDooSelect
            v-model="local.listId"
            :disabled="!!parentTaskId"
            @change="local.sectionId = null"
          >
            <option :value="null">收集箱</option>
            <option v-for="l in model.taskLists()" :key="l.id" :value="l.id">
              {{ l.name }}
            </option>
          </ToDooSelect></label
        >
        <div class="todo-form-grid">
          <label
            >优先级<ToDooSelect v-model="local.priority" aria-label="优先级"
              ><option v-for="(label, value) in toDooPriorityLabels" :key="value" :value="value">
                {{ label }}{{ value === 'none' ? '' : '优先级' }}
              </option></ToDooSelect
            ></label
          >
          <label
            >初始状态<ToDooSelect v-model="local.initialStatus" aria-label="初始状态"
              ><option v-for="(label, value) in toDooStatusLabels" :key="value" :value="value">
                {{ label }}
              </option></ToDooSelect
            ></label
          >
        </div>
        <label>计划日期<ToDooDateField v-model="local.planDate" type="date" /></label>
        <small class="todo-muted"
          >{{
            local.planDate
              ? local.planTime
                ? '按指定时刻安排'
                : '仅设置日期，不指定开始时刻'
              : '尚未安排日期'
          }}
          · 默认安排时长
          {{ state.snapshot?.settings.defaultDurationMinutes || 30 }}
          分钟（可用预计分钟调整）</small
        >
        <label
          v-if="
            local.listId &&
            state.snapshot?.sections.some(
              (section) => !section.deletedAt && section.listId === local.listId,
            )
          "
          >分组<ToDooSelect v-model="local.sectionId" aria-label="分组"
            ><option :value="null">{{ parentTaskId ? '跟随父任务分组' : '未分组' }}</option>
            <option
              v-for="section in state.snapshot?.sections.filter(
                (section) => !section.deletedAt && section.listId === local.listId,
              )"
              :key="section.id"
              :value="section.id"
            >
              {{ section.name }}
            </option></ToDooSelect
          ></label
        >
        <ToDooDisclosure class="todo-disclosure" :open="!!local.dueDate || !!local.criteria">
          <template #header><span>更多选项</span></template>
          <div class="todo-disclosure-content todo-form">
            <div class="todo-form-grid">
              <label>计划时间<ToDooDateField v-model="local.planTime" type="time" /></label>
              <label>截止日期<ToDooDateField v-model="local.dueDate" type="date" /></label>
              <label>截止时间<ToDooDateField v-model="local.dueTime" type="time" /></label>
              <label
                >预计分钟<AInputNumber
                  aria-label="预计分钟"
                  v-model:value="local.estimate"
                  :min="0"
              /></label>
            </div>
            <label
              >重复<ToDooSelect v-model="local.frequency" aria-label="重复"
                ><option :value="null">不重复</option>
                <option value="daily">每天</option>
                <option value="weekly">每周</option></ToDooSelect
              ></label
            >
            <div v-if="local.frequency === 'weekly'" class="todo-actions" aria-label="重复星期">
              <label v-for="(day, index) in ['日', '一', '二', '三', '四', '五', '六']" :key="index"
                ><ACheckbox
                  :checked="local.weekdays.includes(index)"
                  @change="
                    local.weekdays = local.weekdays.includes(index)
                      ? local.weekdays.filter((value) => value !== index)
                      : [...local.weekdays, index]
                  "
                />周{{ day }}</label
              >
            </div>
            <ToDooReminders v-model="local.reminders" :date-based="false" />
            <label>完成标准<ATextarea v-model:value="local.criteria" :rows="3"></ATextarea></label>
            <ToDooHint :model="model" hint-id="task-create-resources">
              创建任务后，可以在详情中上传附件、关联资料和记录成果。
            </ToDooHint>
          </div>
        </ToDooDisclosure>
        <AButton
          class="todo-button todo-primary"
          html-type="submit"
          :disabled="state.busy"
          type="primary"
        >
          {{ state.busy ? '创建中…' : '创建任务' }}</AButton
        ><AButton
          html-type="button"
          class="todo-link todo-danger"
          :disabled="state.busy"
          @click="discardNew"
          type="link"
          danger
        >
          放弃这份新建草稿
        </AButton>
      </fieldset>
    </form>
    <div v-else-if="form" class="todo-detail-body todo-form">
      <fieldset class="todo-create-fields todo-document-fields" :disabled="state.busy">
        <div class="todo-document-title-row">
          <AButton
            html-type="button"
            type="text"
            class="todo-detail-complete"
            :class="{ 'is-complete': form.occurrence?.status === 'done' }"
            :aria-label="form.occurrence?.status === 'done' ? '重新打开' : '标记完成'"
            :aria-pressed="form.occurrence?.status === 'done'"
            :disabled="state.busy || !form.occurrence"
            @click="status(form.occurrence?.status === 'done' ? 'todo' : 'done')"
          >
            <span aria-hidden="true">{{ form.occurrence?.status === 'done' ? '✓' : '' }}</span
            ><span class="todo-accessible-label">{{
              form.occurrence?.status === 'done' ? '重新打开' : '标记完成'
            }}</span>
          </AButton>
          <label class="todo-title-input"
            ><span class="todo-accessible-label">任务标题</span
            ><ATextarea
              aria-label="任务标题"
              v-model:value="form.task.title"
              :maxlength="256"
              :auto-size="{ minRows: 1, maxRows: 5 }"
              :rows="1"
              @keydown.enter="
                !$event.isComposing && !$event.ctrlKey && !$event.metaKey && $event.preventDefault()
              "
          /></label>
        </div>
        <div class="todo-document-meta">
          <label v-if="showStatus || form.occurrence?.status !== 'todo'"
            ><span class="todo-accessible-label">状态</span
            ><ToDooSelect
              aria-label="状态"
              :value="form.occurrence?.status || 'unavailable'"
              :disabled="state.busy || !form.occurrence"
              @change="status($event)"
            >
              <option v-if="!form.occurrence" value="unavailable">执行记录尚未载入</option>
              <option v-for="(label, key) in toDooStatusLabels" :key="key" :value="key">
                {{ label }}
              </option>
            </ToDooSelect></label
          >
          <label
            ><span class="todo-accessible-label">所属目标或清单</span
            ><ToDooSelect
              aria-label="所属目标或清单"
              :value="form.task.listId"
              @change="changeList"
              :disabled="!!form.task.parentTaskId"
              ><option :value="null">收集箱</option>
              <option v-for="l in model.taskLists()" :key="l.id" :value="l.id">
                {{ l.name }}
              </option></ToDooSelect
            ></label
          >
        </div>
        <label v-if="form.task.recurrence || occurrences.length > 1"
          >执行实例<ToDooSelect
            :value="state.selectedOccurrenceId"
            @change="emit('select', form.task.id, $event)"
            ><option v-for="o in occurrences" :key="o.id" :value="o.id">
              {{ o.scheduledDate || o.due?.date || '普通任务' }} · {{ toDooStatusLabels[o.status] }}
            </option></ToDooSelect
          ></label
        >
        <AButton
          v-if="!form.occurrence"
          html-type="button"
          class="todo-button"
          :disabled="state.busy"
          @click="
            model
              .execute({
                action: 'materialize_occurrences',
                payload: {
                  taskId: form.task.id,
                  from: toDooLocalDate(new Date(), zone),
                  to: toDooLocalDate(new Date(), zone),
                },
              })
              .then(() => model.selectTask(form!.task.id))
          "
          type="default"
          >生成本次执行记录</AButton
        >
        <label class="todo-document-description"
          ><span class="todo-accessible-label">任务说明</span
          ><ATextarea
            aria-label="任务说明"
            v-model:value="form.task.description"
            :auto-size="{ minRows: 1, maxRows: 12 }"
            :rows="1"
            placeholder="添加说明，或记下下一步…"
        /></label>
        <ToDooDisclosure class="todo-disclosure todo-primary-children" :open="!!children.length">
          <template #header
            ><span>子任务</span
            ><small v-if="children.length" class="todo-muted">{{
              children.length
            }}</small></template
          >
          <div class="todo-disclosure-content">
            <AButton
              v-for="t in children"
              :key="t.id"
              class="todo-saved-row todo-text-button"
              html-type="button"
              @click="emit('select', t.id)"
              type="text"
            >
              {{ t.title }} <span>↗</span></AButton
            ><AButton
              html-type="button"
              class="todo-link"
              @click="emit('child', form.task.id)"
              type="link"
            >
              ＋ 添加子任务
            </AButton>
          </div>
        </ToDooDisclosure>
        <section
          v-if="form.task.noteRefs.length"
          class="todo-primary-resources"
          aria-label="任务资料"
        >
          <h3>资料</h3>
          <AButton
            v-for="note in form.task.noteRefs"
            :key="note.noteId + ':' + note.role"
            type="link"
            class="todo-link"
            @click="emit('open-note', note.noteId)"
            >{{ note.title || '关联资料' }} ↗</AButton
          >
        </section>
        <div
          v-if="
            form.blocks.length ||
            form.occurrence?.due ||
            form.task.priority !== 'none' ||
            showDates ||
            editingDue ||
            showPriority
          "
          class="todo-document-properties"
          role="group"
          aria-label="任务时间摘要"
        >
          <div v-if="form.blocks.length || showDates" class="todo-document-property">
            <span class="todo-document-property-name"
              ><ToDooIcon name="calendar" :size="15" />计划</span
            >
            <div class="todo-document-plan-items">
              <AButton
                v-for="block in form.blocks"
                :key="block.id"
                html-type="button"
                type="text"
                class="todo-property-action"
                :aria-label="'调整时间安排：' + displaySchedule(block.start)"
                @click="emit('edit', 'timeBlock', block)"
              >
                <span
                  >{{ displaySchedule(block.start)
                  }}<small v-if="!block.allDay"> · {{ block.durationMinutes }} 分钟</small
                  ><small v-else> · 全天</small></span
                >
              </AButton>
              <AButton
                html-type="button"
                type="text"
                class="todo-property-action is-empty"
                :aria-label="form.blocks.length ? '添加时间安排' : '设置计划时间'"
                @click="
                  emit('edit', 'timeBlock', undefined, {
                    occurrenceId: form.occurrence?.id || null,
                    title: form.task.title,
                  })
                "
                >{{ form.blocks.length ? '＋ 添加一段时间' : '设置计划时间' }}</AButton
              >
            </div>
          </div>
          <div
            v-if="form.occurrence?.due || showDates || editingDue"
            class="todo-document-property"
          >
            <span class="todo-document-property-name"
              ><ToDooIcon name="today" :size="15" />截止</span
            >
            <AButton
              html-type="button"
              type="text"
              class="todo-property-action"
              :class="{ 'is-empty': !form.occurrence?.due, 'is-overdue': deadlineOverdue }"
              aria-label="编辑截止日期"
              :aria-describedby="deadlineSummaryId"
              :aria-expanded="editingDue"
              :disabled="state.busy || !form.occurrence"
              @click="editDeadline"
              ><span :id="deadlineSummaryId">{{ deadlineSummary }}</span></AButton
            >
          </div>
          <div v-show="editingDue" ref="deadlineFields" class="todo-date-editor">
            <div class="todo-form-grid">
              <label
                >截止日期<ToDooDateField
                  type="date"
                  aria-label="截止日期"
                  :value="form.occurrence?.due?.date || ''"
                  @input="due($event, 'date')"
              /></label>
              <label
                >截止时间<ToDooDateField
                  type="time"
                  aria-label="截止时间"
                  :value="form.occurrence?.due?.time || ''"
                  @input="due($event, 'time')"
              /></label>
            </div>
            <small
              v-if="form.occurrence?.due && form.occurrence.due.timeZone !== zone"
              class="todo-muted"
              >按 {{ form.occurrence.due.timeZone }} 填写</small
            >
            <AButton html-type="button" type="text" class="todo-link" @click="editingDue = false"
              >收起日期编辑</AButton
            >
          </div>
          <div v-if="form.task.priority !== 'none' || showPriority" class="todo-document-property">
            <span class="todo-document-property-name">优先级</span>
            <ASelect
              v-model:value="form.task.priority"
              class="todo-priority-select todo-document-priority"
              :class="'todo-priority-' + form.task.priority"
              aria-label="优先级"
              :options="priorityOptions"
              :disabled="state.busy"
              :get-popup-container="priorityPopupContainer"
              dropdown-class-name="todo-priority-popup"
              ><template #option="{ value, label }"
                ><ATag class="todo-priority-label" :class="'todo-priority-' + value">{{
                  label
                }}</ATag></template
              ></ASelect
            >
          </div>
        </div>
        <div
          v-if="
            form.task.recurrence ||
            (form.task.parentTaskId && form.task.inheritRecurrence) ||
            form.task.reminders.length ||
            form.task.noteRefs.length
          "
          class="todo-detail-shortcuts"
          role="group"
          aria-label="任务快捷设置"
        >
          <AButton
            v-if="form.task.recurrence || (form.task.parentTaskId && form.task.inheritRecurrence)"
            html-type="button"
            type="text"
            aria-label="编辑重复规则"
            @click="revealDetail('repeat')"
            ><span>重复</span><small>{{ repeatSummary }}</small></AButton
          >
          <AButton
            v-if="form.task.reminders.length"
            html-type="button"
            type="text"
            aria-label="编辑任务提醒"
            @click="revealDetail('reminders')"
            ><span>提醒</span
            ><small>{{
              form.task.reminders.length ? form.task.reminders.length + ' 条提醒' : '未设置'
            }}</small></AButton
          >
          <AButton
            v-if="form.task.noteRefs.length"
            html-type="button"
            type="text"
            aria-label="编辑关联资料"
            @click="revealDetail('resources')"
            ><span>资料</span
            ><small>{{
              form.task.noteRefs.length ? form.task.noteRefs.length + ' 份资料' : '未关联'
            }}</small></AButton
          >
        </div>
        <APopover
          v-model:open="attributesOpen"
          trigger="click"
          placement="bottomLeft"
          overlay-class-name="todo-task-menu-popup todo-ant-popup"
        >
          <template #content
            ><div class="todo-property-menu">
              <AButton type="text" @click="showProperty('dates')">设置日期</AButton>
              <AButton type="text" @click="showProperty('priority')">设置优先级</AButton>
              <AButton type="text" @click="showProperty('status')">设置状态</AButton>
              <AButton type="text" aria-label="编辑重复规则" @click="openAttributeDetail('repeat')"
                >重复规则</AButton
              >
              <AButton
                type="text"
                aria-label="编辑任务提醒"
                @click="openAttributeDetail('reminders')"
                >提醒</AButton
              >
              <AButton
                type="text"
                aria-label="编辑关联资料"
                @click="openAttributeDetail('resources')"
                >关联资料</AButton
              >
              <AButton
                type="text"
                @click="
                  attributesOpen = false;
                  emit('child', form.task.id);
                "
                >添加子任务</AButton
              >
              <AButton type="text" @click="showProperty('advanced')">附件、标准与更多设置</AButton>
            </div></template
          >
          <AButton type="text" class="todo-link todo-add-property" aria-label="添加属性"
            ><ToDooIcon name="plus" :size="14" />添加属性</AButton
          >
        </APopover>
        <ToDooDisclosure
          ref="advancedDetails"
          class="todo-disclosure todo-detail-advanced"
          :open="!!createdNoteId"
        >
          <template #header
            ><span>更多详情</span><small class="todo-muted">重复、提醒、资料与记录</small></template
          >
          <div class="todo-detail-options">
            <ToDooDisclosure class="todo-disclosure todo-classification">
              <template #header
                ><span>四象限归类</span
                ><small class="todo-muted"
                  >{{ form.task.importance === 'important' ? '重要' : '普通' }} ·
                  {{
                    form.task.urgentOverride === null
                      ? '自动判断紧急程度'
                      : form.task.urgentOverride
                        ? '紧急'
                        : '不紧急'
                  }}</small
                ></template
              >
              <div class="todo-disclosure-content">
                <div class="todo-form-grid">
                  <label
                    >重要程度<ToDooSelect v-model="form.task.importance" aria-label="重要程度">
                      <option value="normal">普通</option>
                      <option value="important">重要</option>
                    </ToDooSelect></label
                  >
                  <label
                    >紧急程度<ToDooSelect v-model="form.task.urgentOverride" aria-label="紧急程度">
                      <option :value="null">根据截止时间判断</option>
                      <option :value="true">设为紧急</option>
                      <option :value="false">设为不紧急</option>
                    </ToDooSelect></label
                  >
                </div>
                <small class="todo-muted">重要和紧急程度决定象限，优先级决定执行顺序。</small>
              </div>
            </ToDooDisclosure>
            <ToDooDisclosure ref="repeatDetails" class="todo-disclosure">
              <template #header
                ><span>重复规则</span
                ><small class="todo-muted">{{ repeatSummary }}</small></template
              >
              <div ref="repeatFields" class="todo-disclosure-content todo-form">
                <label v-if="form.task.parentTaskId" class="todo-checkbox"
                  ><ACheckbox
                    v-model:checked="form.task.inheritRecurrence"
                  />跟随父任务的重复周期</label
                >
                <label
                  >重复<ToDooSelect
                    :value="form.task.recurrence?.frequency || ''"
                    @change="repeat($event)"
                  >
                    <option value="">不重复</option>
                    <option value="daily">每天</option>
                    <option value="weekly">每周</option>
                    <option value="monthly">每月</option>
                    <option value="yearly">每年</option>
                    <option value="after_completion">完成后重复</option>
                  </ToDooSelect></label
                ><template v-if="form.task.recurrence"
                  ><div class="todo-form-grid">
                    <label
                      >间隔<AInputNumber
                        aria-label="间隔"
                        v-model:value="form.task.recurrence.interval"
                        :min="1" /></label
                    ><label
                      >开始日期<ToDooDateField
                        v-model="form.task.recurrence.anchorDate"
                        type="date" /></label
                    ><label
                      >重复时间<ToDooDateField
                        v-model="form.task.recurrence.time"
                        type="time" /></label
                    ><label>时区<AInput v-model:value="form.task.recurrence.timeZone" /></label
                    ><label
                      >结束日期<ToDooDateField
                        v-model="form.task.recurrence.until"
                        type="date" /></label
                    ><label
                      >最多次数<AInputNumber
                        aria-label="最多次数"
                        :value="form.task.recurrence.count ?? undefined"
                        @update:value="
                          form.task.recurrence.count = $event == null ? null : Number($event)
                        "
                        :min="1"
                    /></label>
                  </div>
                  <label v-if="form.task.recurrence.frequency === 'weekly'"
                    >每周日期<ToDooSelect v-model="form.task.recurrence.weekdays" multiple>
                      <option
                        v-for="(day, i) in ['日', '一', '二', '三', '四', '五', '六']"
                        :key="i"
                        :value="i"
                      >
                        星期{{ day }}
                      </option>
                    </ToDooSelect></label
                  >
                  <div v-if="form.task.recurrence.frequency === 'monthly'" class="todo-form">
                    <label
                      >每月方式<ToDooSelect
                        :value="form.task.recurrence.weekOrdinal ? 'weekday' : 'date'"
                        @change="monthly($event)"
                      >
                        <option value="date">固定日期</option>
                        <option value="weekday">第几个星期</option>
                      </ToDooSelect></label
                    ><label v-if="!form.task.recurrence.weekOrdinal"
                      >每月日期<AInputNumber
                        aria-label="每月日期"
                        v-model:value="form.task.recurrence.monthDay"
                        :min="1"
                        :max="31"
                    /></label>
                    <div v-else class="todo-form-grid">
                      <label
                        >第几个<ToDooSelect v-model.number="form.task.recurrence.weekOrdinal">
                          <option v-for="n in [1, 2, 3, 4, 5, -1]" :key="n" :value="n">
                            {{ n === -1 ? '最后一个' : '第 ' + n + ' 个' }}
                          </option>
                        </ToDooSelect></label
                      ><label
                        >星期<ToDooSelect
                          :value="form.task.recurrence.weekdays[0] ?? 1"
                          @change="form.task.recurrence.weekdays = [Number($event)]"
                        >
                          <option
                            v-for="(d, i) in ['日', '一', '二', '三', '四', '五', '六']"
                            :key="i"
                            :value="i"
                          >
                            星期{{ d }}
                          </option>
                        </ToDooSelect></label
                      >
                    </div>
                  </div>
                  <label v-if="form.task.recurrence.frequency === 'after_completion'"
                    >完成后间隔单位<ToDooSelect v-model="form.task.recurrence.completionUnit">
                      <option value="day">天</option>
                      <option value="week">周</option>
                      <option value="month">月</option>
                    </ToDooSelect></label
                  ><label
                    >短月处理<ToDooSelect v-model="form.task.recurrence.shortMonth">
                      <option value="last_day">使用月末</option>
                      <option value="skip">跳过当月</option>
                    </ToDooSelect></label
                  ><ToDooDateExceptions
                    v-model="form.task.recurrence.excludedDates"
                    label="排除这些日期"
                  /><ToDooDateExceptions
                    v-model="form.task.recurrence.additionalDates"
                    label="额外安排这些日期"
                  /><label
                    >修改范围<ToDooSelect v-model="scope">
                      <option value="all">整个系列（保留完成历史）</option>
                      <option value="future">本次及以后</option>
                    </ToDooSelect></label
                  ></template
                >
              </div>
            </ToDooDisclosure>
            <ToDooDisclosure ref="linkedResources" class="todo-disclosure">
              <template #header
                ><span>关联资料</span
                ><small v-if="form.task.noteRefs.length" class="todo-muted">{{
                  form.task.noteRefs.length
                }}</small></template
              >
              <div ref="resourceFields" class="todo-disclosure-content">
                <ToDooNotes
                  v-model="form.task.noteRefs"
                  :tree="tree"
                  @open-note="emit('open-note', $event)"
                />
              </div>
            </ToDooDisclosure>
            <ToDooDisclosure class="todo-disclosure">
              <template #header
                ><span>任务附件</span
                ><small v-if="form.task.attachments.length" class="todo-muted">{{
                  form.task.attachments.length
                }}</small></template
              >
              <div class="todo-disclosure-content todo-form">
                <p class="todo-muted todo-small">支持图片、PDF 和纯文本，每个文件最多 10 MB。</p>
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain,text/markdown,text/csv,.md,.txt,.csv"
                  aria-label="上传任务附件"
                  :disabled="state.busy || model.dirty()"
                  @change="uploadAsset"
                />
                <p v-if="model.dirty()" class="todo-muted todo-small">
                  先保存当前更改，再上传或移除附件。
                </p>
                <div
                  v-for="asset in form.task.attachments"
                  :key="asset.hash"
                  class="todo-attachment"
                >
                  <div class="todo-between">
                    <span
                      >{{ asset.name
                      }}<small class="todo-muted"
                        >{{ (asset.size / 1024).toFixed(1) }} KB</small
                      ></span
                    >
                    <div class="todo-actions">
                      <a class="todo-link" :href="assetUrl(asset.hash)" :download="asset.name"
                        >下载</a
                      ><AButton
                        v-if="
                          ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(
                            asset.mime,
                          )
                        "
                        html-type="button"
                        class="todo-link"
                        @click="previewAsset = previewAsset === asset.hash ? '' : asset.hash"
                        type="link"
                      >
                        {{ previewAsset === asset.hash ? '收起预览' : '预览' }}</AButton
                      ><AButton
                        html-type="button"
                        class="todo-link todo-danger"
                        :disabled="state.busy || model.dirty()"
                        @click="removeAsset(asset.hash)"
                        type="link"
                        danger
                      >
                        移除关联
                      </AButton>
                    </div>
                  </div>
                  <img
                    v-if="previewAsset === asset.hash"
                    :src="assetUrl(asset.hash, true)"
                    :alt="asset.name + '，任务附件预览'"
                    loading="lazy"
                  />
                </div>
                <p v-if="!form.task.attachments.length" class="todo-muted todo-small">
                  还没有上传附件
                </p>
              </div>
            </ToDooDisclosure>
            <ToDooDisclosure class="todo-disclosure" :open="!!createdNoteId">
              <template #header
                ><span>完成标准与成果</span
                ><small v-if="outcomes.length" class="todo-muted">{{
                  outcomes.length
                }}</small></template
              >
              <div class="todo-disclosure-content todo-form">
                <label
                  >完成标准<ATextarea
                    v-model:value="form.task.criteria"
                    :rows="4"
                    placeholder="每行一条，普通任务也可以留空"
                  ></ATextarea>
                </label>
                <div v-for="o in outcomes" :key="o.id" class="todo-saved-row">
                  <span
                    >{{ o.summary
                    }}<small>{{
                      {
                        self_assessed: '自评',
                        practice: '练习验证',
                        reviewed: '经过评审',
                        delivered: '已交付',
                      }[o.verification]
                    }}</small></span
                  ><AButton
                    html-type="button"
                    class="todo-link"
                    @click="emit('edit', 'outcome', o)"
                    type="link"
                  >
                    编辑
                  </AButton>
                </div>
                <AButton class="todo-link" html-type="button" @click="makeOutcome" type="link"
                  >＋ 记录成果与证据</AButton
                >
                <AButton
                  html-type="button"
                  class="todo-button"
                  :disabled="state.busy || model.dirty() || !form.occurrence"
                  @click="emit('outcome-note')"
                  type="default"
                >
                  创建成果笔记并关联
                </AButton>
                <AButton
                  v-if="createdNoteId"
                  html-type="button"
                  class="todo-link"
                  aria-label="打开成果笔记"
                  @click="emit('open-note', createdNoteId)"
                  type="link"
                >
                  打开成果笔记 ↗
                </AButton>
              </div>
            </ToDooDisclosure>
            <ToDooDisclosure ref="moreOptions" class="todo-disclosure">
              <template #header><span>更多选项：标签、提醒、依赖与来源</span></template>
              <div class="todo-disclosure-content todo-form">
                <label v-if="form.occurrence?.due"
                  >截止时区<AInput v-model:value="form.occurrence.due.timeZone"
                /></label>
                <div class="todo-form-grid">
                  <label
                    >分组<ToDooSelect v-model="form.task.sectionId">
                      <option :value="null">
                        {{ form.task.parentTaskId ? '跟随父任务分组' : '未分组' }}
                      </option>
                      <option
                        v-for="s in state.snapshot?.sections.filter(
                          (s) => !s.deletedAt && s.listId === form!.task.listId,
                        )"
                        :key="s.id"
                        :value="s.id"
                      >
                        {{ s.name }}
                      </option>
                    </ToDooSelect></label
                  >
                  <label
                    >预计分钟<AInputNumber
                      aria-label="预计分钟"
                      :value="form.task.estimateMinutes ?? undefined"
                      @update:value="
                        form.task.estimateMinutes = $event == null ? null : Number($event)
                      "
                      :min="0"
                  /></label>
                </div>
                <label
                  >标签<ToDooSelect v-model="form.task.tagIds" multiple>
                    <option
                      v-for="tag in state.snapshot?.tags.filter((t) => !t.deletedAt)"
                      :key="tag.id"
                      :value="tag.id"
                    >
                      {{ tag.name }}
                    </option>
                  </ToDooSelect></label
                ><AButton
                  class="todo-link"
                  html-type="button"
                  @click="emit('edit', 'tag')"
                  type="link"
                >
                  ＋ 新建标签
                </AButton>
                <label
                  >前置任务<ToDooSelect v-model="dependencies" multiple>
                    <option
                      v-for="t in state.snapshot?.tasks.filter(
                        (t) => !t.deletedAt && t.id !== form!.task.id,
                      )"
                      :key="t.id"
                      :value="t.id"
                    >
                      {{ t.title }}
                    </option>
                  </ToDooSelect></label
                ><label v-for="dependency in form.task.dependencies" :key="dependency.taskId"
                  >{{
                    state.snapshot?.tasks.find((t) => t.id === dependency.taskId)?.title ||
                    dependency.taskId
                  }}
                  完成后等待（分钟）<AInputNumber
                    :aria-label="
                      String(
                        state.snapshot?.tasks.find((t) => t.id === dependency.taskId)?.title ||
                          dependency.taskId,
                      ) + ' 完成后等待（分钟）'
                    "
                    v-model:value="dependency.lagMinutes"
                    :min="0"
                    :max="525600"
                    :step="1" /></label
                ><label v-if="form.occurrence"
                  >受阻原因<ATextarea
                    v-model:value="form.occurrence.blockedReason"
                    :rows="2"
                  ></ATextarea
                ></label>
                <div ref="reminderFields">
                  <ToDooReminders v-model="form.task.reminders" :date-based="false" />
                </div>
                <label
                  >来源资料<ToDooSelect
                    :value="form.task.source?.noteId || ''"
                    @change="
                      form.task.source = $event
                        ? {
                            noteId: $event,
                            quote: form.task.source?.quote || '',
                            contentHash: null,
                            draft: false,
                          }
                        : null
                    "
                  >
                    <option value="">不关联来源</option>
                    <option v-for="n in form.task.noteRefs" :key="n.noteId" :value="n.noteId">
                      {{ n.title || n.noteId }}
                    </option>
                  </ToDooSelect></label
                ><label
                  >来源引用<ATextarea
                    :value="form.task.source?.quote || ''"
                    :rows="2"
                    :disabled="!form.task.source"
                    placeholder="先关联一份来源资料，可在这里保存原文引用"
                    @input="
                      form.task.source &&
                      (form.task.source = {
                        noteId: form.task.source.noteId,
                        quote: ($event.target as HTMLTextAreaElement).value,
                        contentHash: null,
                        draft: false,
                      })
                    "
                  ></ATextarea></label
                ><label v-if="form.occurrence && form.task.recurrence"
                  >仅本次标题<AInput
                    :value="form.occurrence.titleOverride || ''"
                    @update:value="form.occurrence.titleOverride = $event"
                    placeholder="留空使用系列标题"
                /></label>
              </div>
            </ToDooDisclosure>
            <ToDooDisclosure class="todo-disclosure">
              <template #header
                ><span>推进记录</span
                ><small v-if="records.length" class="todo-muted">{{
                  records.length
                }}</small></template
              >
              <div class="todo-disclosure-content todo-form">
                <div v-for="r in records" :key="r.id" class="todo-saved-row">
                  <span
                    >{{ r.content
                    }}<small
                      >{{ new Date(r.occurredAt).toLocaleString()
                      }}{{ r.minutes !== null ? ' · ' + r.minutes + ' 分钟' : '' }}</small
                    ></span
                  ><AButton
                    class="todo-link"
                    html-type="button"
                    @click="emit('edit', 'record', r)"
                    type="link"
                  >
                    编辑
                  </AButton>
                </div>
                <AButton
                  class="todo-link"
                  html-type="button"
                  @click="
                    emit('edit', 'record', undefined, {
                      taskId: form.task.id,
                      occurrenceId: form.occurrence?.id || null,
                      listId: form.task.listId,
                    })
                  "
                  type="link"
                >
                  ＋ 记录进展
                </AButton>
              </div>
            </ToDooDisclosure>
            <ToDooDisclosure class="todo-disclosure">
              <template #header><span>操作历史</span></template>
              <div class="todo-disclosure-content todo-form">
                <template
                  v-for="(page, kind) in state.detailCollectionPages[state.selectedTaskId]"
                  :key="kind"
                  ><AButton
                    v-if="page?.nextCursor"
                    class="todo-button"
                    html-type="button"
                    :disabled="state.collectionLoading"
                    @click="model.nextTaskCollectionPage(state.selectedTaskId, kind)"
                    type="default"
                  >
                    继续载入此任务的{{ detailCollectionLabels[kind] || '关联记录' }}
                  </AButton></template
                >
                <div v-for="h in history" :key="h.id" class="todo-history">
                  <time>{{ new Date(h.at).toLocaleString() }}</time
                  ><span>{{ h.summary || h.action }}</span>
                </div>
                <p v-if="!history.length" class="todo-muted todo-small">当前范围没有历史记录</p>
              </div>
            </ToDooDisclosure>
          </div>
        </ToDooDisclosure>
      </fieldset>
    </div>
    <p v-else class="todo-empty">任务暂不可用，可能尚未载入或已被移除。</p>
    <footer
      v-if="!creating && form"
      class="todo-detail-footer"
      :class="{ 'has-unsaved': model.dirty() || savingTask }"
    >
      <AButton
        html-type="button"
        type="text"
        class="todo-detail-focus"
        :disabled="state.busy"
        @click="emit('focus', form.occurrence?.id)"
        ><ToDooIcon name="focus" :size="16" />专注</AButton
      >
      <AButton
        v-show="model.dirty() || savingTask"
        html-type="button"
        class="todo-button todo-primary todo-detail-save"
        :disabled="state.busy || !form.task.title.trim()"
        :loading="savingTask"
        @click="save"
        type="primary"
        >保存任务</AButton
      >
      <ToDooTaskMenu
        v-if="menuItem"
        :model="model"
        :item="menuItem"
        label="更多操作"
        parent-delete
        :remove-task="remove"
        @open="emit('select', $event.task.id, $event.occurrence?.id)"
        @child="emit('child', $event)"
        @edit="(kind, entity, seed) => emit('edit', kind, entity, seed)"
        @remove="remove"
      />
    </footer>
  </aside>
</template>
