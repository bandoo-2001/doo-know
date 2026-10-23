<script setup lang="ts">
import { Modal as AModal } from 'ant-design-vue';
import type { DiagramSaveNeed } from '../../../shared/diagram-portability';

const props = defineProps<{ needs: readonly DiagramSaveNeed[]; busy: boolean; error?: string }>();
const emit = defineEmits<{ generate: []; 'source-only': []; close: [] }>();
const kinds = { svg: 'SVG 图形', mermaid: 'Mermaid 流程图', excalidraw: 'Excalidraw 白板' };
const reasons = { new: '新增图形', changed: '源码已更改', stale: '预览已过期' };
function generate() {
  if (!props.busy) emit('generate');
}
function sourceOnly() {
  if (!props.busy) emit('source-only');
}
function close() {
  if (!props.busy) emit('close');
}
</script>

<template>
  <AModal
    :open="true"
    title="保存图形预览"
    :width="560"
    :footer="null"
    :closable="!busy"
    :mask-closable="!busy"
    :keyboard="!busy"
    @cancel="close"
  >
    <div class="diagram-save-dialog">
      <p>这些图形还没有与当前源码对应的通用预览。生成预览后，普通 Markdown 阅读器也能查看图形。</p>
      <ul class="diagram-save-needs">
        <li v-for="need in needs" :key="need.from">
          <strong>{{ kinds[need.kind] }}</strong>
          <span>第 {{ need.line }} 行 · {{ reasons[need.reason] }}</span>
        </li>
      </ul>
      <p class="diagram-save-source-hint">
        仅保存源码会移除这些图形原有的自动预览，保留源码和附件文件；普通阅读器可能只显示代码或白板引用。
      </p>
      <p v-if="error" class="diagram-save-error" role="alert">
        {{ error }}<br />源码和草稿已保留，可以重试生成，也可以仅保存源码。
      </p>
      <p v-if="busy" class="diagram-save-progress" role="status">正在生成预览，请稍候…</p>
      <div class="diagram-save-actions">
        <button type="button" class="btn" :disabled="busy" @click="close">取消</button>
        <button type="button" class="btn" :disabled="busy" @click="sourceOnly">仅保存源码</button>
        <button type="button" class="btn primary" :disabled="busy" @click="generate">
          生成预览并保存
        </button>
      </div>
    </div>
  </AModal>
</template>

<style scoped>
.diagram-save-dialog {
  color: var(--text);
}
.diagram-save-dialog p {
  margin: 0 0 14px;
  line-height: 1.7;
}
.diagram-save-needs {
  max-height: 30vh;
  overflow-y: auto;
  margin: 0 0 14px;
  padding: 0;
  list-style: none;
}
.diagram-save-needs li {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 0;
  border-bottom: 1px solid var(--border);
}
.diagram-save-needs span,
.diagram-save-source-hint,
.diagram-save-progress {
  color: var(--muted);
  font-size: 13px;
}
.diagram-save-error {
  color: var(--danger, #dc2626);
}
.diagram-save-actions {
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 18px;
}
@media (max-width: 480px) {
  .diagram-save-needs li {
    align-items: flex-start;
    flex-direction: column;
    gap: 2px;
  }
}
</style>
