<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { Button as AButton, Alert as AAlert } from 'ant-design-vue';
import { features, refreshFeatures } from '../features';
import GitSettings from './settings/GitSettings.vue';
import MCPSettings from './settings/MCPSettings.vue';
import SearchRuntimeSettings from './SearchRuntimeSettings.vue';
import Icon from './Icon.vue';
const expanded = ref('');
const error = ref('');
const integrations = [
  {
    id: 'mcp',
    icon: 'share',
    title: '连接 MCP 客户端',
    description: '授权 ChatGPT 等客户端查找和使用你的资料。',
    action: '设置 MCP 连接',
  },
  {
    id: 'git',
    icon: 'clock',
    title: '记录文件版本',
    description: '查看修改记录、恢复资料，并按需同步 GitHub 或 Gitee。',
    action: '设置版本记录',
  },
] as const;
async function load() {
  error.value = '';
  try {
    await refreshFeatures();
  } catch {
    error.value = '暂时无法读取功能状态，可以重试或继续设置。';
  }
}
onMounted(load);
</script>

<template>
  <div class="setup-features">
    <AAlert v-if="error" type="warning" show-icon :message="error">
      <template #action><AButton size="small" @click="load">重试</AButton></template>
    </AAlert>
    <article v-for="feature in integrations" :key="feature.id" class="feature">
      <div class="feature-main">
        <span class="feature-icon" aria-hidden="true"><Icon :name="feature.icon" /></span>
        <div>
          <h2>{{ feature.title }}</h2>
          <p>{{ feature.description }}</p>
          <span v-if="features[feature.id]" class="feature-state">{{
            features[feature.id]?.state === 'enabled' ? '已启用' : '尚未启用'
          }}</span>
        </div>
      </div>
      <AButton
        :aria-expanded="expanded === feature.id"
        :aria-controls="'setup-feature-' + feature.id"
        @click="expanded = expanded === feature.id ? '' : feature.id"
        >{{ feature.action }}</AButton
      >
      <div
        v-if="expanded === feature.id"
        :id="'setup-feature-' + feature.id"
        class="feature-config"
      >
        <MCPSettings v-if="feature.id === 'mcp'" />
        <GitSettings v-else />
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
      <p class="feature-detail">
        在部署 DooKnow 的设备上下载本地搜索组件，无需外部 API
        密钥。准备期间仍可写笔记，也可以先跳过。
      </p>
      <AButton
        :aria-expanded="expanded === 'search'"
        aria-controls="setup-feature-search"
        @click="expanded = expanded === 'search' ? '' : 'search'"
        >设置内容搜索</AButton
      >
      <details class="feature-help">
        <summary>如何开始搜索</summary>
        <ol>
          <li>点击“设置内容搜索”，先查看组件状态和下载说明。</li>
          <li>点击下载准备按钮，等待组件准备完成；可以查看进度、取消，之后再继续。</li>
          <li>显示“内容搜索已就绪”后，在工作区搜索资料；后续可在搜索设置中检查状态。</li>
        </ol>
        <p>打开说明不会开始下载，只有确认准备后才会下载组件。</p>
      </details>
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
  border: 1px solid var(--border);
  border-radius: var(--ui-radius);
  background: var(--panel);
}
.feature > .ant-btn {
  grid-column: 2;
  grid-row: 1;
  align-self: center;
}
.feature-detail,
.feature-help,
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
  border: 1px solid var(--border);
  border-radius: var(--ui-radius);
  background: var(--blue-soft);
  color: var(--blue);
  font-size: 21px;
}
h2 {
  margin: 0 0 5px;
  color: var(--text);
  font-size: 15px;
  font-weight: 600;
  line-height: 1.6;
}
p {
  margin: 0 0 8px;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.85;
}
.feature-state {
  display: inline-block;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.7;
}
.feature-detail {
  margin: 16px 0 13px;
  padding-top: 13px;
  border-top: 1px solid var(--border);
  font-size: 12px;
}
.feature-config {
  min-width: 0;
  margin-top: 18px;
  padding-top: 16px;
  border-top: 1px solid var(--border);
  overflow-wrap: anywhere;
}
.feature-help {
  margin-top: 12px;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.8;
}
.feature-help ol {
  margin: 8px 0;
  padding-left: 22px;
}
.feature-help li {
  margin: 5px 0;
  overflow-wrap: anywhere;
}
.feature-help p {
  margin: 8px 0 0;
  font-size: 12px;
}
summary {
  width: fit-content;
  cursor: pointer;
}
summary:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 3px;
}
.feature-help[open] summary {
  margin-bottom: 7px;
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
