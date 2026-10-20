<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import {
  Button as AButton,
  Alert as AAlert,
  Progress as AProgress,
  Spin as ASpin,
} from 'ant-design-vue';
import { api } from '../api';
defineProps<{ onboarding?: boolean }>();
const state = ref<any>(),
  error = ref(''),
  statusError = ref(''),
  busy = ref(false),
  checking = ref(false);
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
const downloadProgress = computed(() => {
  const task = state.value?.task;
  return task?.totalBytes
    ? Math.max(0, Math.min(100, (task.completedBytes / task.totalBytes) * 100))
    : 0;
});
const taskErrorDescription = computed(() => {
  switch (state.value?.task?.error) {
    case 'PREPARATION_CANCELLED':
      return '已停止准备，之后可继续。已校验的下载会保留。';
    case 'PREPARATION_INTERRUPTED':
      return '上次准备未完成，可以重新准备。已校验的下载会复用。';
    case 'PROCESS_CONTAINMENT_UNAVAILABLE':
      return '后台任务暂时无法启动，请联系部署者检查安装和系统支持。';
    default:
      return '搜索组件暂时没有准备好，可以重试。已校验的下载会保留。';
  }
});
async function load() {
  if (checking.value) return;
  checking.value = true;
  try {
    state.value = await api('/api/platform/search-runtime');
    statusError.value = '';
  } catch (e) {
    statusError.value = (e as Error).message;
  } finally {
    checking.value = false;
  }
}
async function prepare() {
  if (busy.value) return;
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
  if (busy.value || !state.value?.task) return;
  busy.value = true;
  error.value = '';
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
  timer = setInterval(() => {
    if (!busy.value) void load();
  }, 2000);
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
              : '查看关键词与语义搜索的可用情况。准备期间仍可浏览和编辑笔记。'
          }}
        </p>
      </div>
    </header>
    <AAlert v-if="error" type="error" show-icon :message="error" />
    <AAlert v-else-if="statusError" type="warning" show-icon message="暂时无法获取检索状态">
      <template #description>
        请检查连接后重试，当前笔记仍可继续使用。
        <details>
          <summary>查看详细信息</summary>
          {{ statusError }}
        </details>
      </template>
    </AAlert>
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
      <details v-if="!onboarding" class="runtime-note">
        <summary>高级运行信息</summary>
        <p>
          {{ state.externallyManaged ? '搜索组件由部署配置管理。' : '搜索组件由应用准备与管理。' }}
        </p>
        <p>
          当前安装源{{ state.distributionAvailable ? '提供' : '未提供' }}可下载的搜索组件。<template
            v-if="state.downloadBytes"
            >下载大小约 {{ Math.ceil(state.downloadBytes / 1024 / 1024) }} MiB。</template
          >
        </p>
        <p v-if="state.task">
          最近准备阶段：{{ labels[state.task.phase] || state.task.phase }}。任务编号：{{
            state.task.id
          }}
        </p>
      </details>
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
        <AProgress
          v-if="state.task.phase === 'downloading' && state.task.totalBytes"
          class="runtime-progress"
          :percent="downloadProgress"
          :show-info="false"
          size="small"
          :aria-valuenow="Math.floor(downloadProgress)"
          :aria-valuemin="0"
          :aria-valuemax="100"
          aria-label="检索组件下载进度"
        />
        <AAlert
          v-if="state.task.error"
          :type="state.task.phase === 'cancelled' ? 'info' : 'warning'"
          show-icon
          :message="taskErrorDescription"
        >
          <template v-if="state.task.phase !== 'cancelled'" #description>
            <details>
              <summary>查看详细信息</summary>
              {{ state.task.error }}
            </details>
          </template>
        </AAlert>
      </div>
    </template>
    <div v-else-if="!statusError" class="runtime-loading" role="status">
      <ASpin size="small" /><span>正在检查检索状态…</span>
    </div>
    <div class="runtime-actions">
      <AButton
        v-if="state?.task && ['queued', 'running'].includes(state.task.state)"
        :loading="busy"
        :disabled="busy || checking"
        @click="cancel"
        >取消检索准备</AButton
      >
      <AButton
        v-else-if="
          state &&
          !state.externallyManaged &&
          state.distributionAvailable &&
          (!state.components.tokenizerReady || !state.components.vectorReady)
        "
        :loading="busy"
        :disabled="busy || checking"
        type="primary"
        @click="prepare"
        >{{ state.task ? '重新准备' : onboarding ? '下载并准备搜索' : '准备本地检索' }}</AButton
      >
      <AButton :loading="checking" :disabled="busy || checking" @click="load">检查检索状态</AButton>
    </div>
  </section>
</template>
<style scoped>
.search-runtime-settings {
  min-width: 0;
  margin: 24px 0;
  padding: 18px;
  border: 1px solid var(--border, #e3e6ec);
  border-radius: 8px;
  background: var(--panel, #fff);
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
  margin-top: 8px;
}
.runtime-task .ant-alert {
  margin-top: 12px;
}
.search-runtime-settings details {
  margin-top: 8px;
  overflow-wrap: anywhere;
  font-size: 12px;
}
.search-runtime-settings summary {
  cursor: pointer;
}
.runtime-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 16px;
}
.search-runtime-settings > .ant-alert {
  margin-bottom: 12px;
}
.runtime-loading {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 0;
  color: var(--muted, #687486);
  font-size: 13px;
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
