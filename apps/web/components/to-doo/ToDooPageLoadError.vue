<script setup lang="ts">
import { Alert as AAlert, Button as AButton } from 'ant-design-vue';
const emit = defineEmits<{ retry: [] }>();
</script>
<template>
  <AAlert
    type="error"
    message="暂时无法加载此功能"
    description="请检查连接后重试，其他页面的输入会继续保留。"
    show-icon
  >
    <template #action><AButton @click="emit('retry')">重试加载功能</AButton></template>
  </AAlert>
</template>
