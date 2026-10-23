<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import { Popover as APopover } from 'ant-design-vue';
import Icon from './Icon.vue';

const props = defineProps<{ value: number; disabled: boolean }>();
const emit = defineEmits<{ select: [level: number] }>();
const menuId = useId();
const trigger = ref<HTMLButtonElement>();
const panel = ref<HTMLElement>();
const open = ref(false);
const active = ref(0);
const placement = ref<'topLeft' | 'bottomLeft'>('bottomLeft');
const maxHeight = ref(420);
let focusFrame: number | undefined;
const options = computed(() => [0, 1, 2, 3, 4, 5, ...(props.value === 6 ? [6] : [])]);
const label = computed(() => (props.value ? `标题 ${props.value}` : '正文'));

function measure() {
  if (!open.value || !trigger.value) return;
  const rect = trigger.value.getBoundingClientRect();
  const above = Math.max(0, rect.top - 12);
  const below = Math.max(0, innerHeight - rect.bottom - 12);
  placement.value = below >= above ? 'bottomLeft' : 'topLeft';
  maxHeight.value = Math.max(72, Math.min(420, Math.max(above, below) - 8));
}
function close(restoreFocus = false) {
  open.value = false;
  if (restoreFocus) trigger.value?.focus({ preventScroll: true });
}
function choose(level: number) {
  if (props.disabled || level === 6) return;
  close();
  emit('select', level);
}
function focusPanel() {
  if (!open.value || !panel.value) return;
  const option = panel.value.querySelector<HTMLButtonElement>(`[data-level="${active.value}"]`);
  option?.focus({ preventScroll: true });
  if (option && document.activeElement !== option) focusFrame = requestAnimationFrame(focusPanel);
}
function move(level: number) {
  active.value = level;
  const option = panel.value?.querySelector<HTMLButtonElement>(`[data-level="${level}"]`);
  option?.focus({ preventScroll: true });
  option?.scrollIntoView({
    block: 'nearest',
  });
}
function keydown(event: KeyboardEvent) {
  if (props.disabled) return;
  if (event.key === 'Escape' && open.value) {
    event.preventDefault();
    event.stopPropagation();
    close(true);
    return;
  }
  if (event.key === 'Tab' && open.value) {
    // Continue through the toolbar in its normal tab order after dismissing the menu.
    trigger.value?.focus({ preventScroll: true });
    close();
    return;
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) return;
  if (!open.value && ['Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  event.stopPropagation();
  if (!open.value) {
    open.value = true;
    return;
  }
  if (event.key === 'Enter' || event.key === ' ') choose(active.value);
  else if (event.key === 'Home') move(0);
  else if (event.key === 'End') move(5);
  else if (event.key === 'ArrowDown') move(active.value >= 5 ? 0 : active.value + 1);
  else move(active.value <= 0 || active.value === 6 ? 5 : active.value - 1);
}
watch([open, panel], async ([shown]) => {
  if (focusFrame !== undefined) cancelAnimationFrame(focusFrame);
  if (!shown) return;
  active.value = options.value.includes(props.value) ? props.value : 0;
  measure();
  await nextTick();
  focusPanel();
});
watch(
  () => props.disabled,
  (disabled) => {
    if (disabled) close();
  },
);
onMounted(() => window.addEventListener('resize', measure));
onBeforeUnmount(() => {
  window.removeEventListener('resize', measure);
  if (focusFrame !== undefined) cancelAnimationFrame(focusFrame);
});
</script>

<template>
  <APopover
    v-model:open="open"
    trigger="click"
    :placement="placement"
    :arrow="false"
    overlay-class-name="editor-menu-popover heading-menu-popover"
    :overlay-inner-style="{ padding: 0 }"
  >
    <template #content>
      <div class="heading-menu" :style="{ maxHeight: maxHeight + 'px' }">
        <div class="heading-menu-header" aria-hidden="true">
          <span>段落格式</span>
          <span>选择文字层级</span>
        </div>
        <div
          :id="menuId"
          ref="panel"
          class="heading-menu-options"
          role="listbox"
          aria-label="段落样式"
          @keydown="keydown"
        >
          <button
            v-for="level in options"
            :id="menuId + '-' + level"
            :key="level"
            type="button"
            class="heading-menu-option"
            :class="{ 'is-active': active === level }"
            role="option"
            :aria-label="level ? `标题 ${level}` : '正文'"
            :aria-selected="value === level"
            :aria-disabled="level === 6 || undefined"
            :data-level="level"
            :tabindex="active === level ? 0 : -1"
            @focus="active = level"
            @mousedown.prevent
            @click="choose(level)"
          >
            <span class="heading-menu-marker" aria-hidden="true">{{
              level ? `H${level}` : '¶'
            }}</span>
            <span class="heading-menu-preview" :class="'heading-preview-' + level">
              {{ level ? `标题 ${level}` : '正文' }}
            </span>
            <Icon v-if="value === level" class="heading-menu-check" name="check" :size="16" />
          </button>
        </div>
      </div>
    </template>
    <button
      ref="trigger"
      type="button"
      class="heading-picker-trigger"
      role="combobox"
      aria-label="段落格式"
      aria-haspopup="listbox"
      :aria-controls="open ? menuId : undefined"
      :aria-expanded="open"
      :disabled="disabled"
      @keydown="keydown"
    >
      <span>{{ label }}</span>
      <Icon name="chevron" :size="12" />
    </button>
  </APopover>
</template>

<style>
.format-toolbar .heading-picker-trigger {
  width: 94px;
  justify-content: space-between;
  gap: 10px;
  padding: 0 9px;
  border-radius: 6px;
  color: var(--text);
  font-size: 13px;
  white-space: nowrap;
}
.heading-picker-trigger > svg {
  flex-shrink: 0;
  color: var(--muted);
  transform: rotate(90deg);
  transition: transform 150ms ease;
}
.format-toolbar .heading-picker-trigger[aria-expanded='true'] {
  background: var(--blue-soft);
  color: var(--blue);
}
.format-toolbar .heading-picker-trigger:hover:not(:disabled) {
  background: var(--blue-soft);
}
.heading-picker-trigger[aria-expanded='true'] > svg {
  transform: rotate(270deg);
}
.heading-menu-popover.ant-popover .ant-popover-inner {
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--panel, #fff);
  box-shadow:
    0 12px 36px #18243a14,
    0 2px 8px #18243a0a;
}
.heading-menu {
  display: flex;
  flex-direction: column;
  width: min(260px, calc(100vw - 32px));
  color: var(--text);
  font-family: inherit;
  font-size: 13px;
}
.heading-menu-header {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 13px 16px 11px;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  font-weight: 600;
}
.heading-menu-header > span:last-child {
  color: var(--muted);
  font-size: 11px;
  font-weight: 400;
}
.heading-menu-options {
  min-height: 0;
  padding: 6px;
  overflow-y: auto;
  overscroll-behavior: contain;
  outline: none;
}
.heading-menu-option {
  display: flex;
  width: 100%;
  min-height: 44px;
  align-items: center;
  gap: 12px;
  padding: 8px 10px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.heading-menu-option + .heading-menu-option {
  margin-top: 2px;
}
.heading-menu-option.is-active,
.heading-menu-option:hover {
  background: var(--surface);
}
.heading-menu-option[aria-selected='true'] {
  background: var(--blue-soft);
}
.heading-menu-option:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: -2px;
}
.heading-menu-option[aria-disabled='true'] {
  opacity: 0.55;
  cursor: default;
}
.heading-menu-marker {
  display: grid;
  width: 28px;
  flex: 0 0 28px;
  place-items: center;
  color: var(--muted);
  font-size: 11px;
  font-weight: 500;
}
.heading-menu-option[aria-selected='true'] .heading-menu-marker,
.heading-menu-check {
  color: var(--blue);
}
.heading-menu-preview {
  flex: 1;
  font-size: var(--editor-font-size, 15px);
  font-weight: 650;
  line-height: 1.5;
}
.heading-preview-0 {
  font-weight: 400;
}
.heading-preview-1 {
  font-size: calc(var(--editor-font-size, 15px) * 1.8);
}
.heading-preview-2 {
  font-size: calc(var(--editor-font-size, 15px) * 1.5);
}
.heading-preview-3 {
  font-size: calc(var(--editor-font-size, 15px) * 1.25);
}
.heading-preview-5 {
  font-size: calc(var(--editor-font-size, 15px) * 0.83);
}
.heading-preview-6 {
  font-size: calc(var(--editor-font-size, 15px) * 0.67);
}
@media (prefers-reduced-motion: reduce) {
  .heading-picker-trigger > svg {
    transition: none;
  }
}
</style>
