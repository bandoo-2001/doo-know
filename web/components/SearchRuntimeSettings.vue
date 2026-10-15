<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { NButton, NAlert } from 'naive-ui';
import { api } from '../api';
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
    <h2>本地检索</h2>
    <p>准备本地模型和检索环境。下载期间仍可浏览和编辑笔记。</p>
    <NAlert v-if="error" type="error">{{ error }}</NAlert>
    <template v-if="state">
      <p>
        文本检索：{{
          state.components.tokenizerReady ? '可用' : '依赖未准备，索引任务已暂停'
        }}；语义检索：{{ state.components.vectorReady ? '可用' : '暂不可用' }}
      </p>
      <p v-if="state.externallyManaged">当前使用服务器部署配置中的检索环境。</p>
      <p v-else-if="!state.distributionAvailable">当前安装源未提供检索包。知识库可以继续使用。</p>
      <template v-if="state.task"
        ><p>
          {{ labels[state.task.phase] || state.task.phase }}
          <span v-if="state.task.phase === 'downloading'"
            >{{ Math.floor(state.task.completedBytes / 1024 / 1024) }} /
            {{ Math.ceil(state.task.totalBytes / 1024 / 1024) }} MiB</span
          >
        </p>
        <NAlert v-if="state.task.error" type="warning"
          >{{ state.task.error }}；可重新准备，已校验的下载会复用。</NAlert
        ></template
      >
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
        @click="prepare"
        >{{ state.task ? '重试准备本地检索' : '准备本地检索' }}</NButton
      >
      <NButton :loading="busy" @click="load">检查检索状态</NButton>
    </template>
  </section>
</template>
<style scoped>
.search-runtime-settings {
  margin: 24px 0;
}
.search-runtime-settings .n-button {
  margin: 8px 10px 0 0;
}
</style>
