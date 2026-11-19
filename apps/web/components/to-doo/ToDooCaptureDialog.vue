<script setup lang="ts">
import { ConfigProvider as AConfigProvider, Modal as AModal } from 'ant-design-vue';
import { toDooAntTheme } from '../../ant-design';
import { resolvedTheme } from '../../preferences';
import '../../to-doo-ant.css';
import '../../to-doo-tokens.css';
import '../../to-doo-form-layout.css';
defineProps<{ open: boolean; busy: boolean }>();
const emit = defineEmits<{ 'update:open': [value: boolean] }>();
</script>
<template>
  <AConfigProvider :theme="toDooAntTheme(resolvedTheme)">
    <AModal :open="open" :footer="$slots.actions ? undefined : null" wrap-class-name="todo-ant-modal todo-capture-modal" title="从资料创建任务" :mask-closable="!busy" :keyboard="!busy" :closable="!busy" @update:open="!busy && emit('update:open', $event)">
      <slot />
      <template v-if="$slots.actions" #footer><slot name="actions" /></template>
    </AModal>
  </AConfigProvider>
</template>
<style>
.todo-capture-modal .todo-capture-actions {
  margin-top: 0;
}
</style>
