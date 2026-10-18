<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { NButton, NAlert } from 'naive-ui';
import { api } from '../api';
import { pluginRegistry, refreshPlugins } from '../plugins';
import PluginManager from './PluginManager.vue';
import SearchRuntimeSettings from './SearchRuntimeSettings.vue';
const expanded = ref(''),
  busy = ref(''),
  error = ref('');
const features = [
  {
    id: 'mcp',
    icon: '↗',
    title: '让 ChatGPT 使用你的资料',
    description: '连接后，可在你授权的范围内查找和阅读资料。',
    detail: '需要完成 ChatGPT 连接设置。只有你同意后，它才能访问资料。',
    technical: 'MCP',
  },
  {
    id: 'git',
    icon: '↶',
    title: '记录文件版本',
    description: '查看修改记录，在需要时恢复以前的内容。',
    detail: '版本记录保存在本机，不能代替独立备份。添加后还需设置并初始化。',
    technical: 'Git',
  },
];
function installed(id: string) {
  return pluginRegistry.value.installed.find((p) => p.id === id);
}
async function configure(id: string) {
  error.value = '';
  busy.value = id;
  try {
    if (!installed(id)) await api(`/api/platform/plugins/${id}/install`, 'POST', {});
    await refreshPlugins();
    expanded.value = expanded.value === id ? '' : id;
  } catch {
    error.value = '暂时没能添加这个功能。你可以重试，也可以先跳过，以后在设置中添加。';
  } finally {
    busy.value = '';
  }
}
onMounted(async () => {
  try {
    await refreshPlugins();
  } catch {
    error.value = '暂时无法读取可选功能。你可以先跳过，以后再设置。';
  }
});
</script>
<template>
  <div class="setup-features">
    <NAlert v-if="error" type="warning" role="alert">{{ error }}</NAlert>
    <article v-for="feature in features" :key="feature.id" class="feature">
      <div class="feature-main">
        <span class="feature-icon" aria-hidden="true">{{ feature.icon }}</span>
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
      <NButton :loading="busy === feature.id" :disabled="!!busy" @click="configure(feature.id)"
        >{{ installed(feature.id) ? '查看' : '添加'
        }}{{ feature.id === 'mcp' ? '连接设置' : '版本记录' }}</NButton
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
      <div v-if="expanded === feature.id" class="feature-config">
        <PluginManager :focus-plugin="feature.id" />
      </div>
    </article>
    <article class="feature">
      <div class="feature-main">
        <span class="feature-icon" aria-hidden="true">⌕</span>
        <div>
          <h2>搜索资料内容</h2>
          <p>输入关键词或描述，查找知识库里的相关内容。</p>
          <span class="feature-state">可选 · 需要下载搜索组件</span>
        </div>
      </div>
      <p class="feature-detail">下载和准备期间仍可写笔记。可以查看进度，也可以稍后再准备。</p>
      <NButton @click="expanded = expanded === 'search' ? '' : 'search'">设置内容搜索</NButton>
      <div v-if="expanded === 'search'" class="feature-config">
        <SearchRuntimeSettings onboarding />
      </div>
    </article>
  </div>
</template>
<style scoped>
.feature {
  border: 1px solid #dbe4ee;
  border-radius: 12px;
  margin: 14px 0;
  padding: 20px;
}
.feature-main {
  display: flex;
  gap: 14px;
}
.feature-icon {
  width: 36px;
  height: 36px;
  background: #eff5fd;
  color: #3269af;
  border-radius: 9px;
  display: grid;
  place-items: center;
  font-size: 23px;
  flex-shrink: 0;
}
h2 {
  margin: 0 0 7px;
  font-size: 17px;
  line-height: 1.5;
}
p {
  font-size: 14px;
  color: #52657c;
  line-height: 1.8;
  margin: 0 0 8px;
}
.feature-state {
  font-size: 12px;
  color: #536d8a;
}
.feature-detail {
  margin: 14px 0;
  font-size: 13px;
}
.feature-config {
  border-top: 1px solid #e7edf4;
  margin-top: 16px;
  padding-top: 4px;
  min-width: 0;
}
.technical {
  font-size: 12px;
  color: #5a6d83;
  margin-top: 12px;
}
summary {
  cursor: pointer;
}
.unavailable {
  display: block;
  font-size: 12px;
  color: #62768c;
  margin-top: 8px;
}
@media (max-width: 600px) {
  .feature {
    padding: 16px 13px;
  }
  .feature-main {
    gap: 10px;
  }
  h2 {
    font-size: 16px;
  }
  .feature-icon {
    width: 30px;
    height: 30px;
  }
  .feature-config {
    overflow-wrap: anywhere;
  }
}
</style>
