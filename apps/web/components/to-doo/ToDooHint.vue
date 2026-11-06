<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Alert as AAlert } from 'ant-design-vue';
import type { ToDooWorkbench } from '../../to-doo-workbench';

const props = defineProps<{ model: ToDooWorkbench; hintId: string }>();
const dismissed = ref(false);
const storageKey = computed(() => {
  const dataset = props.model.state.snapshot?.datasetId;
  return dataset
    ? 'dooknow.to-doo.hints.v1:' + encodeURIComponent(dataset) + ':' + props.hintId
    : null;
});
watch(
  storageKey,
  (key) => {
    dismissed.value = false;
    try {
      dismissed.value = !!key && localStorage.getItem(key) === 'dismissed';
    } catch {
      // The hint remains usable when browser storage is unavailable.
    }
  },
  { immediate: true },
);

function dismiss() {
  dismissed.value = true;
  try {
    if (storageKey.value) localStorage.setItem(storageKey.value, 'dismissed');
  } catch {
    // Dismiss for this mounted view even when the browser cannot persist it.
  }
}
</script>

<template>
  <AAlert
    v-if="!dismissed"
    :key="storageKey || hintId"
    class="todo-hint"
    :data-todo-hint="hintId"
    type="info"
    role="note"
    show-icon
    closable
    @close="dismiss"
  >
    <template #message><slot /></template>
    <template #closeIcon>
      <span aria-hidden="true">×</span><span class="todo-hint-close-label">关闭提示</span>
    </template>
  </AAlert>
</template>

<style scoped>
.todo-hint {
  min-width: 0;
  margin-block: 8px;
  flex-shrink: 0;
}
.todo-hint :deep(.ant-alert-content) {
  min-width: 0;
  overflow-wrap: anywhere;
}
.todo-hint :deep(.ant-alert-message) {
  font-size: 12px;
  line-height: 1.7;
}
.todo-hint :deep(.ant-alert-close-icon) {
  display: grid;
  flex: 0 0 28px;
  place-items: center;
  width: 28px;
  height: 28px;
  margin-block: -4px;
  font-size: 20px;
}
.todo-hint :deep(.ant-alert-close-icon:focus-visible) {
  outline: 2px solid var(--todo-accent);
  outline-offset: 2px;
  border-radius: 3px;
}
.todo-hint-close-label {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
</style>
