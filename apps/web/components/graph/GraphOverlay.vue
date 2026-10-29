<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import {
  Alert as AAlert,
  Button as AButton,
  ConfigProvider as AConfigProvider,
  Drawer as ADrawer,
  Modal as AModal,
  theme,
} from 'ant-design-vue';
import Icon from '../Icon.vue';

const props = withDefaults(
  defineProps<{
    show: boolean;
    title: string;
    description?: string;
    kind?: 'modal' | 'drawer';
    width?: number | string;
    busy?: boolean;
    dirty?: boolean;
  }>(),
  { kind: 'modal', busy: false, dirty: false },
);
const emit = defineEmits<{ 'update:show': [value: boolean]; 'after-leave': [] }>();
const surface = ref<HTMLElement>();
const discardOpen = ref(false);
let closeResolver: ((answer: boolean) => void) | undefined;
function finishClose(answer: boolean) {
  const resolve = closeResolver;
  closeResolver = undefined;
  discardOpen.value = false;
  resolve?.(answer);
}
const { token } = theme.useToken();
const overlayZIndex = computed(() => token.value.zIndexPopupBase + 10);
let returnFocus: HTMLElement | null = null;
const width = computed(() => {
  const requested = props.width ?? (props.kind === 'drawer' ? 380 : 620);
  const size = typeof requested === 'number' ? `${requested}px` : requested;
  return `min(${size}, ${props.kind === 'drawer' ? '100vw' : 'calc(100vw - 24px)'})`;
});
watch(
  () => props.show,
  (show) => {
    finishClose(false);
    if (show && typeof document !== 'undefined') {
      returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
  },
  { immediate: true },
);
watch(
  () => props.dirty,
  (dirty) => {
    if (!dirty) finishClose(false);
  },
);
watch(
  () => props.title,
  () => {
    finishClose(false);
  },
);
function close() {
  if (props.busy) return;
  if (props.dirty) {
    discardOpen.value = true;
    return;
  }
  finishClose(true);
  emit('update:show', false);
}
function requestClose(): Promise<boolean> {
  if (props.busy || closeResolver || discardOpen.value) return Promise.resolve(false);
  if (!props.show) return Promise.resolve(true);
  if (!props.dirty) {
    close();
    return Promise.resolve(true);
  }
  discardOpen.value = true;
  return new Promise(resolve => { closeResolver = resolve; });
}
function discard() {
  if (props.busy) return;
  finishClose(true);
  emit('update:show', false);
}
function left() {
  if (props.show) return;
  emit('after-leave');
  if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
}
// Ant Drawer 4 supplies autofocus and Escape, but does not cycle Tab focus.
function drawerRoot() {
  return surface.value?.closest<HTMLElement>('.graph-ant-drawer');
}
function trapDrawerTab(event: KeyboardEvent) {
  if (!props.show || props.kind !== 'drawer' || event.key !== 'Tab') return;
  const root = drawerRoot();
  if (!root) return;
  const fields = Array.from(
    root.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled):not([type="hidden"]), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((field) => field.getClientRects().length && field.tabIndex >= 0);
  const first = fields[0];
  const last = fields[fields.length - 1];
  if (!first) {
    event.preventDefault();
    root.focus();
  } else if (
    event.shiftKey &&
    (document.activeElement === first || !root.contains(document.activeElement))
  ) {
    event.preventDefault();
    last.focus();
  } else if (
    !event.shiftKey &&
    (document.activeElement === last || !root.contains(document.activeElement))
  ) {
    event.preventDefault();
    first.focus();
  }
}
function afterOpenChange(open: boolean) {
  if (!open) left();
  else {
    const root = drawerRoot();
    root?.setAttribute('role', 'dialog');
    root?.setAttribute('aria-modal', 'true');
    root?.setAttribute('aria-label', props.title);
    root
      ?.querySelector<HTMLElement>('.graph-overlay-close:not(:disabled)')
      ?.focus({ preventScroll: true });
  }
}
onMounted(() => document.addEventListener('keydown', trapDrawerTab, true));
onUnmounted(() => {
  finishClose(false);
  document.removeEventListener('keydown', trapDrawerTab, true);
});
function popupContainer(trigger?: HTMLElement): HTMLElement {
  return (
    trigger?.closest<HTMLElement>('.ant-modal-content, .ant-drawer-content') ??
    surface.value?.closest<HTMLElement>('.ant-modal-content, .ant-drawer-content') ??
    document.body
  );
}
defineExpose({ close, requestClose });
</script>

<template>
  <component
    :is="kind === 'drawer' ? ADrawer : AModal"
    :open="show"
    :width="width"
    :closable="false"
    :keyboard="!busy"
    :mask-closable="!busy"
    :destroy-on-close="false"
    :z-index="overlayZIndex"
    :class="kind === 'modal' ? 'graph-ant-modal' : undefined"
    :root-class-name="kind === 'drawer' ? 'graph-ant-drawer' : undefined"
    v-bind="
      kind === 'modal'
        ? {
            centered: true,
            footer: null,
            focusTriggerAfterClose: true,
            wrapProps: { 'aria-label': title, 'aria-labelledby': undefined, 'aria-modal': true },
          }
        : {
            placement: 'right',
            autoFocus: true,
            role: 'dialog',
            'aria-label': title,
            'aria-modal': true,
          }
    "
    @cancel="close"
    @close="close"
    @after-close="left"
    @after-open-change="afterOpenChange"
  >
    <template #title>
      <div class="graph-overlay-heading">
        <div class="graph-overlay-heading-copy">
          <span>{{ title }}</span>
          <p v-if="description">{{ description }}</p>
        </div>
        <AButton
          type="text"
          class="graph-overlay-close"
          :aria-label="'关闭' + title"
          :disabled="busy"
          @click="close"
          ><Icon name="close" :size="18"
        /></AButton>
      </div>
    </template>
    <AConfigProvider :get-popup-container="popupContainer">
      <div ref="surface" class="graph-overlay-body" :aria-busy="busy">
        <slot />
      </div>
      <div v-if="discardOpen" class="graph-overlay-discard">
        <AAlert
          type="warning"
          show-icon
          message="有未保存的更改"
          description="关闭后将放弃本次输入。"
        />
        <div class="graph-overlay-discard-actions">
          <AButton :disabled="busy" @click="finishClose(false)">继续编辑</AButton>
          <AButton danger :disabled="busy" @click="discard">放弃更改</AButton>
        </div>
      </div>
    </AConfigProvider>
  </component>
</template>

<style scoped>
.graph-overlay-heading {
  display: flex;
  align-items: flex-start;
  gap: 16px;
}
.graph-overlay-heading-copy {
  flex: 1;
  min-width: 0;
}
.graph-overlay-heading p {
  margin: 6px 0 0;
  font-size: 12px;
  font-weight: 400;
  line-height: 1.65;
  color: var(--muted);
}
.graph-overlay-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.graph-overlay-body {
  min-width: 0;
}
.graph-overlay-discard {
  display: grid;
  gap: 12px;
  margin-top: 20px;
}
.graph-overlay-discard-actions {
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
}
:global(.graph-ant-modal .ant-modal-content) {
  max-height: calc(100dvh - 32px);
  display: flex;
  flex-direction: column;
}
:global(.graph-ant-modal .ant-modal-header) {
  flex-shrink: 0;
}
:global(.graph-ant-modal .ant-modal-body) {
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}
:global(.graph-ant-drawer .ant-drawer-content-wrapper) {
  max-width: 100vw;
}
:global(.graph-ant-drawer .ant-drawer-header) {
  padding-top: max(20px, env(safe-area-inset-top));
}
:global(.graph-ant-drawer .ant-drawer-body) {
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding-bottom: max(24px, env(safe-area-inset-bottom));
}
@media (max-width: 600px) {
  :global(.graph-ant-modal .ant-modal-content) {
    padding: 20px 16px max(20px, env(safe-area-inset-bottom));
  }
  :global(.graph-ant-drawer .ant-drawer-header),
  :global(.graph-ant-drawer .ant-drawer-body) {
    padding-left: max(16px, env(safe-area-inset-left));
    padding-right: max(16px, env(safe-area-inset-right));
  }
}
</style>
