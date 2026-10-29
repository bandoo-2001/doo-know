<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import type { TreeEntry } from '../../../../shared/contracts';
import type { ToDooEntityKind } from '../../../../shared/to-doo-contracts';
import {
  toDooLocalDate,
  parseToDooQuickEntry,
  toDooStatusLabels,
  toDooDependencies,
  type ToDooWorkbench,
} from '../../to-doo-workbench';
import ToDooNotes from './ToDooNotes.vue';
import ToDooReminders from './ToDooReminders.vue';
import ToDooDateExceptions from './ToDooDateExceptions.vue';
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
  advanced = ref(false),
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
          id: crypto.randomUUID(),
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
  const descendants = children.value.length;
  let cascade = false;
  if (value === 'done' && descendants) {
    if (!confirm(`这个任务有 ${descendants} 个子任务。是否同时完成其未完成的子任务？`)) return;
    cascade = true;
  }
  await props.model.setStatus(form.value.occurrence.id, value as any, cascade);
  if (!props.model.dirty())
    props.model.selectTask(state.selectedTaskId, state.selectedOccurrenceId);
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
function discardNew() {
  if (!confirm('放弃这份尚未提交的新建任务草稿？')) return;
  props.model.clearNewTaskDraft(props.parentTaskId, props.listId);
  emit('close');
}
function close() {
  emit('close');
}
async function discardConflict() {
  if (!confirm('放弃这份本地输入，改用服务端当前内容？')) return;
  await props.model.ensureTask(state.selectedTaskId);
  props.model.discardDraft();
  state.conflict = false;
  state.error = '';
}
async function remove() {
  if (!form.value || !confirm('将任务及其子任务移入回收站？')) return;
  const r = await props.model.removeEntity('task', form.value.task, false, true);
  if (r) emit('close');
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
      ><button type="button" class="todo-icon-button" aria-label="关闭任务详情" @click="close">
        ×
      </button>
    </header>
    <form v-if="creating" class="todo-form todo-detail-body" @submit.prevent="create">
      <fieldset class="todo-create-fields" :disabled="state.busy">
        <label
          >任务标题<input
            v-model="local.title"
            required
            maxlength="256"
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
          <button type="button" class="todo-link" @click="adoptQuick">采用识别结果</button
          ><small>采用后仍可调整日期和时间。</small>
        </div>
        <p v-if="local.frequency" class="todo-muted todo-small">
          已采用{{
            local.frequency === 'daily' ? '每天' : '每周'
          }}重复，可在创建后的详情中继续调整。
        </p>
        <label>任务说明<textarea v-model="local.description" rows="3"></textarea></label
        ><label
          >目标或清单<select v-model="local.listId" :disabled="!!parentTaskId">
            <option :value="null">收集箱</option>
            <option
              v-for="l in state.snapshot?.lists.filter((l) => !l.deletedAt)"
              :key="l.id"
              :value="l.id"
            >
              {{ l.name }}
            </option>
          </select></label
        >
        <div class="todo-form-grid">
          <label>截止日期<input v-model="local.dueDate" type="date" /></label
          ><label>截止时间<input v-model="local.dueTime" type="time" /></label
          ><label>计划日期<input v-model="local.planDate" type="date" /></label
          ><label>计划时间<input v-model="local.planTime" type="time" /></label>
        </div>
        <label>预计分钟<input v-model.number="local.estimate" type="number" min="0" /></label>
        <p class="todo-muted todo-small">创建任务后，可以在详情中上传附件、关联资料和记录成果。</p>
        <label>完成标准<textarea v-model="local.criteria" rows="3"></textarea></label
        ><button class="todo-button todo-primary" type="submit" :disabled="state.busy">
          {{ state.busy ? '创建中…' : '创建任务' }}</button
        ><button
          type="button"
          class="todo-link todo-danger"
          :disabled="state.busy"
          @click="discardNew"
        >
          放弃这份新建草稿
        </button>
      </fieldset>
    </form>
    <div v-else-if="form" class="todo-detail-body todo-form">
      <fieldset class="todo-create-fields" :disabled="state.busy">
        <label class="todo-title-input"
          >任务标题<input v-model="form.task.title" maxlength="256"
        /></label>
        <div class="todo-form-grid">
          <label
            >执行实例<select
              :value="state.selectedOccurrenceId"
              @change="emit('select', form.task.id, ($event.target as HTMLSelectElement).value)"
            >
              <option v-for="o in occurrences" :key="o.id" :value="o.id">
                {{ o.scheduledDate || o.due?.date || '普通任务' }} ·
                {{ toDooStatusLabels[o.status] }}
              </option>
            </select></label
          ><label
            >状态<select
              :value="form.occurrence?.status || 'unavailable'"
              :disabled="state.busy || !form.occurrence"
              @change="status(($event.target as HTMLSelectElement).value)"
            >
              <option v-if="!form.occurrence" value="unavailable">执行记录尚未载入</option>
              <option v-for="(label, key) in toDooStatusLabels" :key="key" :value="key">
                {{ label }}
              </option>
            </select></label
          >
        </div>
        <button
          v-if="!form.occurrence"
          type="button"
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
        >
          生成本次执行记录
        </button>
        <label>任务说明<textarea v-model="form.task.description" rows="4"></textarea></label>
        <div class="todo-form-grid">
          <label
            >所属目标或清单<select v-model="form.task.listId" :disabled="!!form.task.parentTaskId">
              <option :value="null">收集箱</option>
              <option
                v-for="l in state.snapshot?.lists.filter((l) => !l.deletedAt)"
                :key="l.id"
                :value="l.id"
              >
                {{ l.name }}
              </option>
            </select></label
          ><label
            >章节<select v-model="form.task.sectionId">
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
            </select></label
          ><label
            >优先级<select v-model="form.task.priority">
              <option value="none">无优先级</option>
              <option value="low">低</option>
              <option value="normal">中</option>
              <option value="high">高</option>
            </select></label
          ><label
            >预计分钟<input v-model.number="form.task.estimateMinutes" type="number" min="0"
          /></label>
        </div>
        <fieldset class="todo-fieldset">
          <legend>截止与时间安排</legend>
          <div class="todo-form-grid">
            <label
              >截止日期<input
                type="date"
                :value="form.occurrence?.due?.date || ''"
                @input="due(($event.target as HTMLInputElement).value, 'date')" /></label
            ><label
              >截止时间<input
                type="time"
                :value="form.occurrence?.due?.time || ''"
                @input="due(($event.target as HTMLInputElement).value, 'time')"
            /></label>
          </div>
          <label v-if="form.occurrence?.due"
            >截止时区<input v-model="form.occurrence.due.timeZone"
          /></label>
          <div v-for="block in form.blocks" :key="block.id" class="todo-saved-row">
            <span
              >{{ block.start.date }} {{ block.start.time || '全天' }} ·
              {{ block.durationMinutes }} 分钟</span
            ><button type="button" class="todo-link" @click="emit('edit', 'timeBlock', block)">
              调整
            </button>
          </div>
          <button
            type="button"
            class="todo-link"
            @click="
              emit('edit', 'timeBlock', undefined, {
                occurrenceId: form.occurrence?.id || null,
                title: form.task.title,
              })
            "
          >
            ＋ 添加一段时间
          </button>
        </fieldset>
        <label v-if="form.task.parentTaskId" class="todo-checkbox"
          ><input
            v-model="form.task.inheritRecurrence"
            type="checkbox"
          />跟随父任务的重复周期</label
        >
        <fieldset class="todo-fieldset">
          <legend>重复规则</legend>
          <label
            >重复<select
              :value="form.task.recurrence?.frequency || ''"
              @change="repeat(($event.target as HTMLSelectElement).value)"
            >
              <option value="">不重复</option>
              <option value="daily">每天</option>
              <option value="weekly">每周</option>
              <option value="monthly">每月</option>
              <option value="yearly">每年</option>
              <option value="after_completion">完成后重复</option>
            </select></label
          ><template v-if="form.task.recurrence"
            ><div class="todo-form-grid">
              <label
                >间隔<input
                  v-model.number="form.task.recurrence.interval"
                  type="number"
                  min="1" /></label
              ><label>开始日期<input v-model="form.task.recurrence.anchorDate" type="date" /></label
              ><label>重复时间<input v-model="form.task.recurrence.time" type="time" /></label
              ><label>时区<input v-model="form.task.recurrence.timeZone" /></label
              ><label>结束日期<input v-model="form.task.recurrence.until" type="date" /></label
              ><label
                >最多次数<input v-model.number="form.task.recurrence.count" type="number" min="1"
              /></label>
            </div>
            <label v-if="form.task.recurrence.frequency === 'weekly'"
              >每周日期<select v-model="form.task.recurrence.weekdays" multiple>
                <option
                  v-for="(day, i) in ['日', '一', '二', '三', '四', '五', '六']"
                  :key="i"
                  :value="i"
                >
                  星期{{ day }}
                </option>
              </select></label
            >
            <div v-if="form.task.recurrence.frequency === 'monthly'" class="todo-form">
              <label
                >每月方式<select
                  :value="form.task.recurrence.weekOrdinal ? 'weekday' : 'date'"
                  @change="monthly(($event.target as HTMLSelectElement).value)"
                >
                  <option value="date">固定日期</option>
                  <option value="weekday">第几个星期</option>
                </select></label
              ><label v-if="!form.task.recurrence.weekOrdinal"
                >每月日期<input
                  v-model.number="form.task.recurrence.monthDay"
                  type="number"
                  min="1"
                  max="31"
              /></label>
              <div v-else class="todo-form-grid">
                <label
                  >第几个<select v-model.number="form.task.recurrence.weekOrdinal">
                    <option v-for="n in [1, 2, 3, 4, 5, -1]" :key="n" :value="n">
                      {{ n === -1 ? '最后一个' : '第 ' + n + ' 个' }}
                    </option>
                  </select></label
                ><label
                  >星期<select
                    :value="form.task.recurrence.weekdays[0] ?? 1"
                    @change="
                      form.task.recurrence.weekdays = [
                        Number(($event.target as HTMLSelectElement).value),
                      ]
                    "
                  >
                    <option
                      v-for="(d, i) in ['日', '一', '二', '三', '四', '五', '六']"
                      :key="i"
                      :value="i"
                    >
                      星期{{ d }}
                    </option>
                  </select></label
                >
              </div>
            </div>
            <label v-if="form.task.recurrence.frequency === 'after_completion'"
              >完成后间隔单位<select v-model="form.task.recurrence.completionUnit">
                <option value="day">天</option>
                <option value="week">周</option>
                <option value="month">月</option>
              </select></label
            ><label
              >短月处理<select v-model="form.task.recurrence.shortMonth">
                <option value="last_day">使用月末</option>
                <option value="skip">跳过当月</option>
              </select></label
            ><ToDooDateExceptions
              v-model="form.task.recurrence.excludedDates"
              label="排除这些日期"
            /><ToDooDateExceptions
              v-model="form.task.recurrence.additionalDates"
              label="额外安排这些日期"
            /><label
              >修改范围<select v-model="scope">
                <option value="all">整个系列（保留完成历史）</option>
                <option value="future">本次及以后</option>
              </select></label
            ></template
          >
        </fieldset>
        <ToDooNotes
          v-model="form.task.noteRefs"
          :tree="tree"
          @open-note="emit('open-note', $event)"
        />
        <fieldset class="todo-fieldset">
          <legend>任务附件</legend>
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
                ><button
                  v-if="['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(asset.mime)"
                  type="button"
                  class="todo-link"
                  @click="previewAsset = previewAsset === asset.hash ? '' : asset.hash"
                >
                  {{ previewAsset === asset.hash ? '收起预览' : '预览' }}</button
                ><button
                  type="button"
                  class="todo-link todo-danger"
                  :disabled="state.busy || model.dirty()"
                  @click="removeAsset(asset.hash)"
                >
                  移除关联
                </button>
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
        </fieldset>
        <fieldset class="todo-fieldset">
          <legend>完成标准与成果</legend>
          <label
            >完成标准<textarea
              v-model="form.task.criteria"
              rows="4"
              placeholder="每行一条，普通任务也可以留空"
            ></textarea>
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
            ><button type="button" class="todo-link" @click="emit('edit', 'outcome', o)">
              编辑
            </button>
          </div>
          <button class="todo-link" type="button" @click="makeOutcome">＋ 记录成果与证据</button>
          <button
            type="button"
            class="todo-button"
            :disabled="state.busy || model.dirty() || !form.occurrence"
            @click="emit('outcome-note')"
          >
            创建成果笔记并关联
          </button>
          <button
            v-if="createdNoteId"
            type="button"
            class="todo-link"
            aria-label="打开成果笔记"
            @click="emit('open-note', createdNoteId)"
          >
            打开成果笔记 ↗
          </button>
        </fieldset>
        <fieldset class="todo-fieldset">
          <legend>子任务</legend>
          <button
            v-for="t in children"
            :key="t.id"
            class="todo-saved-row todo-text-button"
            type="button"
            @click="emit('select', t.id)"
          >
            {{ t.title }} <span>↗</span></button
          ><button type="button" class="todo-link" @click="emit('child', form.task.id)">
            ＋ 添加子任务
          </button>
        </fieldset>
        <button type="button" class="todo-link" @click="advanced = !advanced">
          {{ advanced ? '收起' : '展开' }}标签、提醒、依赖与来源
        </button>
        <template v-if="advanced"
          ><label
            >标签<select v-model="form.task.tagIds" multiple>
              <option
                v-for="tag in state.snapshot?.tags.filter((t) => !t.deletedAt)"
                :key="tag.id"
                :value="tag.id"
              >
                {{ tag.name }}
              </option>
            </select></label
          ><button class="todo-link" type="button" @click="emit('edit', 'tag')">＋ 新建标签</button>
          <div class="todo-form-grid">
            <label
              >重要程度<select v-model="form.task.importance">
                <option value="normal">普通</option>
                <option value="important">重要</option>
              </select></label
            ><label
              >紧急程度<select v-model="form.task.urgentOverride">
                <option :value="null">根据截止时间判断</option>
                <option :value="true">设为紧急</option>
                <option :value="false">设为不紧急</option>
              </select></label
            >
          </div>
          <label
            >前置任务<select v-model="dependencies" multiple>
              <option
                v-for="t in state.snapshot?.tasks.filter(
                  (t) => !t.deletedAt && t.id !== form!.task.id,
                )"
                :key="t.id"
                :value="t.id"
              >
                {{ t.title }}
              </option>
            </select></label
          ><label v-for="dependency in form.task.dependencies" :key="dependency.taskId"
            >{{
              state.snapshot?.tasks.find((t) => t.id === dependency.taskId)?.title ||
              dependency.taskId
            }}
            完成后等待（分钟）<input
              v-model.number="dependency.lagMinutes"
              type="number"
              min="0"
              max="525600"
              step="1" /></label
          ><label v-if="form.occurrence"
            >受阻原因<textarea v-model="form.occurrence.blockedReason" rows="2"></textarea></label
          ><ToDooReminders v-model="form.task.reminders" :date-based="false" /><label
            >来源资料<select
              :value="form.task.source?.noteId || ''"
              @change="
                form.task.source = ($event.target as HTMLSelectElement).value
                  ? {
                      noteId: ($event.target as HTMLSelectElement).value,
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
            </select></label
          ><label
            >来源引用<textarea
              :value="form.task.source?.quote || ''"
              rows="2"
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
            ></textarea></label
          ><label v-if="form.occurrence && form.task.recurrence"
            >仅本次标题<input
              v-model="form.occurrence.titleOverride"
              placeholder="留空使用系列标题" /></label
        ></template>
        <fieldset class="todo-fieldset">
          <legend>推进记录</legend>
          <div v-for="r in records" :key="r.id" class="todo-saved-row">
            <span
              >{{ r.content
              }}<small
                >{{ new Date(r.occurredAt).toLocaleString()
                }}{{ r.minutes !== null ? ' · ' + r.minutes + ' 分钟' : '' }}</small
              ></span
            ><button class="todo-link" type="button" @click="emit('edit', 'record', r)">
              编辑
            </button>
          </div>
          <button
            class="todo-link"
            type="button"
            @click="
              emit('edit', 'record', undefined, {
                taskId: form.task.id,
                occurrenceId: form.occurrence?.id || null,
                listId: form.task.listId,
              })
            "
          >
            ＋ 记录进展
          </button>
        </fieldset>
        <fieldset class="todo-fieldset">
          <legend>操作历史</legend>
          <template
            v-for="(page, kind) in state.detailCollectionPages[state.selectedTaskId]"
            :key="kind"
            ><button
              v-if="page?.nextCursor"
              class="todo-button"
              type="button"
              :disabled="state.collectionLoading"
              @click="model.nextTaskCollectionPage(state.selectedTaskId, kind)"
            >
              继续载入此任务的{{ detailCollectionLabels[kind] || '关联记录' }}
            </button></template
          >
          <div v-for="h in history" :key="h.id" class="todo-history">
            <time>{{ new Date(h.at).toLocaleString() }}</time
            ><span>{{ h.summary || h.action }}</span>
          </div>
          <p v-if="!history.length" class="todo-muted todo-small">当前范围没有历史记录</p>
        </fieldset>
      </fieldset>
    </div>
    <p v-else class="todo-empty">任务暂不可用，可能尚未载入或已被移除。</p>
    <footer v-if="!creating && form" class="todo-detail-footer">
      <button
        type="button"
        class="todo-button todo-primary"
        :disabled="state.busy || !form.task.title.trim()"
        @click="model.saveTask(scope)"
      >
        保存任务</button
      ><button
        type="button"
        class="todo-button"
        :disabled="state.busy || !form.occurrence"
        @click="status(form.occurrence?.status === 'done' ? 'todo' : 'done')"
      >
        {{ form.occurrence?.status === 'done' ? '重新打开' : '标记完成' }}</button
      ><button type="button" class="todo-button" @click="emit('focus', form.occurrence?.id)">
        专注</button
      ><button type="button" class="todo-button todo-danger" :disabled="state.busy" @click="remove">
        删除
      </button>
    </footer>
  </aside>
</template>
