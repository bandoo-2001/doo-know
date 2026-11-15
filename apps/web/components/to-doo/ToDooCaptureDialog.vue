<script setup lang="ts">
import { ConfigProvider as AConfigProvider, Modal as AModal } from 'ant-design-vue';
import { toDooAntTheme } from '../../ant-design';
import { resolvedTheme } from '../../preferences';
import '../../to-doo-ant.css';
import '../../to-doo-tokens.css';
defineProps<{ open: boolean; busy: boolean }>();
const emit = defineEmits<{ 'update:open': [value: boolean] }>();
</script>
<template>
  <AConfigProvider :theme="toDooAntTheme(resolvedTheme)">
    <AModal :open="open" :footer="null" wrap-class-name="todo-ant-modal" title="从资料创建任务" :mask-closable="!busy" :keyboard="!busy" :closable="!busy" @update:open="!busy && emit('update:open', $event)">
      <slot />
    </AModal>
  </AConfigProvider>
</template>
