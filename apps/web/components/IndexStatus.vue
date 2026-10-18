<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount } from 'vue';
import { NButton } from 'naive-ui';
import { api } from '../api';
import Icon from './Icon.vue';
const props = defineProps<{ noteId?: string }>(),
  state = ref<any>(),
  components = ref<any>(),
  error = ref(''),
  busy = ref(false);
const summary = computed(() => {
  if (error.value) return '检索状态需检查';
  if (!state.value) return '正在检查索引';
  if (components.value && !components.value.tokenizerReady) return '索引依赖未就绪';
  if (state.value.failed) return `索引任务失败 ${state.value.failed}`;
  const pending = (state.value.pending || 0) + (state.value.retrying || 0);
  if (pending) return `索引待处理 ${pending}`;
  return state.value.sync.status === 'idle' ? '文本索引已更新' : '索引同步中';
});
let epoch = 0;
async function load() {
  const current = epoch;
  try {
    const result = await api(
      `/api/index/status${props.noteId ? '?noteId=' + encodeURIComponent(props.noteId) : ''}`,
    );
    if (current === epoch) state.value = result;
    const runtime = await api<any>('/api/platform/search-runtime');
    if (current === epoch) components.value = runtime.components;
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
    <details class="index-details">
      <summary :title="summary">
        <span :class="['index-dot', { warning: error || state?.failed }]" aria-hidden="true"></span
        ><span>{{ summary }}</span>
      </summary>
      <div class="index-popover">
        <strong>检索状态</strong>
        <p v-if="state">
          同步：{{ state.sync.status === 'idle' ? '已完成' : '同步中' }}<br />文本检索：{{
            components && !components.tokenizerReady ? '依赖未就绪，索引任务已暂停' : '可用'
          }}<br />待处理 {{ (state.pending || 0) + (state.retrying || 0) }} · 失败
          {{ state.failed || 0 }} · 冲突 {{ state.conflicts || 0 }}
        </p>
        <p v-if="state?.document">
          当前笔记：文本{{
            state.document.textIndexedHash === state.document.sourceHash &&
            state.document.sourceHash
              ? '就绪'
              : '待更新'
          }}，语义{{
            !state.activeSpaceId
              ? '未配置'
              : state.document.vectorIndexedHash === state.document.sourceHash &&
                  state.document.sourceHash
                ? '就绪'
                : '待更新'
          }}
        </p>
        <p v-if="error" role="alert">{{ error }}</p>
        <small>内容搜索的准备与配置可在个人设置中查看。</small>
      </div>
    </details>
    <NButton
      quaternary
      circle
      size="tiny"
      :loading="busy"
      aria-label="刷新索引"
      title="刷新索引"
      @click="refresh"
      ><Icon name="refresh" :size="14"
    /></NButton>
  </div>
</template>
<style scoped>
.index-status {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 9px 8px 0;
  color: var(--muted, #7a8190);
  font-size: 10px;
}
.index-details {
  min-width: 0;
}
summary {
  display: flex;
  align-items: center;
  gap: 7px;
  cursor: pointer;
  list-style: none;
  min-height: 26px;
}
summary::-webkit-details-marker {
  display: none;
}
summary > span:last-child {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.index-dot {
  height: 5px;
  width: 5px;
  border-radius: 50%;
  background: #66a18b;
  flex-shrink: 0;
}
.index-dot.warning {
  background: #b6925f;
}
.index-popover {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 0;
  width: min(242px, 100%);
  padding: 16px;
  border: 1px solid var(--border, #e3e6ec);
  background: #fff;
  border-radius: 8px;
  box-shadow: 0 8px 28px #25325412;
  z-index: 12;
  font-size: 12px;
  color: #6f7b90;
  line-height: 1.8;
}
.index-popover strong {
  color: #46516a;
  font-size: 12px;
}
.index-popover p {
  margin: 10px 0;
}
.index-popover small {
  font-size: 10px;
  color: #959dae;
}
.index-status > .n-button {
  flex-shrink: 0;
}
@media (max-height: 540px) {
  .index-status {
    align-items: flex-start;
  }
  .index-details {
    flex: 1;
  }
  .index-popover {
    position: static;
    width: auto;
    margin-top: 8px;
  }
}
</style>
