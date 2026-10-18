<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import { NPopover } from 'naive-ui';
import Icon from './Icon.vue';
import type { SettingsSection } from '../../../shared/settings-contracts';
defineProps<{ username: string; active?: string }>();
const emit = defineEmits<{
  settings: [section?: SettingsSection];
  trash: [];
  status: [];
  logout: [];
}>();
const open = ref(false),
  trigger = ref<HTMLButtonElement>(),
  menu = ref<HTMLElement>();
watch(open, async (shown) => {
  if (shown) {
    await nextTick();
    menu.value?.querySelector('button')?.focus();
  }
});
function close() {
  open.value = false;
  trigger.value?.focus();
}
function settings(section: SettingsSection) {
  close();
  emit('settings', section);
}
</script>
<template>
  <footer class="workspace-footer sidebar-footer">
    <nav class="footer-tools" aria-label="常用工具">
      <button :aria-current="active === 'trash' ? 'page' : undefined" @click="emit('trash')">
        <Icon name="trash" :size="17" />回收站
      </button>
      <button :aria-current="active === 'settings' ? 'page' : undefined" @click="emit('settings')">
        <Icon name="settings" :size="17" />设置
      </button>
      <button @click="emit('status')" aria-label="后台状态">
        <Icon name="task" :size="17" />状态
      </button>
    </nav>
    <NPopover v-model:show="open" trigger="click" placement="top-start" :show-arrow="false">
      <template #trigger
        ><button
          ref="trigger"
          class="nav-action account-row"
          aria-label="个人账户"
          aria-haspopup="dialog"
          :aria-expanded="open"
          @keydown.esc.stop.prevent="close"
        >
          <span class="avatar" aria-hidden="true">{{
            username.slice(0, 1).toUpperCase() || '我'
          }}</span
          ><span class="account-name">{{ username || '当前账户' }}</span
          ><Icon name="chevron" :size="16" /></button
      ></template>
      <div
        ref="menu"
        class="account-popup"
        role="dialog"
        aria-label="账户菜单"
        @keydown.esc.stop.prevent="close"
      >
        <strong>{{ username || '当前账户' }}</strong>
        <button @click="settings('account')"><Icon name="lock" :size="17" />账户设置</button>
        <button @click="settings('about')"><Icon name="book" :size="17" />帮助与快捷键</button>
        <button
          class="danger-action"
          @click="
            close();
            emit('logout');
          "
        >
          <Icon name="logout" :size="17" />退出登录
        </button>
      </div>
    </NPopover>
  </footer>
</template>
