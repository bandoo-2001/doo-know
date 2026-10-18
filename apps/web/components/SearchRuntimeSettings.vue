<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { NButton, NAlert } from 'naive-ui';
import { api } from '../api';
defineProps<{ onboarding?: boolean }>();
const state = ref<any>(),
  error = ref(''),
  busy = ref(false);
const labels: Record<string, string> = {
  queued: '等待准备',
  downloading: '下载检索包',
  verifying: '校验文件',
  creating_venv: '创建本地环境',
  installing: '安装离线依赖',
  validating_model: '验证模型',
  starting: '启动检索',
  ready: '已准备',
  failed: '准备失败',
  cancelled: '已取消',
  interrupted: '上次准备被中断',
};
async function load() {
  try {
    state.value = await api('/api/platform/search-runtime');
  } catch (e) {
    error.value = (e as Error).message;
  }
}
async function prepare() {
  busy.value = true;
  error.value = '';
  try {
    await api('/api/platform/search-runtime/prepare', 'POST', { requestId: crypto.randomUUID() });
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
async function cancel() {
  busy.value = true;
  try {
    await api('/api/platform/search-runtime/tasks/' + state.value.task.id + '/cancel', 'POST', {});
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
let timer: ReturnType<typeof setInterval>;
onMounted(() => {
  void load();
  timer = setInterval(load, 2000);
});
onUnmounted(() => clearInterval(timer));
</script>
<template>
  <section class="search-runtime-settings">
    <header class="runtime-heading">
      <span class="runtime-mark" aria-hidden="true"></span>
      <div>
        <h2>{{ onboarding ? '准备内容搜索' : '本地检索' }}</h2>
        <p class="runtime-description">
          {{
            onboarding
              ? '下载一次搜索组件，准备好后可在本机运行。准备期间仍可浏览和编辑笔记。'
              : '准备本地模型和检索环境。下载期间仍可浏览和编辑笔记。'
          }}
        </p>
      </div>
    </header>
    <NAlert v-if="error" type="error">{{ error }}</NAlert>
    <template v-if="state">
      <p v-if="onboarding && state.downloadBytes" class="runtime-note">
        需要下载约 {{ Math.ceil(state.downloadBytes / 1024 / 1024) }} MiB。未点击准备前不会下载。
      </p>
      <div v-if="!onboarding" class="runtime-components">
        <div class="runtime-component">
          <span class="component-label">文本检索</span>
          <span class="component-status" :class="{ ready: state.components.tokenizerReady }"
            ><i aria-hidden="true"></i
            >{{ state.components.tokenizerReady ? '可用' : '依赖未准备，索引任务已暂停' }}</span
          >
        </div>
        <div class="runtime-component">
          <span class="component-label">语义检索</span>
          <span class="component-status" :class="{ ready: state.components.vectorReady }"
            ><i aria-hidden="true"></i
            >{{ state.components.vectorReady ? '可用' : '暂不可用' }}</span
          >
        </div>
      </div>
      <p v-if="onboarding" class="runtime-onboarding-status" role="status">
        {{
          state.components.tokenizerReady && state.components.vectorReady
            ? '内容搜索已就绪。'
            : state.components.tokenizerReady
              ? '关键词搜索可用，按意思搜索还需要准备。'
              : '内容搜索尚未就绪，可以稍后再设置。'
        }}
      </p>
      <p v-if="state.externallyManaged" class="runtime-note">
        当前使用部署设备配置的搜索组件。实际可用情况以上方状态为准。
      </p>
      <p v-else-if="!state.distributionAvailable" class="runtime-note">
        当前暂时没有可下载的搜索组件。你可以继续使用知识库。
      </p>
      <div v-if="state.task" class="runtime-task">
        <div class="runtime-task-heading" role="status">
          <span>{{ labels[state.task.phase] || state.task.phase }}</span>
          <span v-if="state.task.phase === 'downloading'" class="runtime-bytes"
            >{{ Math.floor(state.task.completedBytes / 1024 / 1024) }} /
            {{ Math.ceil(state.task.totalBytes / 1024 / 1024) }} MiB</span
          >
        </div>
        <progress
          v-if="state.task.phase === 'downloading' && state.task.totalBytes"
          class="runtime-progress"
          :value="state.task.completedBytes"
          :max="state.task.totalBytes"
          aria-label="检索组件下载进度"
        ></progress>
        <NAlert v-if="state.task.error" type="warning"
          >{{
            onboarding
              ? '搜索组件暂时没有准备好，可以重试。已校验的下载会保留。'
              : state.task.error + '；可重新准备，已校验的下载会复用。'
          }}
          <details v-if="onboarding">
            <summary>查看详细信息</summary>
            {{ state.task.error }}
          </details></NAlert
        >
      </div>
      <div class="runtime-actions">
        <NButton
          v-if="state.task && ['queued', 'running'].includes(state.task.state)"
          :loading="busy"
          @click="cancel"
          >取消检索准备</NButton
        >
        <NButton
          v-else-if="
            !state.externallyManaged &&
            state.distributionAvailable &&
            (!state.components.tokenizerReady || !state.components.vectorReady)
          "
          :loading="busy"
          type="primary"
          @click="prepare"
          >{{ state.task ? '重新准备' : onboarding ? '下载并准备搜索' : '准备本地检索' }}</NButton
        >
        <NButton :loading="busy" @click="load">检查检索状态</NButton>
      </div>
    </template>
  </section>
</template>
<style scoped>
.search-runtime-settings {
  min-width: 0;
  margin: 24px 0;
  padding: 18px;
  border: 1px solid var(--border, #e3e6ec);
  border-radius: 8px;
  background: #fff;
  color: var(--text, #262b36);
}
.runtime-heading {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 16px;
}
.runtime-mark {
  position: relative;
  display: grid;
  flex-shrink: 0;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 8px;
  background: var(--surface, #f5f6f8);
  color: var(--blue, #4566c6);
  font-size: 26px;
  line-height: 1;
}
.runtime-mark::before {
  width: 12px;
  height: 12px;
  border: 1.5px solid currentColor;
  border-radius: 50%;
  content: '';
  transform: translate(-2px, -2px);
}
.runtime-mark::after {
  position: absolute;
  top: 22px;
  left: 21px;
  width: 6px;
  height: 1.5px;
  border-radius: 1px;
  background: currentColor;
  content: '';
  transform: rotate(45deg);
}
.runtime-heading h2 {
  margin: 0 0 5px;
  font-size: 16px;
  font-weight: 600;
}
.runtime-description {
  margin: 0;
  color: var(--muted, #7a8190);
  font-size: 13px;
  line-height: 1.65;
}
.runtime-components {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.runtime-component {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border: 1px solid var(--border, #e3e6ec);
  border-radius: 6px;
  background: var(--surface-soft, #fafbfc);
}
.component-label {
  font-size: 12px;
  color: var(--muted, #7a8190);
}
.component-status {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 13px;
  line-height: 1.5;
}
.component-status i {
  position: relative;
  top: -1px;
  width: 6px;
  height: 6px;
  flex-shrink: 0;
  border-radius: 50%;
  background: #b8bfca;
}
.component-status.ready i {
  background: var(--blue, #4566c6);
}
.runtime-note {
  margin: 12px 0;
  color: var(--muted, #7a8190);
  font-size: 12px;
  line-height: 1.65;
  overflow-wrap: anywhere;
}
.runtime-onboarding-status {
  margin: 12px 0;
  padding: 11px 13px;
  border-radius: 6px;
  background: var(--surface-soft, #fafbfc);
  font-size: 13px;
}
.runtime-task {
  margin: 12px 0;
  padding: 12px 14px;
  border: 1px solid var(--border, #e3e6ec);
  border-radius: 6px;
}
.runtime-task-heading {
  display: flex;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 6px 12px;
  font-size: 13px;
}
.runtime-bytes {
  color: var(--muted, #7a8190);
  font-variant-numeric: tabular-nums;
  font-size: 12px;
}
.runtime-progress {
  display: block;
  width: 100%;
  height: 5px;
  margin-top: 12px;
  overflow: hidden;
  border: 0;
  border-radius: 4px;
  accent-color: var(--blue, #4566c6);
  background: var(--surface, #f5f6f8);
}
.runtime-progress::-webkit-progress-bar {
  background: var(--surface, #f5f6f8);
  border-radius: 4px;
}
.runtime-progress::-webkit-progress-value {
  background: var(--blue, #4566c6);
  border-radius: 4px;
}
.runtime-progress::-moz-progress-bar {
  background: var(--blue, #4566c6);
  border-radius: 4px;
}
.runtime-task .n-alert {
  margin-top: 12px;
}
.runtime-task details {
  margin-top: 8px;
  overflow-wrap: anywhere;
  font-size: 12px;
}
.runtime-task summary {
  cursor: pointer;
}
.runtime-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 16px;
}
.search-runtime-settings > .n-alert {
  margin-bottom: 12px;
}
@media (max-width: 600px) {
  .search-runtime-settings {
    padding: 14px;
  }
  .runtime-heading {
    gap: 10px;
  }
  .runtime-components {
    grid-template-columns: minmax(0, 1fr);
  }
  .runtime-component {
    flex-direction: row;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
  }
  .component-label {
    flex-shrink: 0;
  }
  .component-status {
    justify-content: flex-end;
    text-align: right;
  }
}
</style>
