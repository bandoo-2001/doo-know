<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { Button as AButton, Alert as AAlert } from 'ant-design-vue';
import { api } from '../api';
import {
  installPlugin,
  jobPhases,
  jobPending,
  gitError,
  type PluginInstallation,
} from '../git-sync';
import { pluginRegistry, refreshPlugins } from '../plugins';
import PluginManager from './PluginManager.vue';
import SearchRuntimeSettings from './SearchRuntimeSettings.vue';
import Icon from './Icon.vue';
const expanded = ref(''),
  busy = ref(''),
  error = ref('');
const installation = ref<PluginInstallation>();
const controller = new AbortController();
let active = true;
onBeforeUnmount(() => {
  active = false;
  controller.abort();
});
const features = [
  {
    id: 'mcp',
    icon: 'share',
    title: '让 ChatGPT 使用你的资料',
    description: '连接后，可在你授权的范围内查找和阅读资料。',
    detail: '需要完成 ChatGPT 连接设置。只有你同意后，它才能访问资料。',
    technical: 'MCP',
  },
  {
    id: 'git',
    icon: 'clock',
    title: '记录文件版本',
    description: '查看修改记录，在需要时恢复以前的内容。',
    detail:
      '版本记录保存在本机，不能代替独立备份。添加后可设置署名，也可关联 GitHub／Gitee 手动同步。',
    technical: 'Git',
  },
];
function installed(id: string) {
  return pluginRegistry.value.installed.find((p) => p.id === id);
}
async function configure(id: string) {
  if (busy.value) return;
  error.value = '';
  busy.value = id;
  try {
    if (!installed(id))
      await installPlugin(id, {
        signal: controller.signal,
        onUpdate: (job) => {
          if (active) installation.value = job;
        },
      });
    if (!active) return;
    await refreshPlugins();
    expanded.value = expanded.value === id ? '' : id;
  } catch (e) {
    if (active) error.value = gitError(e);
  } finally {
    busy.value = '';
  }
}
onMounted(async () => {
  try {
    await refreshPlugins();
    if (!active) return;
    const receipt = await api<{ items: PluginInstallation[] }>(
      '/api/platform/plugin-installations',
    );
    const pending = receipt.items.find(jobPending);
    if (pending) {
      busy.value = pending.pluginId;
      await installPlugin(pending.pluginId, {
        signal: controller.signal,
        onUpdate: (job) => {
          if (active) installation.value = job;
        },
      });
      if (active) {
        await refreshPlugins();
        busy.value = '';
      }
    }
  } catch (e) {
    if (active)
      error.value = installation.value
        ? gitError(e)
        : '暂时无法读取可选功能。你可以先跳过，以后再设置。';
  } finally {
    if (active) busy.value = '';
  }
});
</script>
<template>
  <div class="setup-features">
    <AAlert v-if="error" type="warning" show-icon role="alert" :message="error" />
    <p v-if="installation" role="status">
      {{ jobPhases[installation.phase] || '准备安装' }} ·
      {{
        jobPending(installation)
          ? '任务在服务器上继续，可以稍后回来查看。'
          : installation.status === 'succeeded'
            ? '安装完成'
            : '结果待核对，请刷新后重试。'
      }}
    </p>
    <article v-for="feature in features" :key="feature.id" class="feature">
      <div class="feature-main">
        <span class="feature-icon" aria-hidden="true"><Icon :name="feature.icon" /></span>
        <div>
          <h2>{{ feature.title }}</h2>
          <p>{{ feature.description }}</p>
          <span class="feature-state">{{
            installed(feature.id)?.state === 'enabled'
              ? '已启用 · 可继续检查设置'
              : installed(feature.id)
                ? '已添加 · 还需完成设置'
                : '可选 · 随时添加'
          }}</span>
        </div>
      </div>
      <p class="feature-detail">{{ feature.detail }}</p>
      <AButton
        :loading="busy === feature.id"
        :disabled="!!busy"
        :aria-expanded="expanded === feature.id"
        :aria-controls="`setup-feature-${feature.id}`"
        @click="configure(feature.id)"
        >{{ installed(feature.id) ? '查看' : '添加'
        }}{{ feature.id === 'mcp' ? '连接设置' : '版本记录' }}</AButton
      >
      <span
        v-if="!pluginRegistry.catalog.some((p) => p.id === feature.id) && !installed(feature.id)"
        class="unavailable"
        >暂未提供此功能，可以稍后再设置</span
      >
      <details class="technical">
        <summary>了解更多</summary>
        此功能由官方 {{ feature.technical }} 插件提供。
      </details>
      <div
        v-if="expanded === feature.id"
        :id="`setup-feature-${feature.id}`"
        class="feature-config"
      >
        <PluginManager :focus-plugin="feature.id" />
      </div>
    </article>
    <article class="feature">
      <div class="feature-main">
        <span class="feature-icon" aria-hidden="true"><Icon name="search" /></span>
        <div>
          <h2>搜索资料内容</h2>
          <p>输入关键词或描述，查找知识库里的相关内容。</p>
          <span class="feature-state">可选 · 需要下载搜索组件</span>
        </div>
      </div>
      <p class="feature-detail">下载和准备期间仍可写笔记。可以查看进度，也可以稍后再准备。</p>
      <AButton
        :aria-expanded="expanded === 'search'"
        aria-controls="setup-feature-search"
        @click="expanded = expanded === 'search' ? '' : 'search'"
        >设置内容搜索</AButton
      >
      <div v-if="expanded === 'search'" id="setup-feature-search" class="feature-config">
        <SearchRuntimeSettings onboarding />
      </div>
    </article>
  </div>
