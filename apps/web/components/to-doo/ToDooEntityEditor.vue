<script setup lang="ts">
import {
  Button as AButton,
  Checkbox as ACheckbox,
  Input as AInput,
  InputNumber as AInputNumber,
  Modal as AModal,
  Segmented as ASegmented,
  Textarea as ATextarea,
} from 'ant-design-vue';
import ToDooSelect from './ToDooSelect.vue';
import ToDooDateField from './ToDooDateField.vue';
import { computed, nextTick, reactive, ref } from 'vue';
import type { TreeEntry } from '../../../../shared/contracts';
import type { ToDooEntityKind } from '../../../../shared/to-doo-contracts';
import { shiftToDooDate, toDooLocalDate, type ToDooWorkbench } from '../../to-doo-workbench';
import ToDooNotes from './ToDooNotes.vue';
import { useToDooConfirm } from '../../to-doo-controls';
import ToDooReminders from './ToDooReminders.vue';
import ToDooFilterGroup from './ToDooFilterGroup.vue';
import ToDooDisclosure from './ToDooDisclosure.vue';
import ToDooFormLayout from './ToDooFormLayout.vue';
import ToDooHabitFields from './ToDooHabitFields.vue';
import { saveTaskSection } from '../../to-doo-task-groups';
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
  focusTopic: { name: '', description: '', color: '#4566c6', listId: null, archivedAt: null },
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
    goalMode: 'checkin',
    weekdays: [],
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
    durationMinutes: props.model.state.snapshot?.settings.defaultDurationMinutes || 30,
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
const { sectionPlacement, ...entitySeed } = props.seed || {};
const form = reactive<any>(
  JSON.parse(JSON.stringify(props.entity || { ...(defaults[props.kind] || {}), ...entitySeed })),
);
if (props.kind === 'habit' && props.entity) form.effectiveFrom = today;
const completeOutcome = ref(false);
const extraFields = ref<InstanceType<typeof ToDooDisclosure>>();
const formLayout = ref<InstanceType<typeof ToDooFormLayout>>();
const validationError = ref('');
function revealInvalid(event: Event) {
  event.preventDefault();
  const input = event.target as HTMLInputElement;
  validationError.value =
    '请检查' +
    (input.getAttribute('aria-label') || input.closest('label')?.textContent?.trim() || '必填项');
  if (input.closest('.todo-form-extras')) extraFields.value?.expand();
  void nextTick(() => {
    if (input.isConnected) input.focus({ preventScroll: false });
  });
}
const occurrenceRevision = props.model.state.snapshot?.occurrences.find(
  (o) => o.id === form.occurrenceId,
)?.revision;
const baseline = JSON.stringify(form),
  templateLines = ref<string>((form.tasks || []).map((t: any) => t.title).join('\n'));
const initialTemplateLines = templateLines.value;
const hasUnsavedInput = () =>
  JSON.stringify(form) !== baseline ||
  completeOutcome.value ||
  templateLines.value !== initialTemplateLines ||
  !!formLayout.value?.hasInvalidInput();
