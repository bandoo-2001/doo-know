<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import type { TreeEntry } from '../../../../shared/contracts';
import type { ToDooEntityKind } from '../../../../shared/to-doo-contracts';
import { shiftToDooDate, toDooLocalDate, type ToDooWorkbench } from '../../to-doo-workbench';
import ToDooNotes from './ToDooNotes.vue';
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
function close() {
  if (JSON.stringify(form) !== baseline && !confirm('表单尚未保存，确定关闭并放弃这些输入？'))
    return;
  emit('close');
}
async function save() {
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
  if (!props.entity || !confirm('将这条记录移入回收站？相关内容会保留以供恢复。')) return;
  const result = await props.model.removeEntity(props.kind, props.entity as any);
  if (result) emit('close');
}
defineExpose({
  hasUnsavedChanges: () => JSON.stringify(form) !== baseline || completeOutcome.value,
});
</script>
<template>
  <div class="todo-modal-backdrop" @click.self="close" @keydown.esc.stop="close">
    <section
      class="todo-modal"
      role="dialog"
      aria-modal="true"
      :aria-label="(entity ? '编辑' : '新建') + (label[kind] || '记录')"
    >
      <header class="todo-between">
        <h2>{{ entity ? '编辑' : '新建' }}{{ label[kind] || '记录' }}</h2>
        <button type="button" class="todo-icon-button" aria-label="关闭编辑" @click="close">
          ×
        </button>
      </header>
      <form class="todo-form" @submit.prevent="save">
        <label v-if="hasName"
          >名称<input v-model="form.name" required maxlength="256" autofocus
        /></label>
        <label v-if="kind === 'list'"
          >类型<select v-model="form.kind">
            <option value="goal">目标</option>
            <option value="list">清单</option>
          </select></label
        >
        <label v-if="['list', 'habit', 'anniversary', 'template'].includes(kind)"
          >说明<textarea v-model="form.description" rows="3"></textarea>
        </label>
        <label v-if="kind === 'list'">目标日期<input v-model="form.goalDate" type="date" /></label>
        <label v-if="kind === 'list'" class="todo-checkbox"
          ><input
            v-model="form.autoCompleteParents"
            type="checkbox"
          />子项全完成后，自动完成父项</label
        ><label v-if="kind === 'list'"
          >成功标准<textarea
            v-model="form.criteria"
            rows="3"
            placeholder="怎样才算达成目标？"
          ></textarea>
        </label>
        <label v-if="['habit', 'record', 'review', 'section'].includes(kind)"
          >关联目标或清单<select v-model="form.listId" :required="kind === 'section'">
            <option :value="null">不关联</option>
            <option
              v-for="l in model.state.snapshot?.lists.filter((l) => !l.deletedAt)"
              :key="l.id"
              :value="l.id"
            >
              {{ l.name }}
            </option>
          </select></label
        >
        <template v-if="kind === 'habit'"
          ><div class="todo-form-grid">
            <label
              >重复频率<select v-model="form.frequency">
                <option value="daily">每天</option>
                <option value="weekly">每周</option>
                <option value="monthly">每月</option>
              </select></label
            ><label>开始日期<input v-model="form.startDate" type="date" required /></label
            ><label
              >目标数量<input
                v-model.number="form.target"
                type="number"
                min="0.1"
                step="any"
                required /></label
            ><label>单位<input v-model="form.unit" maxlength="40" /></label>
          </div>
          <label>规则生效日期<input v-model="form.effectiveFrom" type="date" required /></label>
          <p class="todo-muted todo-small">
            目标、周期和单位从此日期起生效；之前的记录按当时规则计算。每周、每月目标在所属周期内累计。
          </p>
          <div class="todo-form-grid">
            <label
              >每周从<select v-model.number="form.weekStartsOn">
                <option :value="1">星期一</option>
                <option :value="0">星期日</option>
              </select></label
            ><label
              >跳过的计算方式<select v-model="form.skipPolicy">
                <option value="break">中断连续达标</option>
                <option value="exempt">免除本期，不中断</option>
              </select></label
            >
          </div>
          <label>时区<input v-model="form.timeZone" required placeholder="Asia/Shanghai" /></label
          ><label>结束日期<input v-model="form.endDate" type="date" /></label
        ></template>
        <template v-if="kind === 'anniversary'"
          ><div class="todo-form-grid">
            <label>日期<input v-model="form.date" type="date" required /></label
            ><label
              >历法<select v-model="form.calendar">
                <option value="gregorian">公历</option>
                <option value="lunar">农历</option>
              </select></label
            ><label
              >计数方式<select v-model="form.countMode">
                <option value="exclude_today">不含今天</option>
                <option value="include_today">包含今天</option>
              </select></label
            ><label
              >闰日处理<select v-model="form.leapPolicy">
                <option value="previous_day">前一天</option>
                <option value="next_day">后一天</option>
                <option value="skip">跳过</option>
              </select></label
            >
          </div>
          <label class="todo-checkbox"
            ><input v-model="form.repeatYearly" type="checkbox" />每年重复</label
          ><label v-if="form.calendar === 'lunar'" class="todo-checkbox"
            ><input v-model="form.lunarLeapMonth" type="checkbox" />农历闰月</label
          ><label>分类<input v-model="form.category" /></label
        ></template>
        <template v-if="kind === 'review'"
          ><div class="todo-form-grid">
            <label>开始日期<input v-model="form.from" type="date" required /></label
            ><label>结束日期<input v-model="form.to" type="date" required /></label>
          </div>
          <label
            >复盘内容<textarea
              v-model="form.content"
              rows="8"
              placeholder="这段时间留下了什么？哪些值得继续？下次做一个什么调整？"
            ></textarea></label
        ></template>
        <template v-if="kind === 'record'"
          ><label>推进记录<textarea v-model="form.content" rows="5" required></textarea></label
          ><label>投入分钟<input v-model.number="form.minutes" type="number" min="0" /></label
          ><label>记录时间<input v-model="form.occurredAt" required /></label
        ></template>
        <label v-if="kind === 'outcome' && !entity && form.occurrenceId" class="todo-checkbox"
          ><input v-model="completeOutcome" type="checkbox" />同时完成关联行动</label
        ><template v-if="kind === 'outcome'"
          ><label>成果说明<textarea v-model="form.summary" rows="5" required></textarea></label
          ><label
            >验证方式<select v-model="form.verification">
              <option value="self_assessed">自评</option>
              <option value="practice">练习验证</option>
              <option value="reviewed">经过评审</option>
              <option value="delivered">已交付</option>
            </select></label
          ><label v-for="(c, i) in form.criteriaResults" :key="i" class="todo-checkbox"
            ><input v-model="c.passed" type="checkbox" />{{ c.label }}</label
          ><ToDooNotes
            v-model="form.evidenceRefs"
            :tree="tree"
            role="output"
            label="成果证据"
            @open-note="emit('open-note', $event)"
        /></template>
        <template v-if="kind === 'view'"
          ><label
            >展示方式<select v-model="form.mode">
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
            </select></label
          ><label>搜索条件<input v-model="form.filter.query" /></label
          ><label
            >排序<select v-model="form.sort">
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
            </select></label
          >
          <p class="todo-muted todo-small">当前已选清单、标签与状态条件将一并保存。</p>
          <ToDooFilterGroup v-if="form.filter.group" v-model="form.filter.group" :model="model"
        /></template>
        <label v-if="kind === 'template'"
          >任务标题（每行一项）<textarea v-model="templateLines" rows="8" required></textarea>
        </label>
        <template v-if="kind === 'calendarEvent'"
          ><label>事件标题<input v-model="form.title" required /></label
          ><label>事件说明<textarea v-model="form.description" rows="3"></textarea></label>
          <div class="todo-form-grid">
            <label>开始日期<input v-model="form.start.date" type="date" required /></label
            ><label>开始时间<input v-model="form.start.time" type="time" /></label>
          </div>
          <label>时区<input v-model="form.start.timeZone" required /></label
          ><label class="todo-checkbox"
            ><input v-model="form.allDay" type="checkbox" />全天事件</label
          ><button
            v-if="!form.end"
            class="todo-link"
            type="button"
            @click="form.end = { ...form.start }"
          >
            ＋ 设置结束时间
          </button>
          <div v-if="form.end" class="todo-form-grid">
            <label
              >结束日期（全天不含当日）<input v-model="form.end.date" type="date" required /></label
            ><label>结束时间<input v-model="form.end.time" type="time" /></label></div
        ></template>
        <template v-if="kind === 'timeBlock'"
          ><label
            >关联行动<select v-model="form.occurrenceId">
              <option :value="null">独立时间安排</option>
              <option
                v-for="o in model.state.snapshot?.occurrences.filter((o) => !o.deletedAt)"
                :key="o.id"
                :value="o.id"
              >
                {{ model.state.snapshot?.tasks.find((t) => t.id === o.taskId)?.title }} ·
                {{ o.scheduledDate || o.due?.date || '普通任务' }}
              </option>
            </select></label
          ><label>安排标题<input v-model="form.title" /></label>
          <div class="todo-form-grid">
            <label>日期<input v-model="form.start.date" type="date" required /></label
            ><label>时间<input v-model="form.start.time" type="time" /></label
            ><label
              >时长（分钟）<input
                v-model.number="form.durationMinutes"
                type="number"
                min="1"
                required /></label
            ><label>时区<input v-model="form.start.timeZone" required /></label>
          </div>
          <label class="todo-checkbox"
            ><input v-model="form.allDay" type="checkbox" />全天安排</label
          ><label v-if="form.allDay"
            >结束日期（不含当天）<input v-model="form.dateEndExclusive" type="date" /></label
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
          <button
            v-if="entity"
            type="button"
            class="todo-button todo-danger"
            :disabled="model.state.busy"
            @click="remove"
          >
            移入回收站</button
          ><span class="todo-spacer"></span
          ><button type="button" class="todo-button" @click="close">取消</button
          ><button type="submit" class="todo-button todo-primary" :disabled="model.state.busy">
            {{ model.state.busy ? '保存中…' : '保存' }}
          </button>
        </footer>
      </form>
    </section>
  </div>
</template>
