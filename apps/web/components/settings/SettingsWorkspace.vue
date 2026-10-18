<script setup lang="ts">
import { computed } from 'vue';
import { Button as AButton } from 'ant-design-vue';
import type { SettingsSection } from '../../../../shared/settings-contracts';
import EditorSettings from './EditorSettings.vue';
import LibrarySettings from './LibrarySettings.vue';
import SearchSettings from './SearchSettings.vue';
import BackupSettings from './BackupSettings.vue';
import PluginsSettings from './PluginsSettings.vue';
import AccountSettings from './AccountSettings.vue';
import AboutSettings from './AboutSettings.vue';
const props = defineProps<{ section: SettingsSection; username: string }>();
const emit = defineEmits<{
  back: [];
  logout: [];
  'open-note': [id: string];
  'preferences-changed': [];
  changed: [];
}>();
const titles: Record<SettingsSection, [string, string]> = {
  editor: ['编辑器与外观', '为这台浏览器设置适合自己的阅读与编辑方式。'],
  library: ['知识库与存储', '管理资料、导入导出与共享链接。'],
  search: ['搜索', '查看搜索能力与本地检索准备情况。'],
  backup: ['备份与恢复', '创建加密副本，并在独立位置验证恢复。'],
  plugins: ['插件', '管理扩展功能及其配置。'],
  account: ['账户与安全', '更新密码并管理已登录的设备。'],
  about: ['关于与帮助', '查看应用信息、快捷键与诊断。'],
};
const heading = computed(() => titles[props.section]);
</script>
<template>
  <section class="settings-workspace" :aria-label="heading[0]">
    <header class="settings-page-heading">
      <div>
        <p class="settings-eyebrow">设置</p>
        <h1>{{ heading[0] }}</h1>
        <p>{{ heading[1] }}</p>
      </div>
      <AButton @click="emit('back')">返回笔记</AButton>
    </header>
    <EditorSettings
      v-if="section === 'editor'"
      @preferences-changed="emit('preferences-changed')"
    />
    <LibrarySettings
      v-else-if="section === 'library'"
      @open-note="emit('open-note', $event)"
      @changed="emit('changed')"
    />
    <SearchSettings v-else-if="section === 'search'" />
    <BackupSettings v-else-if="section === 'backup'" @open-note="emit('open-note', $event)" />
    <PluginsSettings v-else-if="section === 'plugins'" />
    <AccountSettings
      v-else-if="section === 'account'"
      :username="username"
      @logout="emit('logout')"
    />
    <AboutSettings v-else-if="section === 'about'" />
  </section>
</template>
<style src="./settings.css"></style>
