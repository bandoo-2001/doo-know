<script setup lang="ts">
import { ref, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { NPopover, NButton } from 'naive-ui';
import Icon from './Icon.vue';
defineProps<{ lineNumbers: boolean; fullEditor: boolean }>();
const emit = defineEmits<{
  history: [];
  upload: [];
  delete: [];
  'update:lineNumbers': [value: boolean];
}>();
const open = ref(false);
const menu = ref<HTMLElement>();
const trigger = ref<InstanceType<typeof NButton>>();
const placement = ref<'bottom-end' | 'top-end'>('bottom-end');
const maxHeight = ref(360);
function measureSpace() {
  if (!open.value) return;
  const button = trigger.value?.$el as HTMLElement | undefined;
  if (!button) return;
  const rect = button.getBoundingClientRect();
  const below = window.innerHeight - rect.bottom - 12,
    above = rect.top - 12;
  placement.value = below >= above ? 'bottom-end' : 'top-end';
  maxHeight.value = Math.max(48, Math.min(360, Math.max(below, above)));
}
function close() {
  open.value = false;
  (trigger.value?.$el as HTMLElement | undefined)?.focus();
}
watch(open, async (shown) => {
  if (shown) {
    measureSpace();
    await nextTick();
    menu.value?.querySelector('button')?.focus();
  }
});
onMounted(() => window.addEventListener('resize', measureSpace));
onBeforeUnmount(() => window.removeEventListener('resize', measureSpace));
function action(kind: 'history' | 'upload' | 'delete') {
  close();
  if (kind === 'history') emit('history');
  else if (kind === 'upload') emit('upload');
  else emit('delete');
}
</script>
<template>
  <NPopover
    v-model:show="open"
    trigger="click"
    :placement="placement"
    :show-arrow="false"
    :style="{ maxHeight: maxHeight + 'px', overflowY: 'auto' }"
  >
    <template #trigger>
      <NButton
        ref="trigger"
        aria-label="更多操作"
        title="更多操作"
        :aria-expanded="open"
        @keydown.esc="close"
      >
        <Icon name="more" />
      </NButton>
    </template>
    <div
      class="note-action-menu"
      ref="menu"
      role="dialog"
      aria-label="笔记操作"
      @keydown.esc.stop="close"
    >
      <button @click="action('history')"><Icon name="clock" />历史版本</button>
      <button @click="action('upload')"><Icon name="image" />插入图片或 PDF</button>
      <div class="plugin-note-actions" @click="close"><slot /></div>
      <label v-if="fullEditor" class="line-number-option">
        <input
          type="checkbox"
          :checked="lineNumbers"
          @change="emit('update:lineNumbers', ($event.target as HTMLInputElement).checked)"
        />显示行号
      </label>
      <button class="danger-action" @click="action('delete')"><Icon name="trash" />删除笔记</button>
    </div>
  </NPopover>
</template>
