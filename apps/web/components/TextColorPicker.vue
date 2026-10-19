<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch, useId } from 'vue';
import { Popover as APopover } from 'ant-design-vue';
import Icon from './Icon.vue';
const props = defineProps<{ value: string | null; disabled: boolean }>();
const emit = defineEmits<{ select: [color: string | null] }>();
const hexId = useId();
const names = ['黑色', '灰色', '蓝色', '青色', '绿色', '红色', '橙色', '黄色', '紫色'];
const rows = [
  [
    '#000000',
    '#64748b',
    '#2563eb',
    '#0891b2',
    '#16a34a',
    '#dc2626',
    '#ea580c',
    '#eab308',
    '#9333ea',
  ],
  [
    '#e5e7eb',
    '#f1f5f9',
    '#dbeafe',
    '#cffafe',
    '#dcfce7',
    '#fee2e2',
    '#ffedd5',
    '#fef9c3',
    '#f3e8ff',
  ],
  [
    '#9ca3af',
    '#94a3b8',
    '#60a5fa',
    '#22d3ee',
    '#4ade80',
    '#f87171',
    '#fb923c',
    '#facc15',
    '#c084fc',
  ],
  [
    '#374151',
    '#334155',
    '#1e40af',
    '#155e75',
    '#166534',
    '#991b1b',
    '#9a3412',
    '#a16207',
    '#581c87',
  ],
];
const tones = ['', '浅', '亮', '深'];
const colors = rows.flatMap((row, index) =>
  row.map((value, column) => ({
    value,
    name: tones[index] + names[column],
    light: [1, 2].includes(index) || value === '#eab308',
  })),
);
const open = ref(false),
  custom = ref(false),
  hex = ref('');
const trigger = ref<HTMLButtonElement>(),
  panel = ref<HTMLElement>(),
  input = ref<HTMLInputElement>(),
  customToggle = ref<HTMLButtonElement>();
let focusFrame: number | undefined;
const placement = ref<'topLeft' | 'bottomLeft'>('bottomLeft');
const maxHeight = ref(340);
const normalized = computed(() => {
  const match = hex.value.trim().match(/^#?([a-f\d]{3}|[a-f\d]{6})$/i);
  if (!match) return null;
  const value = match[1].toLowerCase();
  return '#' + (value.length === 3 ? [...value].map((char) => char + char).join('') : value);
});
function measure() {
  if (!open.value || !trigger.value) return;
  const rect = trigger.value.getBoundingClientRect();
  const above = Math.max(0, rect.top - 12),
    below = Math.max(0, innerHeight - rect.bottom - 12);
  placement.value = below >= above ? 'bottomLeft' : 'topLeft';
  maxHeight.value = Math.max(48, Math.min(340, Math.max(above, below) - 8));
}
function close() {
  open.value = false;
  trigger.value?.focus({ preventScroll: true });
}
function choose(color: string | null) {
  open.value = false;
  emit('select', color);
}
async function showCustom() {
  custom.value = !custom.value;
  if (!custom.value) return;
  hex.value = props.value || '#343c4a';
  await nextTick();
  input.value?.focus();
}
function cancelCustom() {
  custom.value = false;
  customToggle.value?.focus({ preventScroll: true });
}
function focusPanel() {
  if (!open.value || !panel.value) return;
  const target =
    panel.value.querySelector<HTMLButtonElement>('button[aria-pressed="true"]') ||
    panel.value.querySelector<HTMLButtonElement>('[data-default-color]');
  target?.focus({ preventScroll: true });
  if (target && document.activeElement !== target) focusFrame = requestAnimationFrame(focusPanel);
}
watch([open, panel], async ([shown]) => {
  if (focusFrame !== undefined) cancelAnimationFrame(focusFrame);
  if (!shown) {
    custom.value = false;
    return;
  }
  custom.value = false;
  measure();
  await nextTick();
  focusPanel();
});
watch(
  () => props.disabled,
  (disabled) => {
    if (disabled) open.value = false;
  },
);
function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    close();
    return;
  }
  const target = event.target as HTMLElement;
  if (!target.matches('[data-swatch], [data-default-color]')) return;
  const swatches = [...(panel.value?.querySelectorAll<HTMLButtonElement>('[data-swatch]') || [])];
  const index = swatches.indexOf(target as HTMLButtonElement);
  let next: number;
  if (event.key === 'ArrowDown') next = index < 0 ? 0 : (index + 9) % 36;
  else if (event.key === 'ArrowUp') next = index < 0 ? 35 : (index + 27) % 36;
  else if (event.key === 'ArrowRight') next = (index + 1) % 36;
  else if (event.key === 'ArrowLeft') next = (index + 35) % 36;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = 35;
  else return;
  event.preventDefault();
  event.stopPropagation();
  swatches[next]?.focus();
}
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
    :overlay-inner-style="{ padding: '8px', maxHeight: maxHeight + 'px', overflowY: 'auto' }"
  >
    <template #content>
      <div
        ref="panel"
        class="text-color-palette"
        role="dialog"
        aria-label="文字颜色面板"
        @keydown="keydown"
      >
        <button
          type="button"
          class="palette-default"
          data-default-color
          :aria-pressed="!value"
          @click="choose(null)"
        >
          <span class="palette-reset" aria-hidden="true"></span>默认颜色
          <Icon v-if="!value" class="palette-default-check" name="check" :size="14" />
        </button>
        <div class="color-swatches" role="group" aria-label="常用颜色">
          <button
            v-for="color in colors"
            :key="color.value"
            type="button"
            data-swatch
            tabindex="-1"
            :aria-label="color.name + ' ' + color.value"
            :title="color.name + ' ' + color.value"
            :aria-pressed="value?.toLowerCase() === color.value"
            :style="{ background: color.value, color: color.light ? '#253042' : '#fff' }"
            @mousedown.prevent
            @click="choose(color.value)"
          >
            <Icon v-if="value?.toLowerCase() === color.value" name="check" :size="14" />
          </button>
        </div>
        <button
          ref="customToggle"
          type="button"
          class="palette-custom-toggle"
          :aria-expanded="custom"
          @click="showCustom"
        >
          <Icon name="settings" :size="14" />自定义颜色<Icon name="chevron" :size="13" />
        </button>
        <div v-if="custom" class="palette-custom">
          <label :for="hexId">HEX 色值</label>
          <div class="palette-hex-row">
            <span
              class="palette-color-preview"
              :style="{ background: normalized || 'transparent' }"
              aria-hidden="true"
            ></span>
            <input
              :id="hexId"
              ref="input"
              v-model="hex"
              type="text"
              spellcheck="false"
              placeholder="#RRGGBB"
              maxlength="7"
              @keydown.enter.prevent="normalized && choose(normalized)"
            />
          </div>
          <p v-if="!normalized" class="palette-color-error" role="status">
            请输入有效色值，例如 #2563EB
          </p>
          <div class="palette-custom-actions">
            <button type="button" @click="cancelCustom">取消</button>
            <button
              type="button"
              class="palette-apply"
              :disabled="!normalized"
              @click="normalized && choose(normalized)"
            >
              应用颜色
            </button>
          </div>
        </div>
      </div>
    </template>
    <button
      ref="trigger"
      class="text-color-trigger"
      type="button"
      aria-label="文字颜色"
      title="文字颜色"
      aria-haspopup="dialog"
      :aria-expanded="open"
      :disabled="disabled"
    >
      <span
        class="text-color-symbol"
        :style="{ borderColor: value || '#343c4a' }"
        aria-hidden="true"
        >A</span
      >
      <Icon name="chevron" :size="11" />
    </button>
  </APopover>
