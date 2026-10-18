<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Alert as AAlert, Button as AButton } from 'ant-design-vue';
import type { DraftRecord } from '../drafts';

const props = defineProps<{
  draft: DraftRecord;
  baseChanged: boolean;
  fragment?: boolean;
  busy?: boolean;
}>();
const emit = defineEmits<{ restore: []; discard: [] }>();
const copyOpen = ref(false),
  copyStatus = ref('');
const isFragment = computed(() => props.fragment || props.draft.kind === 'fragment');
const timestamp = computed(() => new Date(props.draft.updatedAt).toLocaleString('zh-CN'));
watch(
  () => props.draft.version,
  () => {
    copyOpen.value = false;
    copyStatus.value = '';
  },
);
async function copy() {
  copyOpen.value = true;
  copyStatus.value = '';
  try {
    await navigator.clipboard.writeText(props.draft.content);
    copyStatus.value = '恢复文本已复制。';
  } catch {
    copyStatus.value = '请在下方文本框中选择并复制恢复文本。';
  }
}
</script>

<template>
  <AAlert class="draft-recovery" :type="baseChanged ? 'warning' : 'info'" show-icon role="status">
    <template #message>发现未保存的本地草稿</template>
    <template #description>
      <p>
        保存在此浏览器 ·
        <time :datetime="new Date(draft.updatedAt).toISOString()">{{ timestamp }}</time>
      </p>
      <p v-if="draft.range">片段：第 {{ draft.range.startLine }}–{{ draft.range.endLine }} 行。</p>
      <p v-if="baseChanged">
        原文基准已变化。{{
          isFragment
            ? '为避免错位覆盖，此片段只能复制恢复文本。'
            : '恢复会放入编辑区，请核对后再手动保存。'
        }}
      </p>
      <p v-else>原文基准未变化。恢复只放入编辑区，手动保存后才会写入原文。</p>
      <div class="draft-recovery-actions">
        <AButton :disabled="busy || (isFragment && baseChanged)" @click="emit('restore')"
          >恢复本地草稿</AButton
        >
        <AButton :disabled="busy" @click="copy">复制恢复文本</AButton>
        <AButton :disabled="busy" @click="emit('discard')">丢弃本地草稿</AButton>
      </div>
      <div v-if="copyOpen" class="draft-recovery-copy">
        <p role="status">{{ copyStatus }}</p>
        <textarea
          aria-label="本地草稿恢复文本"
          :value="draft.content"
          readonly
          rows="5"
          @focus="($event.target as HTMLTextAreaElement).select()"
        ></textarea>
      </div>
    </template>
  </AAlert>
</template>

<style scoped>
.draft-recovery {
  margin: 12px 0;
  flex-shrink: 0;
}
.draft-recovery p {
  margin: 0 0 8px;
  font-size: 12px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.draft-recovery-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.draft-recovery-copy {
  margin-top: 12px;
}
.draft-recovery-copy textarea {
  display: block;
  width: 100%;
  box-sizing: border-box;
  resize: vertical;
  border: 1px solid var(--border, #dfe3eb);
  border-radius: 6px;
  padding: 8px;
  color: inherit;
  background: var(--surface, #fff);
  font: inherit;
}
</style>
