<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import { Popover as APopover } from 'ant-design-vue';
import Icon from './Icon.vue';

const props = defineProps<{ disabled: boolean }>();
const emit = defineEmits<{ select: [rows: number, columns: number] }>();
const panelId = useId();
const trigger = ref<HTMLButtonElement>();
const panel = ref<HTMLFormElement>();
const rowInput = ref<HTMLInputElement>();
const open = ref(false);
const rows = ref<number | string>(3);
const columns = ref<number | string>(3);
const placement = ref<'topLeft' | 'bottomLeft'>('bottomLeft');
const maxHeight = ref(420);
const presets = [2, 3, 4];
let focusFrame: number | undefined;
const validRows = computed(
  () => Number.isInteger(Number(rows.value)) && Number(rows.value) >= 1 && Number(rows.value) <= 20,
);
const validColumns = computed(
  () =>
    Number.isInteger(Number(columns.value)) &&
    Number(columns.value) >= 1 &&
    Number(columns.value) <= 10,
);
const valid = computed(() => validRows.value && validColumns.value);
const previewRows = computed(() => (validRows.value ? Number(rows.value) : 3));
const previewColumns = computed(() => (validColumns.value ? Number(columns.value) : 3));

function measure() {
  if (!open.value || !trigger.value) return;
  const bounds = trigger.value.getBoundingClientRect();
  const visible = window.visualViewport;
  const top = visible?.offsetTop ?? 0;
  const bottom = top + (visible?.height ?? innerHeight);
  const above = Math.max(0, Math.min(bounds.top, bottom) - top - 12);
  const below = Math.max(0, bottom - Math.max(bounds.bottom, top) - 12);
  placement.value = below >= above ? 'bottomLeft' : 'topLeft';
  maxHeight.value = Math.max(72, Math.min(420, Math.max(above, below) - 8));
}
function close(restoreFocus = false) {
  open.value = false;
  if (restoreFocus) trigger.value?.focus({ preventScroll: true });
}
function preset(size: number) {
  rows.value = size;
  columns.value = size;
}
function insert() {
  if (props.disabled || !valid.value) return;
  close();
  emit('select', Number(rows.value), Number(columns.value));
}
function focusPanel() {
  if (!open.value || !rowInput.value) return;
  rowInput.value.focus({ preventScroll: true });
  rowInput.value.select();
  if (document.activeElement !== rowInput.value) focusFrame = requestAnimationFrame(focusPanel);
}
function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && open.value) {
    event.preventDefault();
    event.stopPropagation();
    close(true);
  }
}
function triggerKeydown(event: KeyboardEvent) {
  if (props.disabled) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    event.stopPropagation();
    open.value = true;
  } else keydown(event);
}
watch([open, panel], async ([shown]) => {
  if (focusFrame !== undefined) cancelAnimationFrame(focusFrame);
  if (!shown) return;
  preset(3);
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
onMounted(() => {
  window.addEventListener('resize', measure);
  window.visualViewport?.addEventListener('resize', measure);
  window.visualViewport?.addEventListener('scroll', measure);
});
onBeforeUnmount(() => {
  window.removeEventListener('resize', measure);
  window.visualViewport?.removeEventListener('resize', measure);
  window.visualViewport?.removeEventListener('scroll', measure);
  if (focusFrame !== undefined) cancelAnimationFrame(focusFrame);
});
</script>

<template>
  <APopover
    v-model:open="open"
    trigger="click"
    :placement="placement"
    :arrow="false"
    overlay-class-name="editor-menu-popover table-picker-popover"
    :overlay-inner-style="{ padding: 0 }"
  >
    <template #content>
      <form
        :id="panelId"
        ref="panel"
        class="table-picker-panel"
        :style="{ maxHeight: maxHeight + 'px' }"
        role="dialog"
        aria-label="插入表格"
        novalidate
        @submit.prevent="insert"
        @keydown="keydown"
      >
        <div class="table-picker-header">
          <span>插入表格</span>
          <span>选择行数与列数</span>
        </div>
        <div class="table-picker-body">
          <div class="table-picker-preview-wrap" aria-hidden="true">
            <div
              class="table-picker-preview"
              :class="{ 'is-invalid': !valid }"
              :style="{
                gridTemplateColumns: `repeat(${previewColumns}, minmax(0, 1fr))`,
                gridTemplateRows: `repeat(${previewRows}, minmax(0, 1fr))`,
              }"
            >
              <span
                v-for="cell in previewRows * previewColumns"
                :key="cell"
                :class="{ 'is-header': cell <= previewColumns }"
              ></span>
            </div>
          </div>
          <div class="table-picker-fields">
            <label :for="panelId + '-rows'">
              行数
              <input
                :id="panelId + '-rows'"
                ref="rowInput"
                v-model.number="rows"
                type="number"
                min="1"
                max="20"
                step="1"
                aria-label="表格行数"
                :aria-describedby="panelId + '-hint'"
                :aria-invalid="!validRows || undefined"
              />
            </label>
            <span class="table-picker-multiply" aria-hidden="true">×</span>
            <label :for="panelId + '-columns'">
              列数
              <input
                :id="panelId + '-columns'"
                v-model.number="columns"
                type="number"
                min="1"
                max="10"
                step="1"
                aria-label="表格列数"
                :aria-describedby="panelId + '-hint'"
                :aria-invalid="!validColumns || undefined"
              />
            </label>
          </div>
          <div class="table-picker-presets" role="group" aria-label="常用表格尺寸">
            <button
              v-for="size in presets"
              :key="size"
              type="button"
              :aria-label="`${size} 行 × ${size} 列`"
              :aria-pressed="Number(rows) === size && Number(columns) === size"
              @mousedown.prevent
              @click="preset(size)"
            >
              {{ size }} × {{ size }}
            </button>
          </div>
          <p :id="panelId + '-hint'" class="table-picker-hint">1–20 行，1–10 列；首行为表头。</p>
          <p v-if="!valid" class="table-picker-error" role="status">请输入范围内的整数。</p>
          <div class="table-picker-actions">
            <button type="button" @mousedown.prevent @click="close(true)">取消</button>
            <button type="submit" class="table-picker-insert" :disabled="!valid" @mousedown.prevent>
              插入表格
            </button>
          </div>
        </div>
      </form>
    </template>
    <button
      ref="trigger"
      type="button"
      class="table-picker-trigger"
      aria-label="插入表格"
      title="插入表格"
      aria-haspopup="dialog"
      :aria-controls="open ? panelId : undefined"
      :aria-expanded="open"
      :disabled="disabled"
      @keydown="triggerKeydown"
    >
      <Icon name="table" :size="18" />
      <Icon name="chevron" :size="10" />
    </button>
  </APopover>
</template>

<style>
.format-toolbar .table-picker-trigger {
  width: 42px;
  gap: 4px;
}
.format-toolbar .table-picker-trigger[aria-expanded='true'] {
  background: var(--blue-soft);
  color: var(--blue);
}
.table-picker-trigger > svg:last-child {
  color: var(--muted);
  transform: rotate(90deg);
  transition: transform 150ms ease;
}
.table-picker-trigger[aria-expanded='true'] > svg:last-child {
  transform: rotate(270deg);
}
.table-picker-popover.ant-popover .ant-popover-inner {
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--panel, #fff);
  box-shadow:
    0 12px 36px #18243a14,
    0 2px 8px #18243a0a;
}
.table-picker-panel {
  width: min(280px, calc(100vw - 32px));
  margin: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  color: var(--text);
  font-family: inherit;
  font-size: 13px;
}
.table-picker-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 13px 16px 11px;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  font-weight: 600;
}
.table-picker-header > span:last-child {
  color: var(--muted);
  font-size: 11px;
  font-weight: 400;
}
.table-picker-body {
  padding: 14px;
}
.table-picker-preview-wrap {
  padding: 12px 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
}
.table-picker-preview {
  display: grid;
  height: 68px;
  gap: 2px;
}
.table-picker-preview > span {
  border: 1px solid var(--border);
  border-radius: 1px;
  background: var(--panel, #fff);
}
.table-picker-preview > .is-header {
  border-color: color-mix(in srgb, var(--blue) 35%, var(--border));
  background: var(--blue-soft);
}
.table-picker-preview.is-invalid {
  opacity: 0.4;
}
.table-picker-fields {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  margin-top: 14px;
}
.table-picker-fields label {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 6px;
  color: var(--muted);
  font-size: 12px;
}
.table-picker-fields input {
  box-sizing: border-box;
  width: 100%;
  height: 34px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel, #fff);
  color: var(--text);
  font: inherit;
  font-size: 13px;
}
.table-picker-multiply {
  padding-bottom: 8px;
  color: var(--muted);
}
.table-picker-presets {
  display: flex;
  gap: 6px;
  margin-top: 12px;
}
.table-picker-panel button {
  min-height: 32px;
  padding: 6px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel, #fff);
  color: var(--text);
  font: inherit;
  cursor: pointer;
}
.table-picker-presets button {
  flex: 1;
  color: var(--muted);
  font-size: 12px;
}
.table-picker-presets button[aria-pressed='true'] {
  border-color: color-mix(in srgb, var(--blue) 40%, var(--border));
  background: var(--blue-soft);
  color: var(--blue);
}
.table-picker-panel button:hover:not(:disabled) {
  background: var(--surface);
}
.table-picker-panel button:focus-visible,
.table-picker-panel input:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}
.table-picker-panel input[aria-invalid='true'] {
  border-color: #dc2626;
}
.table-picker-hint,
.table-picker-error {
  margin: 10px 0 0;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.6;
}
.table-picker-error {
  color: #b91c1c;
}
.table-picker-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}
.table-picker-panel .table-picker-insert {
  border-color: var(--blue);
  background: var(--blue);
  color: #fff;
}
.table-picker-panel .table-picker-insert:hover:not(:disabled) {
  background: color-mix(in srgb, var(--blue) 90%, #000);
}
.table-picker-panel button:disabled {
  opacity: 0.45;
  cursor: default;
}
@media (prefers-reduced-motion: reduce) {
  .table-picker-trigger > svg:last-child {
    transition: none;
  }
}
</style>
