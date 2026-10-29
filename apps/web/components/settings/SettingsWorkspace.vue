<script setup lang="ts">
import { computed } from 'vue';
import { Button as AButton } from 'ant-design-vue';
import Icon from '../Icon.vue';
import type { SettingsSection } from '../../../../shared/settings-contracts';
import { settingsSections } from '../../settings';
import EditorSettings from './EditorSettings.vue';
import LibrarySettings from './LibrarySettings.vue';
import SearchSettings from './SearchSettings.vue';
import BackupSettings from './BackupSettings.vue';
import PluginsSettings from './PluginsSettings.vue';
import AccountSettings from './AccountSettings.vue';
import AboutSettings from './AboutSettings.vue';
import StatusSettings from './StatusSettings.vue';
const props = defineProps<{ section: SettingsSection; username: string }>();
const emit = defineEmits<{
  settings: [section: SettingsSection];
  back: [];
  logout: [];
  'open-note': [id: string];
  'preferences-changed': [];
  changed: [];
}>();
const heading = computed(
  () => settingsSections.find((entry) => entry.key === props.section) || settingsSections[0],
);
</script>
<template>
  <section class="settings-workspace" :aria-label="heading.label">
    <header class="settings-page-heading">
      <p class="settings-eyebrow">设置</p>
      <div class="settings-page-title-row">
        <h1 class="settings-title"><Icon :name="heading.icon" :size="24" />{{ heading.label }}</h1>
        <AButton class="settings-return-button" aria-label="返回笔记" @click="emit('back')"
          ><template #icon><Icon class="settings-button-icon" name="back" :size="16" /></template
          ><span class="settings-return-full">返回笔记</span
          ><span class="settings-return-short">返回</span></AButton
        >
      </div>
      <p class="settings-page-description">{{ heading.description }}</p>
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
    <StatusSettings
      v-else-if="section === 'status'"
      @settings="emit('settings', $event)"
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
