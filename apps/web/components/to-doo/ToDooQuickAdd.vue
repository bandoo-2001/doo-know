<script setup lang="ts">
import ToDooDateField from './ToDooDateField.vue';
import { Button as AButton, Input as AInput } from 'ant-design-vue';

import { computed, nextTick, onMounted, onBeforeUnmount, ref } from 'vue';
import type { ToDooWorkbench } from '../../to-doo-workbench';
import { shiftToDooDate, toDooLocalDate } from '../../to-doo-workbench';
import {
  prepareToDooQuickDraft,
  toDooDateLabel,
  toDooDraftPayload,
} from '../../to-doo-presentation';
import ToDooIcon from './ToDooIcon.vue';
const props = defineProps<{ model: ToDooWorkbench; listId?: string; defaultDate?: string }>();
const emit = defineEmits<{ expand: [] }>();
const captureForm = ref<HTMLFormElement>();
function captureInput() {
  return captureForm.value?.querySelector<HTMLInputElement>('input[aria-label="快速添加任务"]');
}
const focused = ref(false);
let pointerDown = false,
  pendingBlur = false;
let blurTimer: ReturnType<typeof setTimeout> | undefined;
const state = props.model.state;
const draft = computed(() => props.model.newTaskDraft(undefined, props.listId));
const today = computed(() => toDooLocalDate(new Date(), state.snapshot?.settings.timeZone));
const prepared = computed(() =>
  prepareToDooQuickDraft(
    draft.value,
    today.value,
    state.snapshot?.tags.filter((t) => !t.deletedAt) || [],
    props.defaultDate,
  ),
);
const date = computed(() => prepared.value.planDate || prepared.value.dueDate);
const expanded = computed(() => focused.value || !!draft.value.title.trim());
function setPlanDate(value: string) {
  if (state.busy || state.pendingMutation) return;
  // Move recognized tokens into the existing recoverable draft before overriding the plan.
  Object.assign(draft.value, prepared.value, {
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
  if (!draft.value.title.trim() || state.busy || state.pendingMutation) return;
  // Normalize into the persisted draft so a retried request can also clear it.
  Object.assign(draft.value, prepared.value);
  const result = await props.model.createTask(
    toDooDraftPayload(draft.value, state.snapshot?.settings.timeZone || 'UTC'),
  );
  if (result) {
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
        placeholder="添加任务，按 Enter 创建"
        :maxlength="256"
        autocomplete="off"
        :disabled="state.busy || !!state.pendingMutation"
        @keydown.enter="($event as KeyboardEvent).isComposing && $event.preventDefault()"
      />
      <span class="todo-quick-enter" aria-hidden="true">↵</span>
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
        class="todo-icon-button"
        aria-label="详细添加"
        title="打开完整任务编辑"
        :disabled="state.busy"
        @click="emit('expand')"
        type="text"
      >
        <ToDooIcon name="more" />
      </AButton>
    </div>
    <div v-if="draft.title.trim()" class="todo-quick-add-hint">
      <span v-if="date" class="todo-quick-date"
        ><ToDooIcon name="calendar" :size="13" />{{ prepared.planDate ? '计划' : '截止' }}
        {{ toDooDateLabel(date, today) }}
        {{ prepared.planDate ? prepared.planTime : prepared.dueTime }}</span
      >
      <span v-if="prepared.frequency">{{
        prepared.frequency === 'daily' ? '每天重复' : '每周重复'
      }}</span>
      <span v-if="prepared.tagIds.length">{{ prepared.tagIds.length }} 个标签</span>
      <span class="todo-quick-tip">可输入「明天 下午3点 写方案」</span>
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
      <span class="todo-capture-key">Q 快速输入 · Enter 创建</span>
    </div>
  </form>
</template>