</template>
<style>
.format-toolbar .text-color-trigger {
  width: 42px;
  gap: 5px;
}
.text-color-trigger > svg {
  transform: rotate(90deg);
}
.text-color-palette {
  width: min(244px, calc(100vw - 48px));
  color: var(--text);
  font-size: 12px;
}
.text-color-palette button {
  font: inherit;
  cursor: pointer;
}
.palette-default,
.palette-custom-toggle {
  display: flex;
  width: 100%;
  min-height: 32px;
  align-items: center;
  gap: 8px;
  padding: 4px;
  border: 0;
  border-radius: 4px;
  color: var(--muted);
  background: transparent;
  text-align: left;
}
.palette-default:hover,
.palette-custom-toggle:hover {
  background: var(--blue-soft);
}
.palette-default-check,
.palette-custom-toggle > svg:last-child {
  margin-left: auto;
}
.palette-reset {
  width: 19px;
  height: 19px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: linear-gradient(135deg, transparent 47%, #aab7ca 49%, #aab7ca 52%, transparent 54%);
}
.color-swatches {
  display: grid;
  grid-template-columns: repeat(9, minmax(0, 1fr));
  gap: 4px;
  padding: 5px 0 12px;
}
.color-swatches button {
  display: grid;
  place-items: center;
  width: 100%;
  aspect-ratio: 1;
  min-height: 22px;
  padding: 0;
  border: 1px solid #77889918;
  border-radius: 3px;
}
.color-swatches button:hover {
  transform: scale(1.08);
  box-shadow: 0 0 0 1px var(--blue);
}
.color-swatches button[aria-pressed='true'] {
  outline: 2px solid var(--blue);
  outline-offset: 1px;
}
.color-swatches button:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}
.palette-custom-toggle {
  border-top: 1px solid var(--border);
  border-radius: 0;
  padding-top: 9px;
}
.palette-custom {
  padding: 10px 3px 2px;
}
.palette-custom label {
  display: block;
  margin-bottom: 5px;
  color: var(--muted);
  font-size: 11px;
}
.palette-hex-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.palette-color-preview {
  flex: 0 0 28px;
  height: 28px;
  border: 1px solid var(--border);
  border-radius: 4px;
}
.palette-hex-row input {
  width: 100%;
  min-width: 0;
  height: 30px;
  padding: 4px 7px;
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text);
  background: var(--panel);
  font: inherit;
}
.palette-custom-actions {
  display: flex;
  justify-content: flex-end;
  gap: 7px;
  margin-top: 10px;
}
.palette-custom-actions button {
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--panel);
  color: var(--text);
}
.palette-custom-actions .palette-apply {
  color: #fff;
  background: var(--blue);
  border-color: var(--blue);
}
.palette-custom-actions button:disabled {
  opacity: 0.45;
  cursor: default;
}
.palette-color-error {
  margin: 6px 0 0;
  color: #bf5258;
  font-size: 11px;
}
</style>
