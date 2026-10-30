<script setup lang="ts">
import ToDooDisclosure from './ToDooDisclosure.vue';
import { useToDooConfirm } from '../../to-doo-controls';
import ToDooDateField from './ToDooDateField.vue';
import ToDooSelect from './ToDooSelect.vue';

import { computed, onBeforeUnmount, ref } from 'vue';
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
import type { ToDooEntityKind } from '../../../../shared/to-doo-contracts';
import {
  toDooLocalDate,
  parseToDooQuickEntry,
  toDooStatusLabels,
  toDooPriorityLabels,
  toDooDependencies,
  type ToDooWorkbench,
} from '../../to-doo-workbench';
import ToDooNotes from './ToDooNotes.vue';
import ToDooReminders from './ToDooReminders.vue';
import ToDooDateExceptions from './ToDooDateExceptions.vue';
const confirmAction = useToDooConfirm();
const props = defineProps<{
  model: ToDooWorkbench;
  tree: TreeEntry[];
  creating?: boolean;
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
      local.planTime = value.time || '09:00';
    }
  } else if (value.time) {
    local.planDate = toDooLocalDate();
    local.planTime = value.time;
  }
  local.tagIds = value.tagIds;
  local.frequency = value.frequency;
  local.weekdays = value.weekdays;
}
const scope = ref<'all' | 'future'>('all'),
  previewAsset = ref('');
