<script setup lang="ts">
import type { FileOperation } from '../../shared/knowledge-contracts';
defineProps<{ operation?: FileOperation }>();
defineEmits<{ cancel: []; check: [] }>();
const labels: Record<string, string> = {
  queued: '排队中',
  running: '处理中',
  committing: '正在提交',
  succeeded: '已完成',
  failed: '处理失败',
  cancelled: '已取消',
  needs_reconciliation: '需要核对保存结果',
};
</script>
<template>
  <div v-if="operation" class="operation-status" role="status">
    <span>{{ labels[operation.status] || operation.status }}</span
    ><button v-if="['queued', 'running'].includes(operation.status)" @click="$emit('cancel')">
      取消任务</button
    ><button v-if="operation.status === 'needs_reconciliation'" @click="$emit('check')">
      核对保存结果
    </button>
  </div>
</template>
