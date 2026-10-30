<script setup lang="ts">
import { computed, nextTick, onMounted, onScopeDispose, ref, useId, watch } from 'vue';
import Icon from './Icon.vue';
import type { WorkspaceMainMenuDefinition, WorkspaceMainMenuItem } from '../workspace-main-menu';
import '../workspace-main-menu.css';
const props = defineProps<{ definition: WorkspaceMainMenuDefinition }>();
const emit = defineEmits<{ close: [] }>();
const moreOpen = ref(false);
const compact = ref(false);
const moreTrigger = ref<HTMLButtonElement>();
const menuPanel = ref<HTMLElement>();
const tabbar = ref<HTMLElement>();
const panelId = useId();
const tabs = computed(() => props.definition.items.slice(0, 4));
const overflowSelection = computed(() =>
  [...props.definition.items.slice(4), ...props.definition.utilities].find(
    (item) => item.id === props.definition.activeId,
  ),
);
const overflowBadge = computed(() =>
  [...props.definition.items.slice(4), ...props.definition.utilities].reduce(
    (sum, item) => sum + (item.badge || 0),
    0,
  ),
);
// Keep this query aligned with workspace-tabbar.css.
let disposeMedia: (() => void) | undefined;
let navigationFocused = false;
function trackFocus(event: FocusEvent) {
  const target = event.target as Node;
  navigationFocused = !!(menuPanel.value?.contains(target) || tabbar.value?.contains(target));
}
onMounted(() => {
  document.addEventListener('focusin', trackFocus);
  const media = window.matchMedia(
    '(max-width: 720px), (max-width: 960px) and (max-height: 500px), (max-width: 1100px) and (orientation: portrait), (max-width: 1366px) and (orientation: portrait) and (pointer: coarse)',
  );
  const update = () => {
    const navigationHadFocus =
      navigationFocused ||
      menuPanel.value?.contains(document.activeElement) ||
      tabbar.value?.contains(document.activeElement);
    compact.value = media.matches;
    closeMenu();
    if (navigationHadFocus)
      void nextTick(() => {
        const navigation = media.matches ? tabbar.value : menuPanel.value;
        const buttons = Array.from(
          navigation?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [],
        ).filter((button) => button.getClientRects().length);
        const active = buttons.find((button) => button.getAttribute('aria-current') === 'page');
        (active || buttons[0])?.focus();
      });
  };
  update();
  media.addEventListener('change', update);
  disposeMedia = () => media.removeEventListener('change', update);
});
onScopeDispose(() => {
  disposeMedia?.();
  document.removeEventListener('focusin', trackFocus);
});
function closeMenu(restoreFocus = false) {
  moreOpen.value = false;
  emit('close');
  if (restoreFocus) moreTrigger.value?.focus();
}
async function toggleMenu() {
  if (moreOpen.value) return closeMenu(true);
  moreOpen.value = true;
  await nextTick();
  menuPanel.value?.querySelector<HTMLButtonElement>("[aria-current='page'], button")?.focus();
}
watch(
  () => [props.definition.id, props.definition.activeId],
  () => closeMenu(),
);
function select(item: WorkspaceMainMenuItem) {
  if (!item.disabled) {
    closeMenu();
    void props.definition.onSelect(item.id);
  }
}
function menuKeydown(event: KeyboardEvent) {
  if (!moreOpen.value) return;
  if (event.key === 'Escape') {
    event.stopPropagation();
    event.preventDefault();
    closeMenu(true);
  } else if (event.key === 'Tab') {
    const buttons = Array.from(
      menuPanel.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [],
    ).filter((button) => button.getClientRects().length);
    const first = buttons[0],
      last = buttons.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }
}
</script>
<template>
  <div class="workspace-menu-host" @keydown="menuKeydown">
    <div v-if="moreOpen" class="workspace-menu-scrim" @click="closeMenu(true)"></div>
    <footer
      :id="panelId"
      ref="menuPanel"
      class="workspace-footer sidebar-footer workspace-main-menu"
      :class="{ 'workspace-menu-open': moreOpen }"
      :data-menu-id="definition.id"
      :role="compact ? 'dialog' : undefined"
      :aria-label="compact ? '更多导航' : undefined"
      :aria-modal="compact ? true : undefined"
    >
      <div class="workspace-menu-heading">
        <strong>{{ definition.label }}</strong
        ><button
          type="button"
          class="icon-button"
          aria-label="关闭更多导航"
          @click="closeMenu(true)"
        >
          <Icon name="close" :size="20" />
        </button>
      </div>
      <div class="workspace-menu-identity">
        <slot name="identity" :close="closeMenu" :compact="compact" />
      </div>
      <nav
        class="rail-notes-navigation"
        :aria-label="definition.label === 'DooKnow' ? '工作区' : definition.label + ' 主菜单'"
      >
        <button
          v-for="item in definition.items"
          :key="item.id"
          type="button"
          :disabled="item.disabled"
          :class="{ 'rail-apps-button': item.separated }"
          :title="item.title || item.label"
          :aria-current="definition.activeId === item.id ? 'page' : undefined"
          @click="select(item)"
        >
          <slot name="icon" :item="item"><Icon :name="item.icon" :size="21" /></slot>
          <span>{{ item.label }}</span
          ><small v-if="item.badge" class="workspace-menu-badge">{{ item.badge }}</small>
        </button>
      </nav>
      <nav
        class="footer-tools"
        :aria-label="definition.label === 'DooKnow' ? '常用工具' : definition.label + ' 工具'"
      >
        <button
          v-for="item in definition.utilities"
          :key="item.id"
          type="button"
          :disabled="item.disabled"
          :title="item.title || item.label"
          :aria-current="definition.activeId === item.id ? 'page' : undefined"
          @click="select(item)"
        >
          <slot name="icon" :item="item"><Icon :name="item.icon" :size="18" /></slot
          ><span>{{ item.label }}</span>
          <small v-if="item.badge" class="workspace-menu-badge">{{ item.badge }}</small>
        </button>
      </nav>
    </footer>
    <nav ref="tabbar" class="workspace-tabbar" :aria-label="definition.label + ' 标签导航'">
      <button
        v-for="item in tabs"
        :key="item.id"
        type="button"
        :disabled="item.disabled"
        :title="item.title || item.label"
        :aria-current="definition.activeId === item.id ? 'page' : undefined"
        @click="select(item)"
      >
        <slot name="icon" :item="item"><Icon :name="item.icon" :size="22" /></slot>
        <span>{{ item.label }}</span
        ><small v-if="item.badge" class="workspace-menu-badge">{{ item.badge }}</small>
      </button>
      <button
        ref="moreTrigger"
        type="button"
        aria-label="更多导航"
        aria-haspopup="dialog"
        :aria-controls="panelId"
        :aria-expanded="moreOpen"
        :aria-current="overflowSelection ? 'page' : undefined"
        :title="overflowSelection?.label || '更多导航'"
        @click="toggleMenu"
      >
        <Icon :name="overflowSelection?.icon || 'more'" :size="22" />
        <span>{{ overflowSelection?.label || '更多' }}</span
        ><small v-if="overflowBadge" class="workspace-menu-badge">{{ overflowBadge }}</small>
      </button>
    </nav>
  </div>
</template>
