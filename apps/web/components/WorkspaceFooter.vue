<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { NPopover } from 'naive-ui';
import Icon from './Icon.vue';
import WorkspaceMainMenu from './WorkspaceMainMenu.vue';
import {
  useInjectedWorkspaceMainMenu,
  type WorkspaceMainMenuDefinition,
} from '../workspace-main-menu';
import { workspaceApps, type WorkspaceAppId } from '../app-shortcuts';
import type { SettingsSection } from '../../../shared/settings-contracts';
const props = defineProps<{
  username: string;
  active?: string;
  collection?: 'notes' | 'recent' | 'favorites';
  pinnedApps: readonly WorkspaceAppId[];
  activeApp?: WorkspaceAppId;
}>();
const shortcuts = computed(() =>
  props.pinnedApps.flatMap((id) => workspaceApps.filter((app) => app.id === id)),
);
const emit = defineEmits<{
  settings: [section?: SettingsSection];
  trash: [];
  logout: [];
  notes: [];
  apps: [];
  'open-app': [app: WorkspaceAppId];
  collection: [view: 'recent' | 'favorites'];
  'return-app': [];
}>();
const appMenu = useInjectedWorkspaceMainMenu();
const defaultMenu = computed<WorkspaceMainMenuDefinition>(() => ({
  id: 'dooknow',
  label: 'DooKnow',
  activeId:
    props.active === 'settings' || props.active === 'trash'
      ? props.active
      : props.active === 'apps'
        ? props.activeApp && props.pinnedApps.includes(props.activeApp)
          ? 'app:' + props.activeApp
          : 'apps'
        : props.collection === 'recent' || props.collection === 'favorites'
          ? props.collection
          : 'notes',
  items: [
    { id: 'notes', label: '笔记', icon: 'file' },
    { id: 'recent', label: '最近', icon: 'clock' },
    { id: 'favorites', label: '收藏', icon: 'star' },
    { id: 'apps', label: '应用', icon: 'apps', separated: true },
    ...shortcuts.value.map((app) => ({ id: 'app:' + app.id, label: app.name, icon: app.icon })),
  ],
  utilities: [
    { id: 'trash', label: '回收站', icon: 'trash' },
    { id: 'settings', label: '设置', icon: 'settings' },
  ],
  onSelect(id) {
    if (id === 'notes') emit('notes');
    else if (id === 'recent' || id === 'favorites') emit('collection', id);
    else if (id === 'apps') emit('apps');
    else if (id === 'trash') emit('trash');
    else if (id === 'settings') emit('settings');
    else if (id.startsWith('app:')) emit('open-app', id.slice(4) as WorkspaceAppId);
  },
}));
const open = ref(false),
  trigger = ref<HTMLButtonElement>(),
  menu = ref<HTMLElement>();
watch(open, async (shown) => {
  if (shown) {
    await nextTick();
    menu.value?.querySelector('button')?.focus();
  }
});
watch(appMenu, () => {
  open.value = false;
});
function close() {
  open.value = false;
  trigger.value?.focus();
}
function accountEscape(event: KeyboardEvent) {
  if (!open.value) return;
  event.stopPropagation();
  event.preventDefault();
  close();
}
function accountTab(event: KeyboardEvent) {
  const buttons = menu.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
  if (!buttons?.length) return;
  const first = buttons[0], last = buttons[buttons.length - 1];
  if (event.shiftKey ? document.activeElement === first : document.activeElement === last) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
}
function settings(section: SettingsSection) {
  close();
  emit('settings', section);
}
</script>
<template>
  <WorkspaceMainMenu :definition="appMenu || defaultMenu" @close="open = false">
    <template #identity="{ close: closeMainMenu, compact }">
      <button
        v-if="appMenu"
        type="button"
        class="workspace-menu-return"
        aria-label="返回 DooKnow"
        title="返回 DooKnow"
        @click="closeMainMenu(); emit('return-app')"
      >
        <Icon name="back" :size="22" /><span>返回</span>
      </button>
      <NPopover
        v-else
        v-model:show="open"
        trigger="click"
        :placement="compact ? 'bottom-start' : 'top-start'"
        :to="compact ? false : undefined"
        :show-arrow="false"
      >
        <template #trigger
          ><button
            ref="trigger"
            class="nav-action account-row"
            aria-label="个人账户"
            :title="username"
            aria-haspopup="dialog"
            :aria-expanded="open"
            @keydown.esc="accountEscape"
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
          @keydown.tab.stop="accountTab"
        >
          <strong>{{ username || '当前账户' }}</strong>
          <button tabindex="0" @click="settings('account')"><Icon name="lock" :size="17" />账户设置</button>
          <button tabindex="0" @click="settings('about')"><Icon name="book" :size="17" />帮助与快捷键</button>
          <button
            tabindex="0"
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
    </template>
  </WorkspaceMainMenu>
</template>
