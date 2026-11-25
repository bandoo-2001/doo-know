<script setup lang="ts">
import ToDooDateField from './ToDooDateField.vue';
import { Button as AButton, Input as AInput, Popover as APopover } from 'ant-design-vue';
import ToDooSelect from './ToDooSelect.vue';
import ToDooTimeModeFields from './ToDooTimeModeFields.vue';
import { createToDooPopupEscapeBoundary } from '../../to-doo-controls';

import { computed, nextTick, onMounted, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import type { ToDooWorkbench, ToDooCreateSeed, ToDooNewTaskDraft } from '../../to-doo-workbench';
import { parseToDooQuickEntry, shiftToDooDate, toDooDisplayTime, toDooLocalDate } from '../../to-doo-workbench';
import {
  isToDooTimeZone,
  prepareToDooQuickDraft,
  toDooDateLabel,
  toDooDraftPayload,
  toDooDraftRepeatClock,
  type ToDooTaskPlacement,
} from '../../to-doo-presentation';
import ToDooIcon from './ToDooIcon.vue';
const props = defineProps<{
  model: ToDooWorkbench;
  listId?: string;
  defaultDate?: string;
  seed?: ToDooCreateSeed;
}>();
const emit = defineEmits<{ expand: []; created: [value: ToDooTaskPlacement] }>();
const captureForm = ref<HTMLFormElement>();
function captureInput() {
  return captureForm.value?.querySelector<HTMLInputElement>('input[aria-label="快速添加任务"]');
}
function focusInput() {
  const input = captureInput();
  if (!input || input.disabled || input.readOnly || !input.getClientRects().length) return false;
  input.focus();
  return document.activeElement === input;
}
defineExpose({ focusInput });
const focused = ref(false);
let pointerDown = false,
  pendingBlur = false;
let blurTimer: ReturnType<typeof setTimeout> | undefined;
const state = props.model.state;
const draft = computed(() => props.model.newTaskDraft(undefined, props.listId, props.seed));
const listName = computed(() => props.model.taskLists().find((list) => list.id === draft.value.listId)?.name);
const pendingCapture = computed(() => {
  const pending = state.pendingMutation;
  const capture = state.pendingQuickCapture;
  return pending?.action === 'create_task' && capture?.requestId === pending.requestId &&
    state.newTaskDrafts[capture.draftKey] === draft.value ? pending : null;
});
const submitting = shallowRef<ToDooNewTaskDraft>();
const waitingForReceipt = computed(() => !!state.pendingMutation ||
  (state.busy && (!submitting.value || submitting.value === draft.value)));
const submitBlocked = computed(() => !!submitting.value || state.busy || state.preparingTaskAction ||
  (!!state.pendingMutation && !pendingCapture.value));
const feedback = ref('');
let feedbackTimer: ReturnType<typeof setTimeout> | undefined;
function clearFeedback() {
  clearTimeout(feedbackTimer);
  feedback.value = '';
}
watch([() => draft.value.title, () => props.listId, () => props.defaultDate, () => state.snapshot?.datasetId], clearFeedback);
const literalTitle = computed({ get: () => !!draft.value.literalTitle, set: (value: boolean) => { draft.value.literalTitle = value; } });
const composing = ref(false);
const chipOpen = ref<string | null>(null);
const chipEscape = createToDooPopupEscapeBoundary();
function chipEditorKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return;
  chipEscape.bubble(event);
  if (event.cancelBubble) return;
  event.preventDefault();
  event.stopPropagation();
  closeChip();
}
let chipOpener: HTMLElement | undefined;
function rememberChip(event: MouseEvent) { chipOpener = event.currentTarget as HTMLElement; }
function setChipOpen(kind: string, open: boolean) {
  if (open && !normalize()) return;
  chipOpen.value = open ? kind : null;
}
function closeChip() {
  chipOpen.value = null;
  nextTick(() => chipOpener?.isConnected && chipOpener.focus());
}
const originalDraft = ref<{ title: string; draft: typeof draft.value } | null>(null);
watch(() => [draft.value, draft.value.title] as const, ([current], [previous]) => {
  if (current === previous) literalTitle.value = false;
  originalDraft.value = null;
}, { flush: 'sync' });
const zone = computed(() => state.snapshot?.settings.timeZone || 'UTC');
const today = computed(() => toDooLocalDate(new Date(), zone.value));
const prepared = computed(() =>
  prepareToDooQuickDraft(
    draft.value,
    today.value,
    state.snapshot?.tags.filter((t) => !t.deletedAt) || [],
    props.defaultDate,
  ),
);
const repeatClock = computed(() => toDooDraftRepeatClock(draft.value));
const recognized = computed(() => !literalTitle.value && parseToDooQuickEntry(
  draft.value.title, today.value, state.snapshot?.tags.filter((tag) => !tag.deletedAt) || [],
).recognized);
function normalize() {
  if (state.busy || state.pendingMutation) return false;
  const original = originalDraft.value || {
    title: draft.value.title,
    draft: JSON.parse(JSON.stringify(draft.value)),
  };
  Object.assign(draft.value, prepared.value);
  originalDraft.value = original;
  literalTitle.value = true;
  return true;
}
function useOriginal() {
  if (state.busy || state.pendingMutation) return;
  if (originalDraft.value) {
    const original = originalDraft.value;
    Object.assign(draft.value, original.draft, { title: original.title });
  }
  originalDraft.value = null;
  literalTitle.value = true;
}
function removeDate(kind: 'plan' | 'due') {
  if (!normalize()) return;
  if (kind === 'plan') Object.assign(draft.value, {
    planDate: '', planTime: '', planTimeMode: 'fixed', planTimeZone: '', planDateCleared: true,
  });
  else Object.assign(draft.value, {
    dueDate: '', dueTime: '', dueTimeMode: 'fixed', dueTimeZone: '', planDateCleared: true,
  });
}
function removeRepeat() {
  if (normalize()) Object.assign(draft.value, { frequency: null, weekdays: [] });
}
function removeTag(id: string) {
  if (normalize()) draft.value.tagIds = draft.value.tagIds.filter((tagId) => tagId !== id);
}
function correctTag(id: string, value: string | number) {
  if (normalize()) draft.value.tagIds = [...new Set(draft.value.tagIds.map((tagId) => tagId === id ? String(value) : tagId))];
}
function correctRepeat(value: string | number | null) {
  if (!normalize()) return;
  draft.value.frequency = value === 'daily' || value === 'weekly' ? value : null;
  if (value === 'weekly' && !draft.value.weekdays.length) draft.value.weekdays = [1];
}
const expanded = computed(() => focused.value || !!draft.value.title.trim());
function setPlanDate(value: string) {
  if (state.busy || state.pendingMutation) return;
  if (!normalize()) return;
  Object.assign(draft.value, {
    planDate: value,
    planDateCleared: !value,
    planTime: value ? prepared.value.planTime : '',
    ...(!value ? { planTimeMode: 'fixed', planTimeZone: '' } : {}),
  });
}
function leaveFocus(event: FocusEvent) {
  if ((event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) return;
  if (pointerDown) pendingBlur = true;
  else collapseCapture();
}
function collapseCapture() {
  pendingBlur = false;
  if (!captureForm.value?.contains(document.activeElement)) focused.value = false;
}
function beginPointer() {
  pointerDown = true;
}
function endPointer() {
  pointerDown = false;
  // Collapsing between pointerdown and click moves the toolbar away from the pointer.
  if (pendingBlur) blurTimer = setTimeout(collapseCapture, 0);
}
onMounted(() => {
  document.addEventListener('pointerdown', beginPointer, true);
  document.addEventListener('pointerup', endPointer, true);
  document.addEventListener('pointercancel', endPointer, true);
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', beginPointer, true);
  document.removeEventListener('pointerup', endPointer, true);
  document.removeEventListener('pointercancel', endPointer, true);
  clearTimeout(blurTimer);
  clearTimeout(feedbackTimer);
  clearTimeout(compositionTimer);
});
let compositionEnter = false;
let compositionTimer: ReturnType<typeof setTimeout> | undefined;
function enter(event: KeyboardEvent) {
  if (composing.value || event.isComposing || event.keyCode === 229) {
    // Let the IME accept its candidate, while ignoring an implicit form submit from the same key.
    compositionEnter = true;
    clearTimeout(compositionTimer);
    compositionTimer = setTimeout(() => { compositionEnter = false; }, 0);
    return;
  }
  event.preventDefault();
  if (!event.repeat) void add();
}
async function add() {
  if (composing.value || compositionEnter || !draft.value.title.trim() || submitBlocked.value) return;
  const payload = pendingCapture.value?.payload || toDooDraftPayload(prepared.value, zone.value);
  if (!pendingCapture.value && [payload.plan, payload.due, payload.recurrence].some(
    (entry) => entry?.time && !isToDooTimeZone(entry.timeZone || zone.value),
  )) {
    state.error = '请检查计划、截止或重复规则中的时区。';
    return;
  }
  const scope = props.listId;
  const dataset = state.snapshot?.datasetId;
  clearFeedback();
  captureInput()?.focus();
  submitting.value = draft.value;
  try {
    const result = await props.model.createTask(payload, draft.value);
    if (!captureForm.value || props.listId !== scope || state.snapshot?.datasetId !== dataset) return;
    if (result) {
      const taskId = result.ids.find((id) => result.snapshot.tasks.some((task) => task.id === id)) ||
        result.changed.find(entry => entry.kind === 'task' && result.ids.includes(entry.id))?.id;
      if (taskId) {
        const plan = payload.plan;
        emit('created', {
          taskId,
          title: payload.title,
          listId: payload.listId || null,
          planDates: plan ? [toDooDisplayTime({
            ...plan, time: plan.time ?? null, timeZone: plan.timeZone ?? 'UTC',
          }, zone.value).date] : [],
        });
      }
      feedback.value = `已添加「${payload.title}」`;
      feedbackTimer = setTimeout(clearFeedback, 5000);
    } else if (!pendingCapture.value) {
      feedback.value = '输入已保留，可修改后再次添加';
    }
  } finally {
    submitting.value = undefined;
  }
  await nextTick();
  if (pendingCapture.value && captureForm.value?.contains(document.activeElement))
    captureForm.value.querySelector<HTMLButtonElement>('button[type="submit"]')?.focus();
}
</script>
<template>
  <form
    ref="captureForm"
    class="todo-quick-add"
    aria-label="快速添加任务"
    @submit.prevent="add"
    @focusin="focused = true"
    @focusout="leaveFocus"
  >
    <div class="todo-quick-add-line">
      <ToDooIcon name="plus" :size="17" />
      <AInput
        v-model:value="draft.title"
        aria-label="快速添加任务"
        :placeholder="listName ? `添加任务至「${listName}」` : '添加任务…'"
        :maxlength="256"
        autocomplete="off"
        :readonly="waitingForReceipt"
        @compositionstart="composing = true"
        @compositionend="composing = false"
        @keydown.enter="enter"
      />
      <kbd v-if="!expanded && !draft.title && !waitingForReceipt" class="todo-capture-shortcut" aria-hidden="true">Q</kbd>
      <AButton
        v-if="draft.title.trim()"
        html-type="submit"
        class="todo-button todo-primary"
        :disabled="submitBlocked"
        type="primary"
      >
        {{ submitting ? '添加中…' : pendingCapture ? '重试添加' : '添加任务' }}
      </AButton>
      <AButton
        html-type="button"
        v-if="expanded"
        class="todo-quick-details"
        aria-label="详细添加"
        title="填写任务详情"
        :disabled="state.busy || !!state.pendingMutation"
        @click="emit('expand')"
        type="text"
      >
        详情
      </AButton>
    </div>
    <div class="todo-capture-feedback" aria-live="polite" aria-atomic="true">
      <span v-if="feedback || (pendingCapture && !state.busy)" :title="feedback || undefined">
        {{ feedback || '添加结果待核对，原输入已保留' }}
      </span>
    </div>
    <div v-if="draft.title.trim()" class="todo-quick-add-hint" aria-label="任务输入属性">
      <span v-if="prepared.planDate" class="todo-capture-chip">
        <APopover :open="chipOpen === 'plan'" trigger="click" title="计划" overlay-class-name="todo-ant-popup" @open-change="(open: boolean) => setChipOpen('plan', open)">
          <AButton type="text" @click="rememberChip" @keydown.esc.stop.prevent="closeChip" aria-label="纠正计划日期">计划 {{ toDooDateLabel(prepared.planDate, today) }} {{ prepared.planTime }}</AButton>
          <template #content>
            <div class="todo-capture-chip-editor" @keydown.capture="chipEscape.capture" @keydown="chipEditorKeydown">
              <label>计划日期<ToDooDateField v-model="draft.planDate" type="date" aria-label="纠正计划日期" /></label>
              <label>计划时间<ToDooDateField v-model="draft.planTime" type="time" aria-label="纠正计划时间" /></label>
              <ToDooTimeModeFields v-if="draft.planTime" v-model:time-mode="draft.planTimeMode"
                v-model:time-zone="draft.planTimeZone" :workspace-zone="zone"
                :disabled="waitingForReceipt" label="计划" />
            </div>
          </template>
        </APopover>
        <AButton type="text" aria-label="移除计划识别" @click="removeDate('plan')">×</AButton>
      </span>
      <span v-if="prepared.dueDate" class="todo-capture-chip">
        <APopover :open="chipOpen === 'due'" trigger="click" title="截止" overlay-class-name="todo-ant-popup" @open-change="(open: boolean) => setChipOpen('due', open)">
          <AButton type="text" @click="rememberChip" @keydown.esc.stop.prevent="closeChip" aria-label="纠正截止日期">截止 {{ toDooDateLabel(prepared.dueDate, today) }} {{ prepared.dueTime }}</AButton>
          <template #content>
            <div class="todo-capture-chip-editor" @keydown.capture="chipEscape.capture" @keydown="chipEditorKeydown">
              <label>截止日期<ToDooDateField v-model="draft.dueDate" type="date" aria-label="纠正截止日期" /></label>
              <label>截止时间<ToDooDateField v-model="draft.dueTime" type="time" aria-label="纠正截止时间" /></label>
              <ToDooTimeModeFields v-if="draft.dueTime" v-model:time-mode="draft.dueTimeMode"
                v-model:time-zone="draft.dueTimeZone" :workspace-zone="zone"
                :disabled="waitingForReceipt" label="截止" />
            </div>
          </template>
        </APopover>
        <AButton type="text" aria-label="移除截止识别" @click="removeDate('due')">×</AButton>
      </span>
      <span v-if="prepared.frequency" class="todo-capture-chip">
        <APopover :open="chipOpen === 'repeat'" trigger="click" title="重复" overlay-class-name="todo-ant-popup" @open-change="(open: boolean) => setChipOpen('repeat', open)">
          <AButton type="text" @click="rememberChip" @keydown.esc.stop.prevent="closeChip" aria-label="纠正重复规则">{{ prepared.frequency === 'daily' ? '每天重复' : '每周' + '日一二三四五六'[prepared.weekdays[0] ?? 1] + '重复' }}</AButton>
          <template #content>
            <div class="todo-capture-chip-editor" @keydown.capture="chipEscape.capture" @keydown="chipEditorKeydown">
              <label>重复<ToDooSelect :value="draft.frequency" aria-label="纠正重复规则" @change="correctRepeat">
                <option :value="null">不重复</option><option value="daily">每天</option><option value="weekly">每周</option>
              </ToDooSelect></label>
              <label v-if="draft.frequency === 'weekly'">星期
                <ToDooSelect :value="draft.weekdays[0] ?? 1" aria-label="重复星期" @change="draft.weekdays = [Number($event)]">
                  <option v-for="(day, index) in ['日', '一', '二', '三', '四', '五', '六']" :key="index" :value="index">星期{{ day }}</option>
                </ToDooSelect>
              </label>
              <template v-if="draft.frequency && repeatClock.time">
                <small class="todo-form-help">
                  重复时间 {{ repeatClock.time }}，取自{{ repeatClock.source === 'plan' ? '计划' : '截止' }}时间。
                </small>
                <ToDooTimeModeFields :time-mode="repeatClock.timeMode" v-model:time-zone="draft.recurrenceTimeZone"
                  :default-zone="repeatClock.timeZone" :workspace-zone="zone" :disabled="waitingForReceipt"
                  label="重复" @update:time-mode="draft.recurrenceTimeMode = $event" />
              </template>
            </div>
          </template>
        </APopover>
        <AButton type="text" aria-label="移除重复识别" @click="removeRepeat">×</AButton>
      </span>
      <span v-for="id in prepared.tagIds" :key="id" class="todo-capture-chip">
        <APopover :open="chipOpen === 'tag-' + id" trigger="click" title="标签" overlay-class-name="todo-ant-popup" @open-change="(open: boolean) => setChipOpen('tag-' + id, open)">
          <AButton type="text" :aria-label="'纠正标签 ' + (state.snapshot?.tags.find((tag) => tag.id === id)?.name || id)" @click="rememberChip" @keydown.esc.stop.prevent="closeChip">{{ state.snapshot?.tags.find((tag) => tag.id === id)?.name || '标签' }}</AButton>
          <template #content><div class="todo-capture-chip-editor" @keydown.capture="chipEscape.capture" @keydown="chipEditorKeydown"><label>标签<ToDooSelect :value="id" aria-label="纠正标签" @change="correctTag(id, $event)"><option v-for="tag in state.snapshot?.tags.filter((entry) => !entry.deletedAt)" :key="tag.id" :value="tag.id">{{ tag.name }}</option></ToDooSelect></label></div></template>
        </APopover>
        <AButton type="text" :aria-label="'移除标签 ' + (state.snapshot?.tags.find((tag) => tag.id === id)?.name || id)" @click="removeTag(id)">×</AButton>
      </span>
      <AButton v-if="recognized || originalDraft" type="link" class="todo-capture-literal" @click="useOriginal">按原文输入</AButton>
    </div>
    <div v-if="expanded" class="todo-composer-actions">
      <label class="todo-composer-date">
        <ToDooIcon name="calendar" :size="15" /><span>计划</span>
        <ToDooDateField
          type="date"
          aria-label="计划日期"
          :value="prepared.planDate"
          :disabled="state.busy || !!state.pendingMutation"
          @input="setPlanDate($event)"
        />
      </label>
      <AButton
        html-type="button"
        class="todo-composer-date-button"
        aria-label="计划到今天"
        :aria-pressed="prepared.planDate === today"
        :disabled="state.busy || !!state.pendingMutation"
        @click="setPlanDate(today)"
        type="text"
      >
        今天
      </AButton>
      <AButton
        html-type="button"
        class="todo-composer-date-button"
        aria-label="计划到明天"
        :aria-pressed="prepared.planDate === shiftToDooDate(today, 1)"
        :disabled="state.busy || !!state.pendingMutation"
        @click="setPlanDate(shiftToDooDate(today, 1))"
        type="text"
      >
        明天
      </AButton>
    </div>
  </form>
</template>

<style scoped>
.todo-capture-shortcut {
  display: none;
}
@media (hover: hover) and (pointer: fine) {
  .to-doo-workspace:not(.todo-has-detail) .todo-capture-shortcut {
    display: inline-grid;
    place-items: center;
    min-width: 20px;
    height: 20px;
    border: 1px solid var(--todo-line);
    border-radius: 4px;
    color: var(--todo-muted);
    background: var(--todo-paper);
    font: inherit;
    font-size: var(--todo-caption-size);
    line-height: 1;
  }
}
.todo-capture-feedback > span {
  display: block;
  padding: 0 12px 6px;
  color: var(--todo-muted);
  font-size: var(--todo-caption-size);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
</style>