const label: Record<string, string> = {
  list: '目标与清单',
  focusTopic: '专注项目',
  tag: '标签',
  section: '分组',
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
const habitRuleChanged = computed(
  () =>
    props.kind === 'habit' &&
    !!props.entity &&
    [
      'frequency',
      'goalMode',
      'intervalDays',
      'weekdays',
      'target',
      'unit',
      'startDate',
      'endDate',
      'weekStartsOn',
      'skipPolicy',
      'timeZone',
    ].some((key) => JSON.stringify(form[key]) !== JSON.stringify(props.entity?.[key])),
);
const linkedAction = computed(() => {
  const occurrence = props.model.state.snapshot?.occurrences.find(
    (o) => o.id === form.occurrenceId,
  );
  return props.model.state.snapshot?.tasks?.find((t) => t.id === occurrence?.taskId)?.title || '';
});
const extraSummary = computed(
  () =>
    [
      form.description ? '有说明' : '',
      form.criteria ? '有标准' : '',
      form.noteRefs?.length ? `${form.noteRefs.length} 份资料` : '',
      props.kind !== 'habit' && form.reminders?.length ? `${form.reminders.length} 条提醒` : '',
      form.endDate ? `截至 ${form.endDate}` : '',
    ]
      .filter(Boolean)
      .join(' · ') || '选填',
);
async function close() {
  if (hasUnsavedInput() && !(await confirm('表单尚未保存，确定关闭并放弃这些输入？'))) return;
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
  const entity = JSON.parse(JSON.stringify(form));
  if (props.kind === 'section' && !props.entity && sectionPlacement) {
    try {
      const result = await saveTaskSection(props.model, entity, sectionPlacement);
      if (result) emit('close');
    } catch (cause) {
      props.model.state.error = cause instanceof Error ? cause.message : String(cause);
    }
    return;
  }
  if (props.kind === 'habit' && !props.entity) entity.effectiveFrom = entity.startDate;
  if (['timeBlock', 'calendarEvent'].includes(props.kind) && entity.allDay) {
    entity.start.time = null;
    if (entity.end) entity.end.time = null;
  }
  const result =
    props.kind === 'review'
      ? await props.model.execute(
          {
            action: 'save_entity',
            payload: {
              kind: 'review',
              entity,
              captureMetrics: true,
              ...(props.entity?.revision ? { expectedRevision: props.entity.revision } : {}),
            },
          },
          '已保存',
        )
      : await props.model.saveEntity(props.kind, entity, props.entity?.revision);
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
  hasUnsavedChanges: hasUnsavedInput,
});
</script>
<template>
  <AModal
    :open="true"
    :footer="null"
    :mask-closable="false"
    :closable="false"
    wrap-class-name="todo-ant-modal todo-entity-modal"
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
    <ToDooFormLayout
      ref="formLayout"
      class="todo-entity-form"
      :class="{ 'todo-habit-form': kind === 'habit' }"
      :busy="model.state.busy"
      @submit="save"
      @invalid="revealInvalid"
      @input="validationError = ''"
    >
      <label v-if="hasName && kind !== 'habit'"
        >名称<AInput
          v-model:value="form.name"
          required
          :maxlength="256"
          autofocus
          :placeholder="kind === 'anniversary' ? '例如：家人的生日' : '起个简短的名字'"
      /></label>
      <div v-if="kind === 'list'" class="todo-form-grid">
        <div class="todo-form-field">
          <span>类型</span
          ><ASegmented
            aria-label="类型"
            v-model:value="form.kind"
            :options="[
              { label: '清单', value: 'list' },
              { label: '目标', value: 'goal' },
            ]"
          />
        </div>
        <label v-if="form.kind === 'goal'"
          >目标日期<ToDooDateField v-model="form.goalDate" type="date"
        /></label>
      </div>
      <label v-if="kind === 'section'"
        >关联目标或清单<ToDooSelect v-model="form.listId" aria-required="true"
          ><option :value="null">请选择目标或清单</option>
          <option
            v-for="l in model.state.snapshot?.lists.filter((l) => !l.deletedAt)"
            :key="l.id"
            :value="l.id"
          >
            {{ l.name }}
          </option></ToDooSelect
        ></label
      >
      <ToDooHabitFields v-if="kind === 'habit'" :form="form" :rule-changed="habitRuleChanged" />
      <template v-if="kind === 'anniversary'">
        <div class="todo-form-grid">
          <label v-if="form.calendar === 'lunar'"
            >农历原日期<AInput
              v-model:value="form.date"
              aria-label="农历原日期"
              aria-describedby="todo-lunar-original-help"
              required
              :maxlength="10"
              placeholder="YYYY-MM-DD"
              pattern="[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|30)"
            /><small id="todo-lunar-original-help"
              >按农历填写年、月、日；闰月请勾选下方选项。</small
            ></label
          >
          <label v-else>日期<ToDooDateField v-model="form.date" type="date" required /></label>
          <label
            >历法<ToDooSelect v-model="form.calendar"
              ><option value="gregorian">公历</option>
              <option value="lunar">农历</option></ToDooSelect
            ></label
          >
        </div>
        <div class="todo-actions">
          <ACheckbox class="todo-checkbox" v-model:checked="form.repeatYearly">每年重复</ACheckbox
          ><ACheckbox
            v-if="form.calendar === 'lunar'"
            class="todo-checkbox"
            v-model:checked="form.lunarLeapMonth"
            >农历闰月</ACheckbox
          >
        </div>
      </template>
      <template v-if="kind === 'review'">
        <div class="todo-form-grid">
          <label>开始日期<ToDooDateField v-model="form.from" type="date" required /></label
          ><label>结束日期<ToDooDateField v-model="form.to" type="date" required /></label>
        </div>
        <label
          >复盘内容<ATextarea
            v-model:value="form.content"
            :auto-size="{ minRows: 5, maxRows: 12 }"
            placeholder="留下收获，写下下一步。"
        /></label>
      </template>
      <label v-if="kind === 'record'"
        >推进记录<ATextarea
          v-model:value="form.content"
          :auto-size="{ minRows: 3, maxRows: 8 }"
          required
          placeholder="记录这次推进了什么…"
      /></label>
      <template v-if="kind === 'outcome'">
        <label
          >成果说明<ATextarea
            v-model:value="form.summary"
            :auto-size="{ minRows: 3, maxRows: 8 }"
            required
            placeholder="这次完成了什么？"
        /></label>
        <ACheckbox
          v-for="(c, i) in form.criteriaResults"
          :key="i"
          class="todo-checkbox"
          v-model:checked="c.passed"
          >{{ c.label }}</ACheckbox
        >
        <ACheckbox
          v-if="!entity && form.occurrenceId"
          class="todo-checkbox"
          v-model:checked="completeOutcome"
          >同时完成关联行动</ACheckbox
        >
      </template>
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
      <template v-if="kind === 'calendarEvent'">
        <label
          >事件标题<AInput v-model:value="form.title" required placeholder="准备做什么？"
        /></label>
        <ACheckbox class="todo-checkbox" v-model:checked="form.allDay">全天事件</ACheckbox>
        <div class="todo-form-grid">
          <label>开始日期<ToDooDateField v-model="form.start.date" type="date" required /></label>
          <label v-if="!form.allDay"
            >开始时间<ToDooDateField v-model="form.start.time" type="time"
          /></label>
        </div>
        <AButton
          v-if="!form.end"
          class="todo-link"
          html-type="button"
          @click="
            form.end = { ...form.start, date: shiftToDooDate(form.start.date, form.allDay ? 1 : 0) }
          "
          type="link"
          >＋ 设置结束时间</AButton
        >
        <div v-if="form.end" class="todo-form-grid">
          <label
            >{{ form.allDay ? '结束日期（全天不含当日）' : '结束日期'
            }}<ToDooDateField v-model="form.end.date" type="date" required
          /></label>
          <label v-if="!form.allDay"
            >结束时间<ToDooDateField v-model="form.end.time" type="time"
          /></label>
        </div>
      </template>
      <template v-if="kind === 'timeBlock'">
        <label
          >安排标题<AInput v-model:value="form.title" placeholder="给这段时间起个名字"
        /></label>
        <p v-if="linkedAction" class="todo-form-context">关联行动：{{ linkedAction }}</p>
        <ACheckbox class="todo-checkbox" v-model:checked="form.allDay">全天安排</ACheckbox>
        <div class="todo-form-grid">
          <label>日期<ToDooDateField v-model="form.start.date" type="date" required /></label>
          <label v-if="!form.allDay"
            >时间<ToDooDateField v-model="form.start.time" type="time"
          /></label>
          <label v-if="!form.allDay"
            >时长（分钟）<AInputNumber
              aria-label="时长（分钟）"
              :value="form.durationMinutes"
              @update:value="form.durationMinutes = Number($event ?? 1)"
              :min="1"
              required
          /></label>
          <label v-if="form.allDay"
            >结束日期（不含当天）<ToDooDateField v-model="form.dateEndExclusive" type="date"
          /></label>
        </div>
      </template>
      <ToDooDisclosure
        ref="extraFields"
        v-if="
          [
            'list',
            'habit',
            'focusTopic',
            'anniversary',
            'review',
            'record',
            'outcome',
            'template',
            'timeBlock',
            'calendarEvent',
          ].includes(kind)
        "
        class="todo-form-extras"
      >
        <template #header
          ><span>补充信息</span><small class="todo-muted">{{ extraSummary }}</small></template
        >
        <div class="todo-disclosure-content todo-form">
          <label
            v-if="
              ['list', 'habit', 'focusTopic', 'anniversary', 'template', 'calendarEvent'].includes(
                kind,
              )
            "
            >{{ kind === 'calendarEvent' ? '事件说明' : '说明'
            }}<ATextarea
              v-model:value="form.description"
              :auto-size="{ minRows: 2, maxRows: 6 }"
              placeholder="选填"
          /></label>
          <template v-if="kind === 'list'">
            <label v-if="form.kind === 'list' && form.goalDate"
              >目标日期<ToDooDateField v-model="form.goalDate" type="date"
            /></label>
            <label v-if="form.kind === 'goal' || form.criteria"
              >成功标准<ATextarea
                v-model:value="form.criteria"
                :auto-size="{ minRows: 2, maxRows: 6 }"
                placeholder="怎样才算达成目标？"
            /></label>
            <ACheckbox class="todo-checkbox" v-model:checked="form.autoCompleteParents"
              >子项全完成后，自动完成父项</ACheckbox
            >
          </template>
          <label v-if="['habit', 'focusTopic', 'record', 'review'].includes(kind)"
            >关联目标或清单<ToDooSelect v-model="form.listId"
              ><option :value="null">不关联</option>
              <option
                v-for="l in model.state.snapshot?.lists.filter((l) => !l.deletedAt)"
                :key="l.id"
                :value="l.id"
              >
                {{ l.name }}
              </option></ToDooSelect
            ></label
          >
          <template v-if="kind === 'habit'">
            <div class="todo-form-grid">
              <label>结束日期<ToDooDateField v-model="form.endDate" type="date" /></label>
            </div>
            <div class="todo-form-grid">
              <label v-if="form.frequency === 'weekly'"
                >每周从<ToDooSelect v-model="form.weekStartsOn"
                  ><option :value="1">星期一</option>
                  <option :value="0">星期日</option></ToDooSelect
                ></label
              >
              <label
                >跳过的计算方式<ToDooSelect v-model="form.skipPolicy"
                  ><option value="break">中断连续达标</option>
                  <option value="exempt">免除本期，不中断</option></ToDooSelect
                ></label
              >
            </div>
            <label
              >时区<AInput v-model:value="form.timeZone" required placeholder="Asia/Shanghai"
            /></label>
          </template>
          <template v-if="kind === 'anniversary'">
            <div class="todo-form-grid">
              <label
                >计数方式<ToDooSelect v-model="form.countMode"
                  ><option value="exclude_today">不含今天</option>
                  <option value="include_today">包含今天</option></ToDooSelect
                ></label
              >
              <label v-if="form.repeatYearly && form.calendar === 'gregorian'"
                >闰日处理<ToDooSelect v-model="form.leapPolicy"
                  ><option value="previous_day">前一天</option>
                  <option value="next_day">后一天</option>
                  <option value="skip">跳过</option></ToDooSelect
                ></label
              >
              <label v-if="form.repeatYearly && form.calendar === 'lunar' && form.lunarLeapMonth"
                >闰月缺失时<ToDooSelect
                  :value="form.leapPolicy === 'skip' ? 'skip' : 'previous_day'"
                  @change="form.leapPolicy = $event"
                  ><option value="previous_day">使用非闰同月</option>
                  <option value="skip">跳过该年</option></ToDooSelect
                ></label
              >
            </div>
            <label>分类<AInput v-model:value="form.category" placeholder="选填" /></label>
          </template>
          <template v-if="kind === 'record'">
            <label
              >投入分钟<AInputNumber
                aria-label="投入分钟"
                :value="form.minutes"
                @update:value="form.minutes = $event == null ? null : Number($event)"
                :min="0"
            /></label>
            <label>记录时间<AInput v-model:value="form.occurredAt" required /></label>
          </template>
          <template v-if="kind === 'outcome'">
            <label
              >验证方式<ToDooSelect v-model="form.verification"
                ><option value="self_assessed">自评</option>
                <option value="practice">练习验证</option>
                <option value="reviewed">经过评审</option>
                <option value="delivered">已交付</option></ToDooSelect
              ></label
            >
            <ToDooNotes
              v-model="form.evidenceRefs"
              :tree="tree"
              role="output"
              label="成果证据"
              @open-note="emit('open-note', $event)"
            />
          </template>
          <label v-if="kind === 'timeBlock'"
            >关联行动<ToDooSelect v-model="form.occurrenceId"
              ><option :value="null">独立时间安排</option>
              <option
                v-for="o in model.state.snapshot?.occurrences.filter((o) => !o.deletedAt)"
                :key="o.id"
                :value="o.id"
              >
                {{ model.state.snapshot?.tasks.find((t) => t.id === o.taskId)?.title }} ·
                {{ o.scheduledDate || o.due?.date || '普通任务' }}
              </option></ToDooSelect
            ></label
          >
          <label v-if="kind === 'timeBlock' || kind === 'calendarEvent'"
            >时区<AInput v-model:value="form.start.timeZone" required
          /></label>
          <ToDooReminders v-if="kind === 'anniversary'" v-model="form.reminders" />
          <ToDooNotes
            v-if="Array.isArray(form.noteRefs)"
            v-model="form.noteRefs"
            :tree="tree"
            @open-note="emit('open-note', $event)"
          />
        </div>
      </ToDooDisclosure>
      <p v-if="validationError" class="todo-error" role="alert">{{ validationError }}</p>
      <p v-if="model.state.error" class="todo-error" role="alert">{{ model.state.error }}</p>
      <template #actions>
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
      </template>
    </ToDooFormLayout>
  </AModal>
</template>
