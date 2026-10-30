<script setup lang="ts">
import {
  Button as AButton,
  Checkbox as ACheckbox,
  Input as AInput,
  InputNumber as AInputNumber,
  Modal as AModal,
  Textarea as ATextarea,
} from 'ant-design-vue';
import ToDooSelect from './ToDooSelect.vue';
import ToDooDateField from './ToDooDateField.vue';
import { computed, reactive, ref } from 'vue';
import type { TreeEntry } from '../../../../shared/contracts';
import type { ToDooEntityKind } from '../../../../shared/to-doo-contracts';
import { shiftToDooDate, toDooLocalDate, type ToDooWorkbench } from '../../to-doo-workbench';
import ToDooNotes from './ToDooNotes.vue';
import { useToDooConfirm } from '../../to-doo-controls';
import ToDooReminders from './ToDooReminders.vue';
import ToDooFilterGroup from './ToDooFilterGroup.vue';
const props = defineProps<{
  model: ToDooWorkbench;
  kind: ToDooEntityKind;
  entity?: Record<string, any>;
  seed?: Record<string, any>;
  tree: TreeEntry[];
}>();
const emit = defineEmits<{ close: []; 'open-note': [id: string] }>();
const confirm = useToDooConfirm();
const today = toDooLocalDate(new Date(), props.model.state.snapshot?.settings.timeZone);
const defaults: Record<string, any> = {
  list: { name: '', kind: 'goal', description: '', goalDate: null, criteria: '', noteRefs: [] },
  tag: { name: '' },
  section: { name: '', listId: '' },
  habit: {
    name: '',
    description: '',
    startDate: today,
    effectiveFrom: today,
    weekStartsOn: 1,
    skipPolicy: 'break',
    timeZone: props.model.state.snapshot?.settings.timeZone || 'UTC',
    frequency: 'daily',
    target: 1,
    unit: '次',
    listId: null,
    noteRefs: [],
    reminders: [],
  },
  anniversary: {
    name: '',
    date: today,
    calendar: 'gregorian',
    repeatYearly: true,
    countMode: 'exclude_today',
    leapPolicy: 'previous_day',
    description: '',
    category: '',
    noteRefs: [],
    reminders: [],
  },
  review: {
    name: '周复盘',
    from: shiftToDooDate(today, -6),
    to: today,
    content: '',
    capturedAt: new Date().toISOString(),
    listId: null,
    noteRefs: [],
  },
  record: {
    content: '',
    occurredAt: new Date().toISOString(),
    minutes: null,
    listId: null,
    noteRefs: [],
  },
  outcome: { summary: '', verification: 'self_assessed', criteriaResults: [], evidenceRefs: [] },
  view: { name: '', mode: 'tasks', filter: {}, sort: 'manual', groupBy: 'none' },
  template: { name: '', description: '', tasks: [] },
  timeBlock: {
    title: '',
    start: {
      date: today,
      time: '09:00',
      timeZone: props.model.state.snapshot?.settings.timeZone || 'UTC',
    },
    durationMinutes: 30,
    allDay: false,
    occurrenceId: null,
  },
  calendarSource: { name: '', type: 'ics', enabled: true },
  calendarEvent: {
    title: '',
    uid: crypto.randomUUID(),
    description: '',
    start: {
      date: today,
      time: '09:00',
      timeZone: props.model.state.snapshot?.settings.timeZone || 'UTC',
    },
    end: null,
    allDay: false,
    readOnly: false,
  },
};
const form = reactive<any>(
  JSON.parse(JSON.stringify(props.entity || { ...(defaults[props.kind] || {}), ...props.seed })),
);
if (props.kind === 'habit' && props.entity) form.effectiveFrom = today;
const completeOutcome = ref(false);
const occurrenceRevision = props.model.state.snapshot?.occurrences.find(
  (o) => o.id === form.occurrenceId,
)?.revision;
const baseline = JSON.stringify(form),
  templateLines = ref<string>((form.tasks || []).map((t: any) => t.title).join('\n'));
