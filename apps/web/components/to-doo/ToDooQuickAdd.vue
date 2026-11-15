<script setup lang="ts">
import ToDooDateField from './ToDooDateField.vue';
import { Button as AButton, Input as AInput, Popover as APopover } from 'ant-design-vue';
import ToDooSelect from './ToDooSelect.vue';

import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import type { ToDooWorkbench, ToDooCreateSeed } from '../../to-doo-workbench';
import { parseToDooQuickEntry, shiftToDooDate, toDooLocalDate } from '../../to-doo-workbench';
import {
  prepareToDooQuickDraft,
  toDooDateLabel,
  toDooDraftPayload,
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
const focused = ref(false);
let pointerDown = false,
  pendingBlur = false;
let blurTimer: ReturnType<typeof setTimeout> | undefined;
const state = props.model.state;
const draft = computed(() => props.model.newTaskDraft(undefined, props.listId, props.seed));
const literalTitle = computed({ get: () => !!draft.value.literalTitle, set: (value: boolean) => { draft.value.literalTitle = value; } });
const composing = ref(false);
const chipOpen = ref<string | null>(null);
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
watch(() => draft.value.title, () => {
  literalTitle.value = false;
  originalDraft.value = null;
}, { flush: 'sync' });
const today = computed(() => toDooLocalDate(new Date(), state.snapshot?.settings.timeZone));
const prepared = computed(() =>
  prepareToDooQuickDraft(
    draft.value,
    today.value,
    state.snapshot?.tags.filter((t) => !t.deletedAt) || [],
    props.defaultDate,
  ),
);
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
  if (kind === 'plan') Object.assign(draft.value, { planDate: '', planTime: '', planDateCleared: true });
  else Object.assign(draft.value, { dueDate: '', dueTime: '', planDateCleared: true });
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
function quickFocus(event: KeyboardEvent) {
  if (
    event.key.toLowerCase() !== 'q' ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.isComposing ||
    event.defaultPrevented
  )
    return;
  const target = event.target;
  if (
    target instanceof Element &&
    target.closest('input, textarea, select, [contenteditable], [role="textbox"]')
  )
    return;
  const modalOpen = [
    ...document.querySelectorAll<HTMLElement>('[role="dialog"], [aria-modal="true"]'),
  ].some(
    (element) =>
      element.getClientRects().length &&
      getComputedStyle(element).visibility !== 'hidden' &&
      !element.closest('[aria-hidden="true"]'),
  );
  if (modalOpen) return;
  const element = captureInput();
  if (!element || element.disabled || !element.getClientRects().length) return;
  event.preventDefault();
  element.focus();
}
onMounted(() => {
  window.addEventListener('keydown', quickFocus);
  document.addEventListener('pointerdown', beginPointer, true);
  document.addEventListener('pointerup', endPointer, true);
  document.addEventListener('pointercancel', endPointer, true);
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', quickFocus);
  document.removeEventListener('pointerdown', beginPointer, true);
  document.removeEventListener('pointerup', endPointer, true);
  document.removeEventListener('pointercancel', endPointer, true);
  clearTimeout(blurTimer);
});
async function add() {
  if (composing.value || !draft.value.title.trim() || state.busy || state.pendingMutation) return;
  // Normalize into the persisted draft so a retried request can also clear it.
  Object.assign(draft.value, prepared.value);
  const payload = toDooDraftPayload(draft.value, state.snapshot?.settings.timeZone || 'UTC');
  const result = await props.model.createTask(payload);
  if (result) {
    const taskId = result.ids.find((id) => result.snapshot.tasks.some((task) => task.id === id)) ||
      result.changed.find(entry => entry.kind === 'task' && result.ids.includes(entry.id))?.id;
    if (taskId)
      emit('created', {
        taskId,
        title: payload.title,
        listId: payload.listId || null,
        planDates: payload.plan?.date ? [payload.plan.date] : [],
      });
    await nextTick();
    captureInput()?.focus();
  }
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
      <ToDooIcon name="plus" :size="19" />
      <AInput
        v-model:value="draft.title"
        aria-label="快速添加任务"
        placeholder="添加任务…"
        :maxlength="256"
        autocomplete="off"
        :disabled="state.busy || !!state.pendingMutation"
        @compositionstart="composing = true"
        @compositionend="composing = false"
        @keydown.enter="(($event as KeyboardEvent).isComposing || composing) && $event.preventDefault()"
      />
      <AButton
        v-if="draft.title.trim()"
        html-type="submit"
        class="todo-button todo-primary"
        :disabled="state.busy || !!state.pendingMutation"
        type="primary"
      >
        {{ state.busy ? '添加中…' : '添加任务' }}
      </AButton>
      <AButton
        html-type="button"
        v-if="expanded"
        class="todo-quick-details"
        aria-label="详细添加"
        title="填写任务详情"
        :disabled="state.busy"
        @click="emit('expand')"
        type="text"
      >
        详情
      </AButton>
    </div>
    <div v-if="draft.title.trim()" class="todo-quick-add-hint" aria-label="任务输入属性">
      <span v-if="prepared.planDate" class="todo-capture-chip">
        <APopover :open="chipOpen === 'plan'" trigger="click" title="计划" overlay-class-name="todo-ant-popup" @open-change="(open: boolean) => setChipOpen('plan', open)">
          <AButton type="text" @click="rememberChip" @keydown.esc.stop.prevent="closeChip" aria-label="纠正计划日期">计划 {{ toDooDateLabel(prepared.planDate, today) }} {{ prepared.planTime }}</AButton>
          <template #content><div class="todo-capture-chip-editor" @keydown.esc.stop.prevent="closeChip"><label>计划日期<ToDooDateField v-model="draft.planDate" type="date" aria-label="纠正计划日期" /></label><label>计划时间<ToDooDateField v-model="draft.planTime" type="time" aria-label="纠正计划时间" /></label></div></template>
        </APopover>
        <AButton type="text" aria-label="移除计划识别" @click="removeDate('plan')">×</AButton>
      </span>
      <span v-if="prepared.dueDate" class="todo-capture-chip">
        <APopover :open="chipOpen === 'due'" trigger="click" title="截止" overlay-class-name="todo-ant-popup" @open-change="(open: boolean) => setChipOpen('due', open)">
          <AButton type="text" @click="rememberChip" @keydown.esc.stop.prevent="closeChip" aria-label="纠正截止日期">截止 {{ toDooDateLabel(prepared.dueDate, today) }} {{ prepared.dueTime }}</AButton>
          <template #content><div class="todo-capture-chip-editor" @keydown.esc.stop.prevent="closeChip"><label>截止日期<ToDooDateField v-model="draft.dueDate" type="date" aria-label="纠正截止日期" /></label><label>截止时间<ToDooDateField v-model="draft.dueTime" type="time" aria-label="纠正截止时间" /></label></div></template>
        </APopover>
        <AButton type="text" aria-label="移除截止识别" @click="removeDate('due')">×</AButton>
      </span>
      <span v-if="prepared.frequency" class="todo-capture-chip">
        <APopover :open="chipOpen === 'repeat'" trigger="click" title="重复" overlay-class-name="todo-ant-popup" @open-change="(open: boolean) => setChipOpen('repeat', open)">
          <AButton type="text" @click="rememberChip" @keydown.esc.stop.prevent="closeChip" aria-label="纠正重复规则">{{ prepared.frequency === 'daily' ? '每天重复' : '每周' + '日一二三四五六'[prepared.weekdays[0] ?? 1] + '重复' }}</AButton>
          <template #content><div class="todo-capture-chip-editor" @keydown.esc.stop.prevent="closeChip"><label>重复<ToDooSelect :value="draft.frequency" aria-label="纠正重复规则" @change="correctRepeat"><option :value="null">不重复</option><option value="daily">每天</option><option value="weekly">每周</option></ToDooSelect></label><label v-if="draft.frequency === 'weekly'">星期<ToDooSelect :value="draft.weekdays[0] ?? 1" aria-label="重复星期" @change="draft.weekdays = [Number($event)]"><option v-for="(day, index) in ['日', '一', '二', '三', '四', '五', '六']" :key="index" :value="index">星期{{ day }}</option></ToDooSelect></label></div></template>
        </APopover>
        <AButton type="text" aria-label="移除重复识别" @click="removeRepeat">×</AButton>
      </span>
      <span v-for="id in prepared.tagIds" :key="id" class="todo-capture-chip">
        <APopover :open="chipOpen === 'tag-' + id" trigger="click" title="标签" overlay-class-name="todo-ant-popup" @open-change="(open: boolean) => setChipOpen('tag-' + id, open)">
          <AButton type="text" :aria-label="'纠正标签 ' + (state.snapshot?.tags.find((tag) => tag.id === id)?.name || id)" @click="rememberChip" @keydown.esc.stop.prevent="closeChip">{{ state.snapshot?.tags.find((tag) => tag.id === id)?.name || '标签' }}</AButton>
          <template #content><div class="todo-capture-chip-editor" @keydown.esc.stop.prevent="closeChip"><label>标签<ToDooSelect :value="id" aria-label="纠正标签" @change="correctTag(id, $event)"><option v-for="tag in state.snapshot?.tags.filter((entry) => !entry.deletedAt)" :key="tag.id" :value="tag.id">{{ tag.name }}</option></ToDooSelect></label></div></template>
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
