<script setup lang="ts">
import { Button as AButton } from 'ant-design-vue';
import type { FileOperation } from '../../../shared/knowledge-contracts';
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
  <div
    v-if="operation"
    class="operation-status"
    :class="'operation-' + operation.status"
    role="status"
  >
    <span class="operation-label"
      ><i aria-hidden="true"></i>{{ labels[operation.status] || operation.status }}</span
    ><AButton
      size="small"
      v-if="['queued', 'running'].includes(operation.status)"
      @click="$emit('cancel')"
    >
      取消任务</AButton
    ><AButton
      size="small"
      v-if="operation.status === 'needs_reconciliation'"
      @click="$emit('check')"
    >
      核对保存结果
    </AButton>
  </div>
</template>
<style scoped>
.operation-status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 14px;
  min-width: 0;
  margin: 12px 0;
  padding: 10px 13px;
  border: 1px solid var(--border, #e3e6ec);
  border-radius: 6px;
  background: var(--surface-soft, #fafbfc);
  font-size: 12px;
  color: var(--muted, #7a8190);
}
.operation-label {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  line-height: 1.6;
}
.operation-label i {
  width: 6px;
  height: 6px;
  flex-shrink: 0;
  border-radius: 50%;
  background: var(--blue, #4566c6);
}
.operation-failed .operation-label i,
.operation-needs_reconciliation .operation-label i {
  background: #b27c41;
}
.operation-cancelled .operation-label i {
  background: #b7bdc7;
}
.operation-status > .ant-btn {
  margin-left: auto;
}
</style>