const label: Record<string, string> = {
  list: '目标与清单',
  tag: '标签',
  section: '章节',
  habit: '习惯',
  anniversary: '纪念日',
  review: '复盘',
  record: '推进记录',
  outcome: '成果',
  view: '保存视图',
  template: '任务模板',
  timeBlock: '时间安排',
  calendarSource: '日历来源',
  calendarEvent: '日历事件',
};
const hasName = computed(
  () => !['record', 'outcome', 'timeBlock', 'calendarEvent'].includes(props.kind),
);
async function close() {
  if (
    JSON.stringify(form) !== baseline &&
    !(await confirm('表单尚未保存，确定关闭并放弃这些输入？'))
  )
    return;
  emit('close');
}
async function save() {
  if (
    props.kind === 'section' &&
    !props.model.state.snapshot?.lists.some((list) => list.id === form.listId && !list.deletedAt)
  ) {
    props.model.state.error = '请先选择关联目标或清单';
    return;
  }
  if (props.kind === 'template')
    form.tasks = templateLines.value
      .split('\n')
      .map((t) => t.trim())
      .filter(Boolean)
      .map((title, i) => ({
        key: 'item' + i,
        title,
        parentKey: null,
        description: '',
        criteria: '',
        estimateMinutes: null,
        noteRefs: [],
      }));
  for (const key of ['listId', 'goalDate', 'endDate']) if (form[key] === '') form[key] = null;
  if (props.kind === 'record' && form.occurredAt.length === 16)
    form.occurredAt = new Date(form.occurredAt).toISOString();
  if (props.kind === 'habit' && form.target) form.target = Number(form.target);
  if (form.start) form.start.time ||= null;
  if (form.end) form.end.time ||= null;
  if (props.kind === 'outcome' && !props.entity && form.occurrenceId && occurrenceRevision) {
    const result = await props.model.execute({
      action: 'save_outcome',
      payload: {
        occurrenceId: form.occurrenceId,
        expectedRevision: occurrenceRevision,
        outcome: {
          summary: form.summary,
          verification: form.verification,
          criteriaResults: form.criteriaResults,
          evidenceRefs: form.evidenceRefs,
        },
        complete: completeOutcome.value,
      },
    });
    if (result) emit('close');
    return;
  }
  const result = await props.model.saveEntity(props.kind, form, props.entity?.revision);
  if (result) emit('close');
}
async function remove() {
  if (
    !props.entity ||
    !(await confirm('将这条记录移入回收站？相关内容会保留以供恢复。', { danger: true }))
  )
    return;
  const result = await props.model.removeEntity(props.kind, props.entity as any);
  if (result) emit('close');
}
defineExpose({
  hasUnsavedChanges: () => JSON.stringify(form) !== baseline || completeOutcome.value,
});
</script>
<template>
  <AModal
    :open="true"
    :footer="null"
    :mask-closable="false"
    :closable="false"
    wrap-class-name="todo-ant-modal"
    :title="(entity ? '编辑' : '新建') + (label[kind] || '记录')"
    @cancel="close"
  >
    <AButton
      class="ant-modal-close"
      type="text"
      html-type="button"
      aria-label="关闭编辑"
      @click="close"
      >×</AButton
    >
    <form class="todo-form" @submit.prevent="save">
      <label v-if="hasName"
        >名称<AInput v-model:value="form.name" required :maxlength="256" autofocus
      /></label>
      <label v-if="kind === 'list'"
        >类型<ToDooSelect v-model="form.kind">
          <option value="goal">目标</option>
          <option value="list">清单</option>
        </ToDooSelect></label
      >
      <label v-if="['list', 'habit', 'anniversary', 'template'].includes(kind)"
        >说明<ATextarea v-model:value="form.description" :rows="3"></ATextarea>
      </label>
      <label v-if="kind === 'list'"
        >目标日期<ToDooDateField v-model="form.goalDate" type="date"
      /></label>
      <ACheckbox
        v-if="kind === 'list'"
        class="todo-checkbox"
        v-model:checked="form.autoCompleteParents"
        >子项全完成后，自动完成父项</ACheckbox
      ><label v-if="kind === 'list'"
        >成功标准<ATextarea
          v-model:value="form.criteria"
          :rows="3"
          placeholder="怎样才算达成目标？"
        ></ATextarea>
      </label>
      <label v-if="['habit', 'record', 'review', 'section'].includes(kind)"
        >关联目标或清单<ToDooSelect v-model="form.listId" :aria-required="kind === 'section'">
          <option :value="null">不关联</option>
          <option
            v-for="l in model.state.snapshot?.lists.filter((l) => !l.deletedAt)"
            :key="l.id"
            :value="l.id"
          >
            {{ l.name }}
          </option>
        </ToDooSelect></label
      >
      <template v-if="kind === 'habit'"
        ><div class="todo-form-grid">
          <label
            >重复频率<ToDooSelect v-model="form.frequency">
              <option value="daily">每天</option>
              <option value="weekly">每周</option>
              <option value="monthly">每月</option>
            </ToDooSelect></label
          ><label>开始日期<ToDooDateField v-model="form.startDate" type="date" required /></label
          ><label
            >目标数量<AInputNumber
              aria-label="目标数量"
              :value="form.target"
              @update:value="form.target = Number($event ?? 1)"
              :min="0.1"
              :step="0.1"
              required /></label
          ><label>单位<AInput v-model:value="form.unit" :maxlength="40" /></label>
        </div>
        <label
          >规则生效日期<ToDooDateField v-model="form.effectiveFrom" type="date" required
        /></label>
        <p class="todo-muted todo-small">
          目标、周期和单位从此日期起生效；之前的记录按当时规则计算。每周、每月目标在所属周期内累计。
        </p>
        <div class="todo-form-grid">
          <label
            >每周从<ToDooSelect v-model="form.weekStartsOn">
              <option :value="1">星期一</option>
              <option :value="0">星期日</option>
            </ToDooSelect></label
          ><label
            >跳过的计算方式<ToDooSelect v-model="form.skipPolicy">
              <option value="break">中断连续达标</option>
              <option value="exempt">免除本期，不中断</option>
            </ToDooSelect></label
          >
        </div>
        <label
          >时区<AInput v-model:value="form.timeZone" required placeholder="Asia/Shanghai" /></label
        ><label>结束日期<ToDooDateField v-model="form.endDate" type="date" /></label
      ></template>
      <template v-if="kind === 'anniversary'"
        ><div class="todo-form-grid">
          <label>日期<ToDooDateField v-model="form.date" type="date" required /></label
          ><label
            >历法<ToDooSelect v-model="form.calendar">
              <option value="gregorian">公历</option>
              <option value="lunar">农历</option>
            </ToDooSelect></label
          ><label
            >计数方式<ToDooSelect v-model="form.countMode">
              <option value="exclude_today">不含今天</option>
              <option value="include_today">包含今天</option>
            </ToDooSelect></label
          ><label
            >闰日处理<ToDooSelect v-model="form.leapPolicy">
              <option value="previous_day">前一天</option>
              <option value="next_day">后一天</option>
              <option value="skip">跳过</option>
            </ToDooSelect></label
          >
        </div>
        <ACheckbox class="todo-checkbox" v-model:checked="form.repeatYearly">每年重复</ACheckbox
        ><ACheckbox
          v-if="form.calendar === 'lunar'"
          class="todo-checkbox"
          v-model:checked="form.lunarLeapMonth"
          >农历闰月</ACheckbox
        ><label>分类<AInput v-model:value="form.category" /></label
      ></template>
      <template v-if="kind === 'review'"
        ><div class="todo-form-grid">
          <label>开始日期<ToDooDateField v-model="form.from" type="date" required /></label
          ><label>结束日期<ToDooDateField v-model="form.to" type="date" required /></label>
        </div>
        <label
          >复盘内容<ATextarea
            v-model:value="form.content"
            :rows="8"
            placeholder="这段时间留下了什么？哪些值得继续？下次做一个什么调整？"
          ></ATextarea></label
      ></template>
      <template v-if="kind === 'record'"
        ><label
          >推进记录<ATextarea v-model:value="form.content" :rows="5" required></ATextarea></label
        ><label
          >投入分钟<AInputNumber
            aria-label="投入分钟"
            :value="form.minutes"
            @update:value="form.minutes = $event == null ? null : Number($event)"
            :min="0" /></label
        ><label>记录时间<AInput v-model:value="form.occurredAt" required /></label
      ></template>
      <ACheckbox
        v-if="kind === 'outcome' && !entity && form.occurrenceId"
        class="todo-checkbox"
        v-model:checked="completeOutcome"
        >同时完成关联行动</ACheckbox
      ><template v-if="kind === 'outcome'"
        ><label
          >成果说明<ATextarea v-model:value="form.summary" :rows="5" required></ATextarea></label
        ><label
          >验证方式<ToDooSelect v-model="form.verification">
            <option value="self_assessed">自评</option>
            <option value="practice">练习验证</option>
            <option value="reviewed">经过评审</option>
            <option value="delivered">已交付</option>
          </ToDooSelect></label
        ><ACheckbox
          v-for="(c, i) in form.criteriaResults"
          :key="i"
          class="todo-checkbox"
          v-model:checked="c.passed"
          >{{ c.label }}</ACheckbox
        ><ToDooNotes
          v-model="form.evidenceRefs"
          :tree="tree"
          role="output"
          label="成果证据"
          @open-note="emit('open-note', $event)"
      /></template>
      <template v-if="kind === 'view'"
        ><label
          >展示方式<ToDooSelect v-model="form.mode">
            <option
              v-for="(n, k) in {
                tasks: '任务列表',
                board: '看板',
                calendar: '日历',
                timeline: '时间线',
                matrix: '四象限',
                overview: '目标总览',
              }"
              :key="k"
              :value="k"
            >
              {{ n }}
            </option>
          </ToDooSelect></label
        ><label>搜索条件<AInput v-model:value="form.filter.query" /></label
        ><label
          >排序<ToDooSelect v-model="form.sort">
            <option
              v-for="(n, k) in {
                manual: '手动顺序',
                due: '截止日期',
                priority: '优先级',
                created: '创建时间',
                title: '标题',
              }"
              :key="k"
              :value="k"
            >
              {{ n }}
            </option>
          </ToDooSelect></label
        >
        <p class="todo-muted todo-small">当前已选清单、标签与状态条件将一并保存。</p>
        <ToDooFilterGroup v-if="form.filter.group" v-model="form.filter.group" :model="model"
      /></template>
      <label v-if="kind === 'template'"
        >任务标题（每行一项）<ATextarea
          v-model:value="templateLines"
          :rows="8"
          required
        ></ATextarea>
      </label>
      <template v-if="kind === 'calendarEvent'"
        ><label>事件标题<AInput v-model:value="form.title" required /></label
        ><label>事件说明<ATextarea v-model:value="form.description" :rows="3"></ATextarea></label>
        <div class="todo-form-grid">
          <label>开始日期<ToDooDateField v-model="form.start.date" type="date" required /></label
          ><label>开始时间<ToDooDateField v-model="form.start.time" type="time" /></label>
        </div>
        <label>时区<AInput v-model:value="form.start.timeZone" required /></label
        ><ACheckbox class="todo-checkbox" v-model:checked="form.allDay">全天事件</ACheckbox
        ><AButton
          v-if="!form.end"
          class="todo-link"
          html-type="button"
          @click="form.end = { ...form.start }"
          type="link"
        >
          ＋ 设置结束时间
        </AButton>
        <div v-if="form.end" class="todo-form-grid">
          <label
            >结束日期（全天不含当日）<ToDooDateField
              v-model="form.end.date"
              type="date"
              required /></label
          ><label>结束时间<ToDooDateField v-model="form.end.time" type="time" /></label></div
      ></template>
      <template v-if="kind === 'timeBlock'"
        ><label
          >关联行动<ToDooSelect v-model="form.occurrenceId">
            <option :value="null">独立时间安排</option>
            <option
              v-for="o in model.state.snapshot?.occurrences.filter((o) => !o.deletedAt)"
              :key="o.id"
              :value="o.id"
            >
              {{ model.state.snapshot?.tasks.find((t) => t.id === o.taskId)?.title }} ·
              {{ o.scheduledDate || o.due?.date || '普通任务' }}
            </option>
          </ToDooSelect></label
        ><label>安排标题<AInput v-model:value="form.title" /></label>
        <div class="todo-form-grid">
          <label>日期<ToDooDateField v-model="form.start.date" type="date" required /></label
          ><label>时间<ToDooDateField v-model="form.start.time" type="time" /></label
          ><label
            >时长（分钟）<AInputNumber
              aria-label="时长（分钟）"
              :value="form.durationMinutes"
              @update:value="form.durationMinutes = Number($event ?? 1)"
              :min="1"
              required /></label
          ><label>时区<AInput v-model:value="form.start.timeZone" required /></label>
        </div>
        <ACheckbox class="todo-checkbox" v-model:checked="form.allDay">全天安排</ACheckbox
        ><label v-if="form.allDay"
          >结束日期（不含当天）<ToDooDateField v-model="form.dateEndExclusive" type="date" /></label
      ></template>
      <ToDooReminders
        v-if="kind === 'habit' || kind === 'anniversary'"
        v-model="form.reminders"
      /><ToDooNotes
        v-if="Array.isArray(form.noteRefs)"
        v-model="form.noteRefs"
        :tree="tree"
        @open-note="emit('open-note', $event)"
      />
      <p v-if="model.state.error" class="todo-error" role="alert">{{ model.state.error }}</p>
      <footer class="todo-actions">
        <AButton
          v-if="entity"
          html-type="button"
          class="todo-button todo-danger"
          :disabled="model.state.busy"
          @click="remove"
          danger
        >
          移入回收站</AButton
        ><span class="todo-spacer"></span
        ><AButton html-type="button" class="todo-button" @click="close">取消</AButton
        ><AButton
          html-type="submit"
          class="todo-button todo-primary"
          :disabled="model.state.busy"
          type="primary"
        >
          {{ model.state.busy ? '保存中…' : '保存' }}
        </AButton>
      </footer>
    </form>
  </AModal>
</template>
