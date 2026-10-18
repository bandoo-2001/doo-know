<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount } from 'vue';
import { Button as AButton, Popover as APopover } from 'ant-design-vue';
import { api } from '../api';
import Icon from './Icon.vue';
const emit = defineEmits<{ settings: [] }>();
const props = defineProps<{ noteId?: string }>(),
  state = ref<any>(),
  components = ref<any>(),
  error = ref(''),
  busy = ref(false),
  open = ref(false),
  trigger = ref<HTMLButtonElement>();
const summary = computed(() => {
  if (error.value) return '搜索状态需检查';
  if (!state.value) return '正在检查搜索';
  if (components.value && !components.value.tokenizerReady) return '内容搜索待准备';
  if (state.value.failed) return `搜索需处理 ${state.value.failed} 项`;
  const pending = (state.value.pending || 0) + (state.value.retrying || 0);
  if (pending) return `正在更新搜索 · ${pending}`;
  return state.value.sync.status === 'idle' ? '内容搜索已更新' : '正在同步搜索';
});
let epoch = 0;
let inFlight: { epoch: number; promise: Promise<void> } | undefined;
async function loadCurrent(current: number) {
  try {
    const result = await api(
      `/api/index/status${props.noteId ? '?noteId=' + encodeURIComponent(props.noteId) : ''}`,
    );
    if (current !== epoch) return;
    const runtime = await api<any>('/api/platform/search-runtime');
    if (current !== epoch) return;
    state.value = result;
    components.value = runtime.components;
    error.value = '';
  } catch (e) {
    if (current === epoch) error.value = (e as Error).message;
  }
}
function load() {
  if (inFlight?.epoch === epoch) return inFlight.promise;
  const current = epoch;
  const promise = loadCurrent(current).finally(() => {
    if (inFlight?.promise === promise) inFlight = undefined;
  });
  inFlight = { epoch: current, promise };
  return promise;
}
async function refresh() {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await api('/api/index/refresh', 'POST', { requestId: crypto.randomUUID() });
    // Finish an older poll before fetching the status of this refresh.
    await inFlight?.promise;
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
function closeOnEscape(event: KeyboardEvent) {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  event.stopPropagation();
  open.value = false;
  trigger.value?.focus();
}
function openSettings() {
  open.value = false;
  emit('settings');
}
watch(open, (shown) => {
  if (shown) document.addEventListener('keydown', closeOnEscape);
  else document.removeEventListener('keydown', closeOnEscape);
});
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
  document.removeEventListener('keydown', closeOnEscape);
});
</script>
<template>
  <div class="index-status" aria-label="检索状态">
    <APopover
      v-model:open="open"
      trigger="click"
      placement="topRight"
      :arrow="false"
      :overlay-style="{ zIndex: 900 }"
      :overlay-inner-style="{ padding: 0 }"
    >
      <template #content>
        <div class="index-popover" role="dialog" aria-label="检索状态详情">
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
          <button class="index-settings-link" @click="openSettings">打开搜索设置</button>
        </div>
      </template>
      <button
        ref="trigger"
        class="index-details"
        :title="summary"
        :aria-expanded="open"
        aria-haspopup="dialog"
      >
        <span :class="['index-dot', { warning: error || state?.failed }]" aria-hidden="true"></span
        ><span>{{ summary }}</span>
      </button>
    </APopover>
    <AButton
      type="text"
      shape="circle"
      size="small"
      :loading="busy"
      :disabled="busy"
      aria-label="刷新索引"
      title="刷新索引"
      @click="refresh"
      ><Icon name="refresh" :size="14"
    /></AButton>
  </div>
</template>
<style scoped>
.index-status {
  position: fixed;
  right: max(20px, env(safe-area-inset-right));
  bottom: max(20px, env(safe-area-inset-bottom));
  z-index: 15;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px 4px 12px;
  max-width: calc(100vw - 32px);
  border: 1px solid var(--border, #e3e6ec);
  border-radius: 20px;
  background: #fff;
  box-shadow: 0 2px 10px #25325408;
  color: var(--muted, #7a8190);
  font-size: 11px;
}
.index-details {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  min-height: 26px;
}
.index-details > span:last-child {
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
  width: min(280px, calc(100vw - 48px));
  box-sizing: border-box;
  max-height: max(48px, calc(100dvh - 130px));
  overflow-y: auto;
  overscroll-behavior: contain;
  overflow-wrap: anywhere;
  padding: 16px;
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
.index-status > .ant-btn {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  min-width: 26px;
  height: 26px;
  color: inherit;
}
.index-settings-link {
  display: block;
  margin-top: 12px;
  padding: 4px 0;
  border: 0;
  background: transparent;
  color: var(--blue);
  font-size: 12px;
}
</style>
