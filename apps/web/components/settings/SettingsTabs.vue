<script setup lang="ts" generic="K extends string">
import { reactive, ref, useId, watch } from 'vue';

const props = defineProps<{
  label: string;
  tabs: readonly { key: K; label: string; icon?: string }[];
  orientation?: 'horizontal' | 'vertical';
  hideNavigation?: boolean;
  panelClass?: string;
}>();
const active = defineModel<K>({ required: true });
const id = useId();
const bar = ref<HTMLElement>();
const visited = reactive(new Set<string>([active.value]));
watch(active, (value) => visited.add(value), { flush: 'sync' });

function selectTab(key: K) {
  active.value = key;
  const index = props.tabs.findIndex((tab) => tab.key === key);
  bar.value?.querySelectorAll?.<HTMLButtonElement>('[role="tab"]')[index]?.focus();
}
function navigate(event: KeyboardEvent, index: number) {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const count = props.tabs.length;
  let next: number;
  const vertical = props.orientation === 'vertical';
  if (event.key === (vertical ? 'ArrowDown' : 'ArrowRight')) next = (index + 1) % count;
  else if (event.key === (vertical ? 'ArrowUp' : 'ArrowLeft')) next = (index + count - 1) % count;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = count - 1;
  else return;
  event.preventDefault();
  selectTab(props.tabs[next].key);
}
</script>
<template>
  <div class="settings-tabs" :class="{ 'settings-tabs-vertical': orientation === 'vertical' }">
    <div
      v-if="!hideNavigation"
      ref="bar"
      class="settings-tab-bar"
      role="tablist"
      :aria-label="label"
      :aria-orientation="orientation || 'horizontal'"
    >
      <button
        v-for="(tab, index) in tabs"
        :key="tab.key"
        type="button"
        role="tab"
        :id="id + '-tab-' + tab.key"
        :aria-controls="id + '-panel-' + tab.key"
        :aria-selected="tab.key === active"
        :tabindex="tab.key === active ? 0 : -1"
        @click="selectTab(tab.key)"
        @keydown="navigate($event, index)"
      >
        <slot name="label" :tab="tab">{{ tab.label }}</slot>
      </button>
    </div>
    <section
      v-for="tab in tabs"
      :key="tab.key"
      v-show="active === tab.key"
      role="tabpanel"
      tabindex="0"
      :id="id + '-panel-' + tab.key"
      :aria-labelledby="hideNavigation ? undefined : id + '-tab-' + tab.key"
      :aria-label="hideNavigation ? tab.label : undefined"
      class="settings-tab-panel"
      :class="panelClass"
    >
      <slot v-if="visited.has(tab.key)" :name="tab.key" :tab="tab" :selectTab="selectTab">
        <slot :tab="tab" :selectTab="selectTab" />
      </slot>
    </section>
  </div>
</template>
<style scoped>
.settings-tabs,
.settings-tab-panel {
  min-width: 0;
}
.settings-tab-bar {
  display: flex;
  gap: 6px;
  margin-bottom: 14px;
  border-bottom: 1px solid var(--border);
}
.settings-tab-bar button {
  min-width: 0;
  min-height: 44px;
  padding: 6px 14px;
  font: inherit;
  font-size: 14px;
  color: var(--muted);
  background: transparent;
  border: 0;
  border-bottom: 2px solid transparent;
  cursor: pointer;
}
.settings-tab-bar button[aria-selected='true'] {
  color: var(--blue);
  border-bottom-color: currentColor;
  font-weight: 600;
}
.settings-tab-bar button:hover {
  background: var(--surface-soft);
}
.settings-tab-bar button:focus-visible,
.settings-tab-panel:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: -2px;
}
.settings-tabs-vertical {
  display: grid;
  grid-template-columns: 152px minmax(0, 1fr);
  align-items: start;
  gap: 24px;
}
.settings-tabs-vertical > .settings-tab-bar {
  grid-column: 1;
  grid-row: 1;
  display: grid;
  gap: 4px;
  margin: 0;
  border: 0;
}
.settings-tabs-vertical > .settings-tab-panel {
  grid-column: 2;
  grid-row: 1;
}
.settings-tabs-vertical > .settings-tab-bar button {
  display: flex;
  align-items: center;
  gap: 10px;
  text-align: start;
  border: 0;
  border-radius: var(--ui-radius, 8px);
}
.settings-tabs-vertical > .settings-tab-bar button[aria-selected='true'] {
  background: var(--blue-soft);
}
@media (max-width: 600px) {
  .settings-tab-bar {
    gap: 0;
  }
  .settings-tab-bar button {
    flex: 1 1 0;
    padding-inline: 2px;
    font-size: 13px;
  }
}
</style>
