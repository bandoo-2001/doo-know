<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from 'vue';
import { NButton } from 'naive-ui';
import { api } from '../api';
const props = defineProps<{ noteId?: string }>(),
  state = ref<any>(),
  error = ref(''),
  busy = ref(false);
let epoch = 0;
async function load() {
  const current = epoch;
  try {
    const result = await api(
      `/api/index/status${props.noteId ? '?noteId=' + encodeURIComponent(props.noteId) : ''}`,
    );
    if (current === epoch) state.value = result;
  } catch (e) {
    if (current === epoch) error.value = (e as Error).message;
  }
}
async function refresh() {
  busy.value = true;
  error.value = '';
  try {
    await api('/api/index/refresh', 'POST', { requestId: crypto.randomUUID() });
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
watch(
  () => props.noteId,
  () => {
    epoch++;
    void load();
  },
  { immediate: true },
);
const timer = setInterval(() => void load(), 10000);
onBeforeUnmount(() => {
  epoch++;
  clearInterval(timer);
});
</script>
<template>
  <div class="index-status" aria-label="检索状态">
    <span v-if="state">
      {{ state.sync.status === 'idle' ? '' : '同步中 · ' }}
      {{ state.conflicts ? `冲突 ${state.conflicts} · ` : '' }}
      {{
        state.pending || state.retrying
          ? `索引待处理 ${state.pending + state.retrying}`
          : '文本索引已更新'
      }}
      {{ state.failed ? ` · 失败 ${state.failed}` : '' }}
      <span v-if="state.document">
        · 当前笔记：文本{{
          state.document.textIndexedHash === state.document.sourceHash && state.document.sourceHash
            ? '就绪'
            : '待更新'
        }}，语义{{
          !state.activeSpaceId
            ? '未配置'
            : state.document.vectorIndexedHash === state.document.sourceHash &&
                state.document.sourceHash
              ? '就绪'
              : '待更新'
        }}</span
      >
    </span>
    <span v-if="error">{{ error }}</span>
    <NButton size="tiny" :loading="busy" @click="refresh">刷新索引</NButton>
  </div>
</template>
<style scoped>
.index-status {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  font-size: 12px;
  color: #526577;
  padding: 8px 12px;
}
</style>
