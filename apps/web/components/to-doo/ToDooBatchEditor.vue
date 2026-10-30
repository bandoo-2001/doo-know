<script setup lang="ts">
import {
  Button as AButton,
  Checkbox as ACheckbox,
  InputNumber as AInputNumber,
  Modal as AModal,
  Textarea as ATextarea,
} from 'ant-design-vue';
import ToDooSelect from './ToDooSelect.vue';
import ToDooDateField from './ToDooDateField.vue';
import { computed, onMounted, reactive, ref } from 'vue';
import type { TreeEntry } from '../../../../shared/contracts';
import type { ToDooTask } from '../../../../shared/to-doo-contracts';
import { toDooLocalDate, type ToDooWorkbench } from '../../to-doo-workbench';
import ToDooNotes from './ToDooNotes.vue';
const props = defineProps<{ model: ToDooWorkbench; tree: TreeEntry[] }>();
const emit = defineEmits<{ close: []; 'open-note': [id: string] }>();
const state = props.model.state,
  loading = ref(true),
  includeChildren = ref(true);
const enabled = reactive({
  priority: false,
  importance: false,
  tags: false,
  section: false,
  notes: false,
  estimate: false,
  criteria: false,
  repeat: false,
});
const patch = reactive({
  priority: 'normal' as ToDooTask['priority'],
  importance: 'normal' as ToDooTask['importance'],
  tagIds: [] as string[],
  sectionId: null as string | null,
  noteRefs: [] as ToDooTask['noteRefs'],
  estimateMinutes: 30,
  criteria: '',
});
const recurrence = reactive({
  frequency: 'daily',
  interval: 1,
  anchorDate: toDooLocalDate(),
  until: '',
  time: '09:00',
  weekdays: [1, 2, 3, 4, 5],
  timeZone: state.snapshot?.settings.timeZone || 'UTC',
});
onMounted(async () => {
  for (const id of state.selectedIds) await props.model.ensureTask(id);
  loading.value = false;
});
const affected = computed(() => {
  const ids = new Set(state.selectedIds);
  if (includeChildren.value) {
    let grew = true;
    while (grew) {
      grew = false;
      for (const task of state.snapshot?.tasks || [])
        if (task.parentTaskId && ids.has(task.parentTaskId) && !ids.has(task.id)) {
          ids.add(task.id);
          grew = true;
        }
    }
  }
  return [...ids];
});
async function save() {
  const update: Partial<ToDooTask> = {};
  if (enabled.priority) update.priority = patch.priority;
  if (enabled.importance) update.importance = patch.importance;
  if (enabled.tags) update.tagIds = [...patch.tagIds];
  if (enabled.section) update.sectionId = patch.sectionId;
  if (enabled.notes) update.noteRefs = [...patch.noteRefs];
  if (enabled.estimate) update.estimateMinutes = patch.estimateMinutes;
  if (enabled.criteria) update.criteria = patch.criteria;
  if (enabled.repeat)
    update.recurrence = recurrence.frequency
      ? {
          id: crypto.randomUUID(),
          frequency: recurrence.frequency as any,
          interval: recurrence.interval,
          anchorDate: recurrence.anchorDate,
          time: recurrence.time || null,
          timeZone: recurrence.timeZone,
          weekdays: recurrence.frequency === 'weekly' ? recurrence.weekdays : [],
          until: recurrence.until || null,
          count: null,
          shortMonth: 'last_day',
          excludedDates: [],
          additionalDates: [],
          endedAt: null,
          completionUnit: 'day',
        }
      : null;
  if (!Object.keys(update).length) {
    state.error = '请先选择需要修改的字段';
    return;
  }
  const result = await props.model.batch('patch', {
    patch: update,
    includeDescendants: includeChildren.value,
  });
  if (result) emit('close');
}
</script>
<template>
  <AModal
    :open="true"
    :footer="null"
    :mask-closable="false"
    :closable="false"
    wrap-class-name="todo-ant-modal"
    title="批量编辑任务"
    @cancel="emit('close')"
  >
    <AButton
      class="ant-modal-close"
      type="text"
      html-type="button"
      aria-label="关闭批量编辑"
      @click="emit('close')"
      >×</AButton
    >
    <p class="todo-muted">
      选中 {{ state.selectedIds.length }} 项，将修改
      {{ affected.length }} 项。未勾选的字段保持原值。
    </p>

    <form class="todo-form" @submit.prevent="save">
      <ACheckbox class="todo-checkbox" v-model:checked="includeChildren"
        >同时处理全部后代任务</ACheckbox
      >
      <div class="todo-bulk-field">
        <ACheckbox class="todo-checkbox" v-model:checked="enabled.priority">优先级</ACheckbox
        ><ToDooSelect v-model="patch.priority" :disabled="!enabled.priority">
          <option value="none">无优先级</option>
          <option value="low">低</option>
          <option value="normal">中</option>
          <option value="high">高</option>
        </ToDooSelect>
      </div>
      <div class="todo-bulk-field">
        <ACheckbox class="todo-checkbox" v-model:checked="enabled.importance">重要程度</ACheckbox
        ><ToDooSelect v-model="patch.importance" :disabled="!enabled.importance">
          <option value="normal">普通</option>
          <option value="important">重要</option>
        </ToDooSelect>
      </div>
      <ACheckbox class="todo-checkbox" v-model:checked="enabled.tags">替换标签</ACheckbox
      ><ToDooSelect v-if="enabled.tags" v-model="patch.tagIds" multiple aria-label="批量标签">
        <option
          v-for="t in state.snapshot?.tags.filter((t) => !t.deletedAt)"
          :key="t.id"
          :value="t.id"
        >
          {{ t.name }}
        </option></ToDooSelect
      ><ACheckbox class="todo-checkbox" v-model:checked="enabled.section">替换章节</ACheckbox
      ><ToDooSelect v-if="enabled.section" v-model="patch.sectionId" aria-label="批量章节">
        <option :value="null">不分章节</option>
        <option
          v-for="s in state.snapshot?.sections.filter((s) => !s.deletedAt)"
          :key="s.id"
          :value="s.id"
        >
          {{ s.name }}
        </option></ToDooSelect
      ><ACheckbox class="todo-checkbox" v-model:checked="enabled.notes">替换关联资料</ACheckbox
      ><ToDooNotes
        v-if="enabled.notes"
        v-model="patch.noteRefs"
        :tree="tree"
        @open-note="emit('open-note', $event)"
      /><ACheckbox class="todo-checkbox" v-model:checked="enabled.estimate">替换预计分钟</ACheckbox
      ><AInputNumber
        v-if="enabled.estimate"
        :value="patch.estimateMinutes"
        @update:value="patch.estimateMinutes = Number($event ?? 0)"
        :min="0"
        aria-label="批量预计分钟"
      /><ACheckbox class="todo-checkbox" v-model:checked="enabled.criteria">替换完成标准</ACheckbox
      ><ATextarea
        v-if="enabled.criteria"
        v-model:value="patch.criteria"
        :rows="3"
        aria-label="批量完成标准"
      ></ATextarea
      ><ACheckbox class="todo-checkbox" v-model:checked="enabled.repeat"
        >调整整个重复系列（保留完成历史）</ACheckbox
      >
      <div v-if="enabled.repeat" class="todo-form">
        <label
          >重复规则<ToDooSelect v-model="recurrence.frequency">
            <option value="">取消未来重复</option>
            <option value="daily">每天</option>
            <option value="weekly">每周</option>
            <option value="monthly">每月</option>
            <option value="yearly">每年</option>
            <option value="after_completion">完成后重复</option>
          </ToDooSelect></label
        >
        <div v-if="recurrence.frequency" class="todo-form-grid">
          <label
            >间隔<AInputNumber
              aria-label="间隔"
              :value="recurrence.interval"
              @update:value="recurrence.interval = Number($event ?? 1)"
              :min="1" /></label
          ><label>开始日期<ToDooDateField v-model="recurrence.anchorDate" type="date" /></label
          ><label>重复时间<ToDooDateField v-model="recurrence.time" type="time" /></label
          ><label>结束日期<ToDooDateField v-model="recurrence.until" type="date" /></label>
        </div>
        <label v-if="recurrence.frequency === 'weekly'"
          >每周日期<ToDooSelect v-model="recurrence.weekdays" multiple>
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
      <p v-if="state.error" class="todo-error" role="alert">{{ state.error }}</p>
      <div class="todo-actions">
        <AButton class="todo-button" html-type="button" @click="emit('close')">取消</AButton
        ><AButton
          class="todo-button todo-primary"
          html-type="submit"
          :disabled="loading || state.busy"
          type="primary"
        >
          确认修改 {{ affected.length }} 项
        </AButton>
      </div>
    </form>
  </AModal>
</template>
