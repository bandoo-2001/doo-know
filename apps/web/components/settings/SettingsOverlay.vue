<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { NDrawer, NModal } from 'naive-ui';
import { Button as AButton, ConfigProvider as AConfigProvider } from 'ant-design-vue';
import Icon from '../Icon.vue';

const props = withDefaults(
  defineProps<{
    show: boolean;
    title: string;
    description?: string;
    icon?: string;
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
let returnFocus: HTMLElement | null = null;
const width = computed(() => {
  const requested = props.width ?? (props.kind === 'drawer' ? 820 : 500);
  const value = typeof requested === 'number' ? requested + 'px' : requested;
  return `min(${value}, calc(100vw - ${props.kind === 'drawer' ? 0 : 24}px))`;
});
const frameProps = computed(() =>
  props.kind === 'drawer' ? { width: width.value, placement: 'right' as const } : {},
);
function popupContainer(trigger?: HTMLElement): HTMLElement {
  return trigger?.closest<HTMLElement>('.settings-overlay') || surface.value || document.body;
}
watch(
  () => props.show,
  (shown) => {
    discardOpen.value = false;
    if (shown)
      returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  },
  { immediate: true },
);
watch(
  () => props.title,
  () => {
    discardOpen.value = false;
  },
);
function close() {
  if (props.busy) return;
  if (discardOpen.value && props.dirty) {
    discardOpen.value = false;
    return;
  }
  if (props.dirty) {
    discardOpen.value = true;
    return;
  }
  discardOpen.value = false;
  emit('update:show', false);
}
function discard() {
  if (props.busy) return;
  discardOpen.value = false;
  emit('update:show', false);
}
async function entered() {
  await nextTick();
  if (!props.show || !surface.value) return;
  const field = surface.value.querySelector<HTMLElement>(
    '.settings-overlay-body input:not(:disabled):not([type="hidden"]), .settings-overlay-body textarea:not(:disabled), .settings-overlay-body select:not(:disabled)',
  );
  (field || surface.value).focus({ preventScroll: true });
}
function left() {
  // A Git workflow can change between a drawer and a modal while still open.
  if (props.show) return;
  emit('after-leave');
  returnFocus?.isConnected && returnFocus.focus({ preventScroll: true });
}
defineExpose({ close });
</script>

<template>
  <component
    :is="kind === 'drawer' ? NDrawer : NModal"
    :show="show"
    v-bind="frameProps"
    :mask-closable="!busy"
    :close-on-esc="!busy"
    :auto-focus="true"
    :trap-focus="true"
    @update:show="
      (value) => {
        if (!value) close();
      }
    "
    @after-enter="entered"
    @after-leave="left"
  >
    <section
      ref="surface"
      :class="['settings-overlay', `settings-overlay-${kind}`]"
      :style="kind === 'modal' ? { width } : undefined"
      role="dialog"
      aria-modal="true"
      :aria-label="title"
      :aria-busy="busy"
      tabindex="-1"
    >
      <header class="settings-overlay-header">
        <span v-if="icon" class="settings-overlay-icon"><Icon :name="icon" :size="21" /></span>
        <div class="settings-overlay-heading">
          <h2>{{ title }}</h2>
          <p v-if="description">{{ description }}</p>
        </div>
        <button
          type="button"
          class="settings-overlay-close"
          :aria-label="'关闭' + title"
          :disabled="busy"
          @click="close"
        >
          <Icon name="close" :size="18" />
        </button>
      </header>
      <div class="settings-workspace settings-overlay-body">
        <AConfigProvider :get-popup-container="popupContainer"><slot /></AConfigProvider>
      </div>
      <footer v-if="discardOpen || $slots.footer" class="settings-overlay-footer">
        <div v-if="discardOpen" class="settings-discard-prompt" role="alert">
          <div>
            <strong>有未保存的更改</strong>
            <p>关闭后将放弃本次输入。</p>
          </div>
          <div class="settings-discard-actions">
            <AButton :disabled="busy" @click="discardOpen = false">继续编辑</AButton
            ><AButton danger :disabled="busy" @click="discard">放弃更改</AButton>
          </div>
        </div>
        <slot v-else name="footer" :close="close" />
      </footer>
    </section>
  </component>
</template>

<style src="./settings.css"></style>
<style src="./settings-overlay.css"></style>