const zone = computed(() => state.snapshot?.settings.timeZone || 'UTC');
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
  const result = await props.model.createTask({
    title: local.title.trim(),
    description: local.description,
    criteria: local.criteria,
    listId: local.listId,
    parentTaskId: local.parentTaskId,
    estimateMinutes: local.estimate === '' ? null : local.estimate,
    tagIds: local.tagIds,
    recurrence: local.frequency
      ? {
          id: local.recurrenceId,
          frequency: local.frequency,
          interval: 1,
          anchorDate: local.planDate || local.dueDate || toDooLocalDate(),
          time: local.planTime || null,
          timeZone: zone.value,
          weekdays: local.weekdays,
          until: null,
          count: null,
          shortMonth: 'last_day',
          excludedDates: [],
          additionalDates: [],
          endedAt: null,
          completionUnit: 'day',
        }
      : null,
    due: local.dueDate
      ? { date: local.dueDate, time: local.dueTime || null, timeZone: zone.value }
      : null,
    plan: local.planDate
      ? { date: local.planDate, time: local.planTime || null, timeZone: zone.value }
      : null,
  });
  if (result) emit('created', state.selectedTaskId);
}
async function status(value: string) {
  if (!form.value?.occurrence) return;
  const taskId = state.selectedTaskId,
    occurrenceId = state.selectedOccurrenceId;
  const targetOccurrence = form.value.occurrence.id;
  const descendants = children.value.length;
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
    props.creating ? !!local.title || !!local.description : props.model.dirty(),
});
</script>
<template>
  <aside
    class="todo-detail"
    aria-label="任务详情"
    @keydown.ctrl.enter.prevent="creating ? create() : model.saveTask(scope)"
    @keydown.meta.enter.prevent="creating ? create() : model.saveTask(scope)"
  >
    <header class="todo-between">
      <span class="todo-muted">{{ creating ? '新建任务' : '任务详情' }}</span
      ><span
        v-if="!creating"
        class="todo-small"
        :class="model.dirty() ? 'todo-warning' : 'todo-muted'"
        >{{ model.dirty() ? '未保存的更改' : '已保存' }}</span
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
        <p v-if="local.frequency" class="todo-muted todo-small">
          已采用{{
            local.frequency === 'daily' ? '每天' : '每周'
          }}重复，可在创建后的详情中继续调整。
        </p>
        <label>任务说明<ATextarea v-model:value="local.description" :rows="3"></ATextarea></label
        ><label
          >目标或清单<ToDooSelect v-model="local.listId" :disabled="!!parentTaskId">
            <option :value="null">收集箱</option>
            <option
              v-for="l in state.snapshot?.lists.filter((l) => !l.deletedAt)"
              :key="l.id"
              :value="l.id"
            >
              {{ l.name }}
            </option>
          </ToDooSelect></label
        >
        <label>计划日期<ToDooDateField v-model="local.planDate" type="date" /></label>
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
            <label>完成标准<ATextarea v-model:value="local.criteria" :rows="3"></ATextarea></label>
            <p class="todo-muted todo-small">
              创建任务后，可以在详情中上传附件、关联资料和记录成果。
            </p>
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
      <fieldset class="todo-create-fields" :disabled="state.busy">
        <label class="todo-title-input"
          >任务标题<AInput v-model:value="form.task.title" :maxlength="256"
        /></label>
        <div class="todo-form-grid">
          <label v-if="form.task.recurrence || occurrences.length > 1"
            >执行实例<ToDooSelect
              :value="state.selectedOccurrenceId"
              @change="emit('select', form.task.id, $event)"
            >
              <option v-for="o in occurrences" :key="o.id" :value="o.id">
                {{ o.scheduledDate || o.due?.date || '普通任务' }} ·
                {{ toDooStatusLabels[o.status] }}
              </option>
            </ToDooSelect></label
          ><label
            >状态<ToDooSelect
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
        </div>
        <AButton
          v-if="!form.occurrence"
          html-type="button"
          class="todo-button"
          :disabled="state.busy"
          @click="
            model
              .execute({
                action: 'materialize_occurrences',
                payload: { taskId: form.task.id, from: toDooLocalDate(), to: toDooLocalDate() },
              })
              .then(() => model.selectTask(form!.task.id))
          "
          type="default"
        >
          生成本次执行记录
        </AButton>
        <label
          >任务说明<ATextarea v-model:value="form.task.description" :rows="4"></ATextarea
        ></label>
        <div class="todo-form-grid">
          <label
            >所属目标或清单<ToDooSelect
              v-model="form.task.listId"
              :disabled="!!form.task.parentTaskId"
            >
              <option :value="null">收集箱</option>
              <option
                v-for="l in state.snapshot?.lists.filter((l) => !l.deletedAt)"
                :key="l.id"
                :value="l.id"
              >
                {{ l.name }}
              </option>
            </ToDooSelect></label
          ><label
            >优先级<ASelect
              v-model:value="form.task.priority"
              class="todo-priority-select"
              :class="'todo-priority-' + form.task.priority"
              aria-label="优先级"
              :options="priorityOptions"
              :disabled="state.busy"
              :get-popup-container="priorityPopupContainer"
              dropdown-class-name="todo-priority-popup"
            >
              <template #option="{ value, label }">
                <ATag class="todo-priority-label" :class="'todo-priority-' + value">{{
                  label
                }}</ATag>
              </template>
            </ASelect></label
          >
        </div>
        <fieldset class="todo-fieldset todo-classification">
          <legend>四象限归类</legend>
          <p>重要程度与紧急程度决定所在象限；优先级用于安排执行顺序。</p>
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
        </fieldset>
        <fieldset class="todo-fieldset">
          <legend>截止与时间安排</legend>
          <div class="todo-form-grid">
            <label
              >截止日期<ToDooDateField
                type="date"
                :value="form.occurrence?.due?.date || ''"
                @input="due($event, 'date')" /></label
            ><label
              >截止时间<ToDooDateField
                type="time"
                :value="form.occurrence?.due?.time || ''"
                @input="due($event, 'time')"
            /></label>
          </div>
          <label v-if="form.occurrence?.due"
            >截止时区<AInput v-model:value="form.occurrence.due.timeZone"
          /></label>
          <div v-for="block in form.blocks" :key="block.id" class="todo-saved-row">
            <span
              >{{ block.start.date }} {{ block.start.time || '全天' }} ·
              {{ block.durationMinutes }} 分钟</span
            ><AButton
              html-type="button"
              class="todo-link"
              @click="emit('edit', 'timeBlock', block)"
              type="link"
            >
              调整
            </AButton>
          </div>
          <AButton
            html-type="button"
            class="todo-link"
            @click="
              emit('edit', 'timeBlock', undefined, {
                occurrenceId: form.occurrence?.id || null,
                title: form.task.title,
              })
            "
            type="link"
          >
            ＋ 添加一段时间
          </AButton>
        </fieldset>
        <ToDooDisclosure
          class="todo-disclosure"
          :open="!!form.task.recurrence || form.task.inheritRecurrence"
        >
          <template #header><span>重复规则</span></template>
          <div class="todo-disclosure-content todo-form">
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
                  >重复时间<ToDooDateField v-model="form.task.recurrence.time" type="time" /></label
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
        <ToDooDisclosure class="todo-disclosure" :open="!!form.task.noteRefs.length">
          <template #header><span>关联资料</span></template>
          <div class="todo-disclosure-content">
            <ToDooNotes
              v-model="form.task.noteRefs"
              :tree="tree"
              @open-note="emit('open-note', $event)"
            />
          </div>
        </ToDooDisclosure>
        <ToDooDisclosure class="todo-disclosure" :open="!!form.task.attachments.length">
          <template #header><span>任务附件</span></template>
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
            <div v-for="asset in form.task.attachments" :key="asset.hash" class="todo-attachment">
              <div class="todo-between">
                <span
                  >{{ asset.name
                  }}<small class="todo-muted">{{ (asset.size / 1024).toFixed(1) }} KB</small></span
                >
                <div class="todo-actions">
                  <a class="todo-link" :href="assetUrl(asset.hash)" :download="asset.name">下载</a
                  ><AButton
                    v-if="
                      ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(asset.mime)
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
            <p v-if="!form.task.attachments.length" class="todo-muted todo-small">还没有上传附件</p>
          </div>
        </ToDooDisclosure>
        <ToDooDisclosure
          class="todo-disclosure"
          :open="!!form.task.criteria || !!outcomes.length || !!createdNoteId"
        >
          <template #header><span>完成标准与成果</span></template>
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
        <fieldset class="todo-fieldset">
          <legend>子任务</legend>
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
        </fieldset>
        <ToDooDisclosure
          class="todo-disclosure"
          :open="
            !!form.task.tagIds.length ||
            !!form.task.reminders.length ||
            !!form.task.dependencies.length ||
            !!form.task.source
          "
        >
          <template #header><span>更多选项：标签、提醒、依赖与来源</span></template>
          <div class="todo-disclosure-content todo-form">
            <div class="todo-form-grid">
              <label
                >章节<ToDooSelect v-model="form.task.sectionId">
                  <option :value="null">不分章节</option>
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
                  @update:value="form.task.estimateMinutes = $event == null ? null : Number($event)"
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
            ><AButton class="todo-link" html-type="button" @click="emit('edit', 'tag')" type="link">
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
              ></ATextarea></label
            ><ToDooReminders v-model="form.task.reminders" :date-based="false" /><label
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
        <ToDooDisclosure class="todo-disclosure" :open="!!records.length">
          <template #header><span>推进记录</span></template>
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
      </fieldset>
    </div>
    <p v-else class="todo-empty">任务暂不可用，可能尚未载入或已被移除。</p>
    <footer v-if="!creating && form" class="todo-detail-footer">
      <AButton
        html-type="button"
        class="todo-button todo-primary"
        :disabled="state.busy || !form.task.title.trim()"
        @click="model.saveTask(scope)"
        type="primary"
      >
        保存任务</AButton
      ><AButton
        html-type="button"
        class="todo-button"
        :disabled="state.busy || !form.occurrence"
        @click="status(form.occurrence?.status === 'done' ? 'todo' : 'done')"
        type="default"
      >
        {{ form.occurrence?.status === 'done' ? '重新打开' : '标记完成' }}</AButton
      ><AButton
        html-type="button"
        class="todo-button"
        @click="emit('focus', form.occurrence?.id)"
        type="default"
      >
        专注
      </AButton>
      <APopover trigger="click" placement="topRight">
        <template #content
          ><AButton type="text" danger :disabled="state.busy" @click="remove"
            >删除</AButton
          ></template
        >
        <AButton type="text" aria-label="更多操作">更多操作</AButton>
      </APopover>
    </footer>
  </aside>
</template>