</template>
<style scoped>
.setup-features {
  display: grid;
  gap: 12px;
  min-width: 0;
}
.feature {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  column-gap: 18px;
  min-width: 0;
  padding: 20px;
  border: 1px solid var(--border, #e3e6ec);
  border-radius: 8px;
  background: white;
}
.feature > .ant-btn {
  grid-column: 2;
  grid-row: 1;
  align-self: center;
}
.feature-detail,
.technical,
.unavailable,
.feature-config {
  grid-column: 1 / -1;
}
.feature-main {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}
.feature-main > div {
  min-width: 0;
}
.feature-icon {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 34px;
  height: 34px;
  border: 1px solid #e6eaf5;
  border-radius: 7px;
  background: #f3f5fc;
  color: var(--blue, #4566c6);
  font-size: 21px;
}
h2 {
  margin: 0 0 5px;
  color: var(--text, #262b36);
  font-size: 15px;
  font-weight: 600;
  line-height: 1.6;
}
p {
  margin: 0 0 8px;
  color: #6c7482;
  font-size: 13px;
  line-height: 1.85;
}
.feature-state {
  display: inline-block;
  color: var(--muted, #7a8190);
  font-size: 11px;
  line-height: 1.7;
}
.feature-detail {
  margin: 16px 0 13px;
  padding-top: 13px;
  border-top: 1px solid #edf0f4;
  font-size: 12px;
}
.feature-config {
  min-width: 0;
  margin-top: 18px;
  padding-top: 16px;
  border-top: 1px solid var(--border, #e3e6ec);
  overflow-wrap: anywhere;
}
.technical {
  margin-top: 12px;
  color: var(--muted, #7a8190);
  font-size: 12px;
  line-height: 1.8;
}
summary {
  width: fit-content;
  cursor: pointer;
}
summary:focus-visible {
  outline: 2px solid var(--focus, #4566c6);
  outline-offset: 3px;
}
.technical[open] summary {
  margin-bottom: 7px;
}
.unavailable {
  display: block;
  margin-top: 8px;
  color: var(--muted, #7a8190);
  font-size: 12px;
  line-height: 1.8;
}
@media (max-width: 600px) {
  .feature {
    grid-template-columns: minmax(0, 1fr);
    padding: 16px 14px;
  }
  .feature > .ant-btn {
    grid-column: 1;
    grid-row: auto;
    justify-self: start;
  }
  .feature-main {
    gap: 10px;
  }
  .feature-icon {
    width: 30px;
    height: 30px;
    font-size: 19px;
  }
  h2 {
    font-size: 14px;
  }
}
</style>
